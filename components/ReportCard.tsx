"use client";

// Generic period report card (current vs previous period + discipline grade).
// The weekly and monthly reports on Insikter are both instances of this.

import { Card } from "./ui";
import { krFmt, uFmt, pctFmt } from "@/lib/format";
import type { PeriodAgg, WeekBetRef } from "@/lib/weekly";

function PeriodCol({ title, agg, unit, dim }: { title: string; agg: PeriodAgg; unit: number; dim?: boolean }) {
  return (
    <div style={{ opacity: dim ? 0.75 : 1 }}>
      <div style={{ fontSize: 12, color: "var(--dim)", fontWeight: 600 }}>{title}</div>
      <div className="ap-num" style={{ fontSize: 27, fontWeight: 700, marginTop: 6 }}>
        <span className={agg.profitUnits >= 0 ? "pos" : "neg"}>{krFmt(agg.profitUnits * unit, true)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 10, fontSize: 12.5, color: "var(--dim)" }}>
        <span>
          {agg.bets} bets{agg.pending > 0 ? ` · ${agg.pending} öppna` : ""}
        </span>
        <span>
          Träff {agg.winRatePct != null ? pctFmt(agg.winRatePct) : "—"} · ROI {agg.roiPct != null ? pctFmt(agg.roiPct, true) : "—"}
        </span>
        <span>
          Omsatt {uFmt(agg.stakedUnits)} · {krFmt(agg.stakedUnits * unit)}
        </span>
      </div>
    </div>
  );
}

function PeriodBetLine({ label, bet, unit, tone }: { label: string; bet: WeekBetRef | null; unit: number; tone: "pos" | "neg" }) {
  if (!bet) return null;
  return (
    <div className="ap-leg" style={{ fontSize: 12.5 }}>
      <span style={{ color: "var(--dim2)", width: 100, flexShrink: 0 }}>{label}</span>
      <span className="ap-ell" style={{ flex: 1, color: "var(--dim)" }}>
        {bet.event}
        {bet.selection ? ` · ${bet.selection}` : ""}
      </span>
      <span className={"ap-num " + tone} style={{ fontWeight: 600 }}>{krFmt(bet.profitUnits * unit, true)}</span>
    </div>
  );
}

export function disciplineGradeLabel(pct: number | null): { text: string; tone: string } {
  if (pct == null) return { text: "—", tone: "" };
  if (pct >= 85) return { text: "A", tone: "pos" };
  if (pct >= 70) return { text: "B", tone: "pos" };
  if (pct >= 50) return { text: "C", tone: "" };
  if (pct >= 30) return { text: "D", tone: "neg" };
  return { text: "E", tone: "neg" };
}

export function ReportCard({
  title,
  periodLabel,
  currentTitle,
  previousTitle,
  compareLabel,
  bestLabel,
  worstLabel,
  current,
  previous,
  unit,
}: {
  title: string;
  periodLabel: React.ReactNode;
  currentTitle: string;
  previousTitle: string;
  compareLabel: string; // e.g. "vs förra veckan"
  bestLabel: string; // e.g. "Veckans bästa"
  worstLabel: string;
  current: PeriodAgg;
  previous: PeriodAgg;
  unit: number;
}) {
  const delta = current.profitUnits - previous.profitUnits;
  const grade = disciplineGradeLabel(current.disciplinePct);
  return (
    <Card style={{ padding: 0 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">{title}</span>
        <span style={{ color: "var(--dim2)", fontSize: 12 }}>{periodLabel}</span>
      </div>
      <div className="ap-week-grid" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
        <PeriodCol title={currentTitle} agg={current} unit={unit} />
        <PeriodCol title={previousTitle} agg={previous} unit={unit} dim />
      </div>
      <div style={{ padding: "0 20px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className={"ap-pill " + (delta >= 0 ? "pos" : "neg")}>
          {delta >= 0 ? "▲" : "▼"} {krFmt(Math.abs(delta) * unit)} {compareLabel}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span className={"ap-num ap-grade " + grade.tone}>{grade.text}</span>
          <span style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: 1.4 }}>
            Disciplin<br />
            {current.disciplinePct != null
              ? `${Math.round(current.disciplinePct)} % av insatserna utan kända läckor`
              : "ingen data ännu"}
          </span>
        </div>
      </div>
      {(current.best || current.worst) && (
        <div style={{ padding: "0 20px 16px", display: "flex", flexDirection: "column", gap: 7 }}>
          <PeriodBetLine label={bestLabel} bet={current.best} unit={unit} tone="pos" />
          <PeriodBetLine label={worstLabel} bet={current.worst} unit={unit} tone="neg" />
        </div>
      )}
    </Card>
  );
}
