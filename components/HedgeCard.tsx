"use client";

import { useState } from "react";
import { Card } from "./ui";
import { MiniStat } from "./stats";
import { arbStakes, hedgeStake } from "@/lib/tools";
import { krFmt, pctFmt, fmtOdds } from "@/lib/format";

const num = (v: string) => parseFloat(v.replace(",", "."));

// Hedge & surebet (bettingskolan kap. 10): arb när Σ 1/odds < 1; insatser
// proportionella mot 1/odds ger samma utbetalning oavsett utfall.
export function HedgeCard() {
  const [mode, setMode] = useState<"arb" | "hedge">("arb");

  // Surebet
  const [oddsA, setOddsA] = useState("");
  const [oddsB, setOddsB] = useState("");
  const [oddsC, setOddsC] = useState("");
  const [budget, setBudget] = useState("1000");

  // Hedge
  const [stake, setStake] = useState("100");
  const [myOdds, setMyOdds] = useState("");
  const [oppOdds, setOppOdds] = useState("");
  const [cashout, setCashout] = useState("");

  const arbOdds = [num(oddsA), num(oddsB), ...(oddsC.trim() === "" ? [] : [num(oddsC)])];
  const arb = arbOdds.every((o) => o > 1) ? arbStakes(arbOdds, num(budget)) : null;

  const h = hedgeStake(num(stake), num(myOdds), num(oppOdds));
  const co = cashout.trim() === "" ? null : num(cashout);
  const hedgeVsCashout = h != null && co != null && co >= 0 ? h.lockedReturn - co : null;

  const labels = ["A", "B", "C"];

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Hedge &amp; surebet</span>
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Lås vinsten över flera bookies</span>
      </div>

      <div className="ap-seg2" style={{ marginTop: 14, maxWidth: 340 }}>
        <button className={mode === "arb" ? "is-active" : ""} onClick={() => setMode("arb")}>Surebet</button>
        <button className={mode === "hedge" ? "is-active" : ""} onClick={() => setMode("hedge")}>Hedga öppet spel</button>
      </div>

      {mode === "arb" ? (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
            <div className="ap-field" style={{ width: 100 }}>
              <label>Odds utfall A</label>
              <input className="ap-input ap-num" inputMode="decimal" value={oddsA} placeholder="2.10" onChange={(e) => setOddsA(e.target.value)} />
            </div>
            <div className="ap-field" style={{ width: 100 }}>
              <label>Odds utfall B</label>
              <input className="ap-input ap-num" inputMode="decimal" value={oddsB} placeholder="2.10" onChange={(e) => setOddsB(e.target.value)} />
            </div>
            <div className="ap-field" style={{ width: 110 }}>
              <label>Utfall C (valfri)</label>
              <input className="ap-input ap-num" inputMode="decimal" value={oddsC} placeholder="—" onChange={(e) => setOddsC(e.target.value)} />
            </div>
            <div className="ap-field" style={{ width: 110 }}>
              <label>Budget (kr)</label>
              <input className="ap-input ap-num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
          </div>

          {arb == null ? (
            <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 14 }}>
              Fyll i bästa odds per utfall (från olika bookies) och din budget.
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 14 }}>
                <MiniStat
                  label="Implicit summa"
                  value={pctFmt(arb.impliedSum * 100)}
                  tone={arb.isArb ? "pos" : "neg"}
                />
                <MiniStat label="Arb-marginal" value={pctFmt(arb.arbPct * 100, true)} tone={arb.isArb ? "pos" : "neg"} />
                <MiniStat label="Utbetalning" value={krFmt(arb.payout)} />
                <MiniStat label="Låst resultat" value={krFmt(arb.profit, true)} tone={arb.profit >= 0 ? "pos" : "neg"} />
              </div>
              <div style={{ fontSize: 13, marginTop: 14, lineHeight: 1.6 }}>
                {arb.stakes.map((st, i) => (
                  <div key={i}>
                    Lägg <strong className="ap-num">{krFmt(st)}</strong> på utfall {labels[i]} @{" "}
                    <span className="ap-num">{fmtOdds(arbOdds[i])}</span>
                  </div>
                ))}
                <div className={"ap-num " + (arb.isArb ? "pos" : "neg")} style={{ marginTop: 8, fontSize: 14, fontWeight: 700 }}>
                  {arb.isArb
                    ? "✓ Surebet — samma utbetalning oavsett utfall"
                    : `✗ Ingen arb · ${pctFmt(arb.impliedSum * 100)} implicit`}
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
            <div className="ap-field" style={{ width: 100 }}>
              <label>Din insats (kr)</label>
              <input className="ap-input ap-num" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
            </div>
            <div className="ap-field" style={{ width: 96 }}>
              <label>Ditt odds</label>
              <input className="ap-input ap-num" inputMode="decimal" value={myOdds} placeholder="2.50" onChange={(e) => setMyOdds(e.target.value)} />
            </div>
            <div className="ap-field" style={{ width: 130 }}>
              <label>Motsatt odds nu</label>
              <input className="ap-input ap-num" inputMode="decimal" value={oppOdds} placeholder="1.60" onChange={(e) => setOppOdds(e.target.value)} />
            </div>
            <div className="ap-field" style={{ width: 150 }}>
              <label>Cashout-bud (valfri)</label>
              <input className="ap-input ap-num" inputMode="decimal" value={cashout} placeholder="—" onChange={(e) => setCashout(e.target.value)} />
            </div>
          </div>

          {h == null ? (
            <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 14 }}>
              Fyll i ditt öppna spel och det motsatta oddset (hos valfri bookie).
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 14 }}>
                <MiniStat label="Lägg på motsatt sida" value={krFmt(h.hedgeStake)} />
                <MiniStat label="Låst från nu" value={krFmt(h.lockedReturn)} />
                <MiniStat
                  label="Netto hela spelet"
                  value={krFmt(h.lockedProfit, true)}
                  tone={h.lockedProfit >= 0 ? "pos" : "neg"}
                />
                {hedgeVsCashout != null && (
                  <MiniStat
                    label="Hedge vs cashout"
                    value={krFmt(hedgeVsCashout, true)}
                    tone={hedgeVsCashout >= 0 ? "pos" : "neg"}
                  />
                )}
              </div>
              {hedgeVsCashout != null && (
                <div className="ap-num pos" style={{ marginTop: 14, fontSize: 14, fontWeight: 700 }}>
                  {hedgeVsCashout >= 0
                    ? `→ Hedga · ${krFmt(hedgeVsCashout, true)} vs cashout`
                    : `→ Ta cashouten · ${krFmt(-hedgeVsCashout, true)} vs hedge`}
                </div>
              )}
            </>
          )}
        </>
      )}

      <details className="ap-fine">
        <summary>Bra att veta</summary>
        Surebets kräver snabbhet — oddsen korrigeras fort och bolag kan limitera konton som arbar systematiskt.
        Marginalerna är ofta små (&lt;5 %), så räkna alltid innan du låser.
      </details>
    </Card>
  );
}
