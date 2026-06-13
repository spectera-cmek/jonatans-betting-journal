"use client";

import { useState } from "react";
import { Card } from "./ui";
import { kellyAdvice, impliedProb } from "@/lib/staking";
import { uFmt, krFmt, pctFmt } from "@/lib/format";

// Self-contained Kelly stake calculator. Bankroll prefilled from the caller
// (starting bankroll + realised P/L) but fully editable.
export function KellyCard({
  defaultBankrollUnits,
  unit,
}: {
  defaultBankrollUnits: number;
  unit: number;
}) {
  const [odds, setOdds] = useState("2.00");
  const [winPct, setWinPct] = useState("55");
  const [bankroll, setBankroll] = useState(String(Math.max(1, Math.round(defaultBankrollUnits))));

  const o = parseFloat(odds.replace(",", "."));
  const p = parseFloat(winPct.replace(",", ".")) / 100;
  const bank = parseFloat(bankroll.replace(",", "."));
  const valid = o > 1 && p > 0 && p < 1 && bank > 0;
  const a = valid ? kellyAdvice(o, p, bank) : null;
  const implied = o > 1 ? impliedProb(o) : null;

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Insatskalkylator (Kelly)</span>
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Hur mycket säger Kelly att du ska satsa?</span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
        <div className="ap-field" style={{ width: 96 }}>
          <label>Odds</label>
          <input className="ap-input ap-num" inputMode="decimal" value={odds} onChange={(e) => setOdds(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 130 }}>
          <label>Din vinstchans (%)</label>
          <input className="ap-input ap-num" inputMode="decimal" value={winPct} onChange={(e) => setWinPct(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 120 }}>
          <label>Bankrulle (U)</label>
          <input className="ap-input ap-num" inputMode="decimal" value={bankroll} onChange={(e) => setBankroll(e.target.value)} />
        </div>
      </div>

      {implied != null && (
        <div style={{ fontSize: 12, color: "var(--dim2)", marginTop: 10 }}>
          Oddset prissätter {pctFmt(implied * 100)} vinstchans — du tror{" "}
          {valid ? (
            <em className={p > implied ? "pos" : "neg"} style={{ fontStyle: "normal", fontWeight: 600 }}>
              {pctFmt(p * 100)}
            </em>
          ) : (
            "—"
          )}
          {valid && (p > implied ? " → du har en edge." : " → ingen edge enligt din egen skattning.")}
        </div>
      )}

      {a == null ? (
        <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 14 }}>
          Fyll i odds (&gt;1), vinstchans (0–100 %) och bankrulle.
        </div>
      ) : !a.hasEdge ? (
        <div
          style={{
            marginTop: 14,
            borderRadius: 10,
            padding: "12px 14px",
            background: "var(--red-soft)",
            border: "1px solid var(--red)",
            color: "var(--red)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          Ingen edge vid dessa odds och din skattade vinstchans — Kelly säger: <strong>lägg inget</strong>.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 16 }}>
            <KellyTile label="½ Kelly (rek.)" frac={a.half} units={a.halfUnits} unit={unit} highlight />
            <KellyTile label="¼ Kelly" frac={a.quarter} units={a.quarterUnits} unit={unit} />
            <KellyTile label="Full Kelly" frac={a.full} units={a.fullUnits} unit={unit} />
            <div style={{ background: "var(--card2)", borderRadius: 12, padding: "12px 14px" }}>
              <div className="ap-label">Edge (EV)</div>
              <div className="ap-num pos" style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>{pctFmt(a.edge * 100, true)}</div>
            </div>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--dim2)", lineHeight: 1.55, marginTop: 14, marginBottom: 0 }}>
            Full Kelly maximerar tillväxt men svänger hårt — de flesta proffs spelar ¼–½ Kelly för lugnare
            bankrulle. Siffrorna förutsätter att din vinstchans stämmer; överskatta den och Kelly blir för aggressiv.
          </p>
        </>
      )}
    </Card>
  );
}

function KellyTile({
  label,
  frac,
  units,
  unit,
  highlight,
}: {
  label: string;
  frac: number;
  units: number;
  unit: number;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        background: highlight ? "var(--acc-soft)" : "var(--card2)",
        borderRadius: 12,
        padding: "12px 14px",
      }}
    >
      <div className="ap-label">{label}</div>
      <div className="ap-num" style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>
        {uFmt(units)}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 3 }}>
        {pctFmt(frac * 100)} · {krFmt(units * unit)}
      </div>
    </div>
  );
}
