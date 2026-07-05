"use client";

import { useState } from "react";
import { Card } from "./ui";
import { MiniStat } from "./stats";
import { cashoutAdvice } from "@/lib/tools";
import { devigOneSided } from "@/lib/fairOdds";
import { krFmt, pctFmt, fmtOdds } from "@/lib/format";

const num = (v: string) => parseFloat(v.replace(",", "."));

// Cashout-kollen (bettingskolan kap. 12): fair cashout = potentiell
// utbetalning × chansen just nu; bookien skaver normalt upp till ~5%.
export function CashoutCard() {
  const [stake, setStake] = useState("100");
  const [odds, setOdds] = useState("");
  const [mode, setMode] = useState<"live" | "own">("live");
  const [liveOdds, setLiveOdds] = useState("");
  const [liveMargin, setLiveMargin] = useState("6");
  const [ownPct, setOwnPct] = useState("");
  const [offered, setOffered] = useState("");

  const s = num(stake);
  const o = num(odds);
  const payout = s > 0 && o > 1 ? s * o : null;

  const pNow =
    mode === "live"
      ? devigOneSided(num(liveOdds), num(liveMargin))?.p ?? null
      : num(ownPct) > 0 && num(ownPct) < 100
        ? num(ownPct) / 100
        : null;

  const off = num(offered);
  const a = payout != null && pNow != null && off >= 0 ? cashoutAdvice(payout, pNow, off) : null;

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Cashout-kollen</span>
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Vad är ditt öppna spel värt — och vad skaver bookien?</span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
        <div className="ap-field" style={{ width: 100 }}>
          <label>Insats (kr)</label>
          <input className="ap-input ap-num" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 96 }}>
          <label>Ditt odds</label>
          <input className="ap-input ap-num" inputMode="decimal" value={odds} placeholder="2.50" onChange={(e) => setOdds(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 200 }}>
          <label>Chansen just nu</label>
          <div className="ap-seg2">
            <button className={mode === "live" ? "is-active" : ""} onClick={() => setMode("live")}>Live-odds</button>
            <button className={mode === "own" ? "is-active" : ""} onClick={() => setMode("own")}>Egen chans</button>
          </div>
        </div>
        {mode === "live" ? (
          <>
            <div className="ap-field" style={{ width: 100 }}>
              <label>Live-odds</label>
              <input className="ap-input ap-num" inputMode="decimal" value={liveOdds} placeholder="1.15" onChange={(e) => setLiveOdds(e.target.value)} />
            </div>
            <div className="ap-field" style={{ width: 110 }}>
              <label>Marginal %</label>
              <input className="ap-input ap-num" inputMode="decimal" value={liveMargin} onChange={(e) => setLiveMargin(e.target.value)} />
            </div>
          </>
        ) : (
          <div className="ap-field" style={{ width: 110 }}>
            <label>Din chans %</label>
            <input className="ap-input ap-num" inputMode="decimal" value={ownPct} placeholder="87" onChange={(e) => setOwnPct(e.target.value)} />
          </div>
        )}
        <div className="ap-field" style={{ width: 130 }}>
          <label>Erbjuden cashout</label>
          <input className="ap-input ap-num" inputMode="decimal" value={offered} placeholder="217" onChange={(e) => setOffered(e.target.value)} />
        </div>
      </div>

      {payout != null && (
        <div style={{ fontSize: 12, color: "var(--dim2)", marginTop: 10 }}>
          Potentiell utbetalning <span className="ap-num" style={{ color: "var(--txt)" }}>{krFmt(payout)}</span>
          {" "}({fmtOdds(o)} × {krFmt(s)}){pNow != null && (
            <> · chans just nu <span className="ap-num" style={{ color: "var(--txt)" }}>{pctFmt(pNow * 100)}</span></>
          )}
        </div>
      )}

      {a == null ? (
        <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 14 }}>
          Fyll i spelet, läget just nu och det erbjudna cashout-beloppet.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 14 }}>
            <MiniStat label="Fair cashout" value={krFmt(a.fairCashout)} />
            <MiniStat label="Bookien skaver" value={pctFmt(a.shave * 100)} tone={a.shave > 0.005 ? "neg" : "pos"} />
            <MiniStat label="EV hålla vs sälja" value={krFmt(a.evDiff, true)} tone={a.evDiff >= 0 ? "pos" : "neg"} />
            <MiniStat label="Break-even-chans" value={pctFmt(a.breakEvenProb * 100)} />
          </div>
          <div style={{ fontSize: 13, marginTop: 14, lineHeight: 1.5 }}>
            {a.evDiff > 0 ? (
              <>
                Att <strong>hålla</strong> är värt <strong className="ap-num pos">{krFmt(a.evDiff, true)}</strong> mer i EV än
                erbjudandet. Sälj bara om du behöver riskminskningen — eller kolla om en hedge hos annan bookie betalar bättre.
              </>
            ) : (
              <>
                Erbjudandet ligger <strong className="ap-num pos">{krFmt(-a.evDiff)}</strong> över fair värde — ovanligt
                generöst, cashout är +EV här.
              </>
            )}
          </div>
        </>
      )}

      <p style={{ fontSize: 11.5, color: "var(--dim2)", lineHeight: 1.55, marginTop: 14, marginBottom: 0 }}>
        Fair cashout = potentiell utbetalning ÷ live-odds (de-viggat). Bookies tar normalt upp till ~5 % på cashout —
        break-even-chansen visar hur säker vinsten måste vara för att erbjudandet ska matcha att hålla.
      </p>
    </Card>
  );
}
