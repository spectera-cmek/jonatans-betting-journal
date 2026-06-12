"use client";

import type { TiltStatus } from "@/lib/tilt";
import { krFmt } from "@/lib/format";

function BudgetBar({
  label,
  used,
  budget,
  unit,
  color,
}: {
  label: string;
  used: number;
  budget: number;
  unit: number;
  color: string;
}) {
  const pct = Math.min(100, (used / budget) * 100);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--dim)", marginBottom: 5 }}>
        <span>{label}</span>
        <span className="ap-num" style={{ fontWeight: 600, color: "var(--txt)" }}>
          {used.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} u av {budget.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} u
          <span style={{ color: "var(--dim2)", fontWeight: 500 }}> · {krFmt(used * unit)}</span>
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 4, background: "var(--hover)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4 }} />
      </div>
    </div>
  );
}

/** Pause banner on the overview — only rendered when the tilt guard trips. */
export function TiltBanner({ tilt, unit }: { tilt: TiltStatus; unit: number }) {
  if (tilt.level === "ok") return null;
  const danger = tilt.level === "danger";
  const barColor = danger ? "var(--red)" : "#f5a524";
  return (
    <div className={"ap-tilt " + (danger ? "danger" : "warn")} role="status">
      <div className="ap-tilt-head">
        <span aria-hidden="true">{danger ? "⛔" : "⚠️"}</span>
        <span>Tilt-vakt — {danger ? "dags att ta en paus" : "håll koll på insatserna"}</span>
      </div>
      <ul className="ap-tilt-notes">
        {tilt.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tilt.dailyBudgetUnits != null && (
          <BudgetBar label="Dagens insats" used={tilt.stakedTodayUnits} budget={tilt.dailyBudgetUnits} unit={unit} color={barColor} />
        )}
        {tilt.weeklyBudgetUnits != null && (
          <BudgetBar label="Veckans insats" used={tilt.stakedWeekUnits} budget={tilt.weeklyBudgetUnits} unit={unit} color={barColor} />
        )}
      </div>
    </div>
  );
}
