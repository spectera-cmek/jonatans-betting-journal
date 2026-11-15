"use client";

import type { TiltStatus } from "@/lib/tilt";
import { krFmt } from "@/lib/format";
import { I, IC } from "./icons";

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
    <div className="ap-meter">
      <div className="ap-meter-head">
        <span>{label}</span>
        <span className="ap-num">
          {used.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} u av {budget.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} u
          <small> · {krFmt(used * unit)}</small>
        </span>
      </div>
      <div className="ap-meter-track">
        <i style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/** Pause banner on the overview — only rendered when the tilt guard trips. */
export function TiltBanner({ tilt, unit }: { tilt: TiltStatus; unit: number }) {
  if (tilt.level === "ok") return null;
  const danger = tilt.level === "danger";
  const barColor = danger ? "var(--red)" : "var(--acc)";
  return (
    <div className={"ap-tilt " + (danger ? "danger" : "warn")} role="status">
      <div className="ap-tilt-head">
        <span aria-hidden="true"><I p={IC.alert} size={16} /></span>
        <span>Tilt-vakt — {danger ? "dags att ta en paus" : "håll koll på insatserna"}</span>
      </div>
      <ul className="ap-tilt-notes">
        {tilt.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      <div className="ap-tilt-meters">
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
