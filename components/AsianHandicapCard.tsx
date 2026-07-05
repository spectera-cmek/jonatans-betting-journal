"use client";

import { useState } from "react";
import { Card } from "./ui";
import { ahOutcome, ahProfit, type AhOutcome } from "@/lib/tools";
import { devigProportional } from "@/lib/fairOdds";
import { krFmt, pctFmt, fmtOdds } from "@/lib/format";

const num = (v: string) => parseFloat(v.replace(",", "."));

// Every quarter step from −2.00 to +2.00.
const LINES = Array.from({ length: 17 }, (_, i) => (i - 8) * 0.25);
const MARGINS = [3, 2, 1, 0, -1, -2, -3];

const OUTCOME_LABEL: Record<AhOutcome, string> = {
  win: "Vinst",
  half_win: "Halv vinst",
  push: "Pengarna tillbaka",
  half_loss: "Halv förlust",
  loss: "Förlust",
};

function lineLabel(l: number): string {
  const s = l.toFixed(2).replace(".", ",").replace(/,?0+$/, "").replace(/,$/, "");
  return l > 0 ? `+${s}` : s === "0" ? "0" : `−${s.replace("-", "")}`;
}

function marginLabel(m: number): string {
  if (m > 0) return `Vinner med ${m}${m === 3 ? "+" : ""}`;
  if (m < 0) return `Förlorar med ${-m}${m === -3 ? "+" : ""}`;
  return "Oavgjort";
}

// Asian handicap-hjälpen (bettingskolan kap. 9): kvartslinjer delar insatsen
// på de två närmaste linjerna — utfallsmatrisen visar exakt vad som händer.
export function AsianHandicapCard() {
  const [line, setLine] = useState("-0.75");
  const [odds, setOdds] = useState("1.95");
  const [stake, setStake] = useState("100");
  const [oppOdds, setOppOdds] = useState("");

  const L = num(line);
  const o = num(odds);
  const s = num(stake);
  const valid = Number.isFinite(L) && o > 1 && s > 0;

  const devig = oppOdds.trim() === "" ? null : devigProportional(o, [num(oppOdds)]);

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Asian handicap-hjälpen</span>
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Vad händer med insatsen vid varje slutresultat?</span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
        <div className="ap-field" style={{ width: 110 }}>
          <label>Din linje</label>
          <div className="ap-select">
            <select value={line} onChange={(e) => setLine(e.target.value)}>
              {LINES.map((l) => (
                <option key={l} value={String(l)}>
                  {lineLabel(l)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="ap-field" style={{ width: 96 }}>
          <label>Odds</label>
          <input className="ap-input ap-num" inputMode="decimal" value={odds} onChange={(e) => setOdds(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 100 }}>
          <label>Insats (kr)</label>
          <input className="ap-input ap-num" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 150 }}>
          <label>Motsatt AH-odds (valfri)</label>
          <input className="ap-input ap-num" inputMode="decimal" value={oppOdds} placeholder="—" onChange={(e) => setOppOdds(e.target.value)} />
        </div>
      </div>

      {devig && (
        <div style={{ fontSize: 12, color: "var(--dim2)", marginTop: 10 }}>
          Fair sannolikhet{" "}
          <strong className="ap-num" style={{ color: "var(--txt)" }}>{pctFmt(devig.p * 100)}</strong> · fair odds{" "}
          <span className="ap-num">{fmtOdds(1 / devig.p)}</span> · marginal{" "}
          <span className="ap-num">{pctFmt(devig.overround * 100)}</span>
        </div>
      )}

      {!valid ? (
        <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 14 }}>Fyll i linje, odds (&gt; 1) och insats.</div>
      ) : (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {MARGINS.map((m) => {
            const out = ahOutcome(L, m)!;
            const pl = ahProfit(s, o, out);
            const tone = pl > 0 ? "pos" : pl < 0 ? "neg" : "";
            return (
              <div
                key={m}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--card2)",
                  borderRadius: 10,
                  padding: "9px 12px",
                  fontSize: 13,
                }}
              >
                <span style={{ flex: "1 1 110px", minWidth: 0 }}>{marginLabel(m)}</span>
                <span style={{ flex: "1 1 110px", color: tone === "" ? "var(--dim)" : undefined }} className={tone}>
                  {OUTCOME_LABEL[out]}
                </span>
                <strong className={"ap-num " + tone} style={{ minWidth: 82, textAlign: "right" }}>
                  {krFmt(pl, true)}
                </strong>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontSize: 11.5, color: "var(--dim2)", lineHeight: 1.55, marginTop: 14, marginBottom: 0 }}>
        Kvartslinjer (±0,25 / ±0,75) delar insatsen på de två närmaste linjerna — därav halva vinster och förluster.
        AH har oftast lägre marginal än 1X2, så samma spelidé betalar ofta bättre här. Fyll i motsatta sidans odds för
        att se fair sannolikhet.
      </p>
    </Card>
  );
}
