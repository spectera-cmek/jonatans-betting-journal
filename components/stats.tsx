"use client";

// Shared stat/breakdown building blocks used by Analys, VM 2026 and Insikter.
// Extracted from the pages so the tournament view can't drift from the main one.

import { Card } from "./ui";
import { HBar } from "./charts";
import { useTheme } from "./ThemeProvider";
import { uFmt, pctFmt, krShort, krFmt, sportTag, dateShort } from "@/lib/format";
import type { Breakdown } from "@/lib/betting";
import type { LeaderboardEntry } from "@/lib/useData";

export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  const hairline = tone === "pos" ? " is-pos" : tone === "neg" ? " is-neg" : "";
  return (
    <div className={"ap-card ap-lift ap-kpi" + hairline}>
      <span className="ap-label">{label}</span>
      <div className="ap-num ap-kpi-val">
        <span className={tone || ""}>{value}</span>
      </div>
      {sub && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export function BreakdownCard({
  title,
  rows,
  unit,
  sub,
}: {
  title: string;
  rows: Breakdown[];
  unit: number;
  sub?: string;
}) {
  const { cc } = useTheme();
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.profitUnits)));
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="ap-label">{title}</span>
        {sub && <span style={{ color: "var(--dim2)", fontSize: 11 }}>{sub}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
        {rows.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data</span>}
        {rows.map((r) => (
          <div key={r.key}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span>
                {r.key}{" "}
                <span style={{ color: "var(--dim2)", fontSize: 12 }}>
                  · {r.bets} bets{r.winRatePct != null ? ` · ${pctFmt(r.winRatePct)}` : ""}
                </span>
              </span>
              <span className="ap-num" style={{ fontWeight: 600 }}>
                <em className={r.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>
                  {krShort(r.profitUnits * unit, true)}
                </em>
                <span style={{ color: "var(--dim2)", marginLeft: 8 }}>{pctFmt(r.roiPct, true)}</span>
              </span>
            </div>
            <HBar
              pct={Math.max((Math.abs(r.profitUnits) / max) * 100, 3)}
              color={r.profitUnits >= 0 ? cc.acc : cc.red}
              track={cc.grid}
              h={7}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

// Mobile rendering for period/bookmaker tables — stacked cards so the P/L, ROI
// and win-rate columns don't get pushed off-screen by a sideways scroll.
export function PerfCards({
  rows,
  unit,
  cap = true,
}: {
  rows: { label: string; bets: number; profitUnits: number; roiPct: number | null; winRatePct: number | null }[];
  unit: number;
  cap?: boolean;
}) {
  return (
    <div className="ap-betcards" style={{ padding: "12px 14px 14px" }}>
      {rows.map((r) => (
        <div key={r.label} className="ap-betcard">
          <div className="ap-betcard-top">
            <span className="ap-betcard-event" style={cap ? { textTransform: "capitalize" } : undefined}>{r.label}</span>
            <b className={"ap-num " + (r.profitUnits >= 0 ? "pos" : "neg")} style={{ fontWeight: 700, fontSize: 15 }}>
              {krShort(r.profitUnits * unit, true)}
            </b>
          </div>
          <div className="ap-betcard-stats">
            <div>
              <span>Bets</span>
              <b className="ap-num">{r.bets}</b>
            </div>
            <div>
              <span>ROI</span>
              <b className={"ap-num " + ((r.roiPct ?? 0) >= 0 ? "pos" : "neg")}>{pctFmt(r.roiPct, true)}</b>
            </div>
            <div>
              <span>Win rate</span>
              <b className="ap-num">{pctFmt(r.winRatePct)}</b>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LeaderboardCard({
  title,
  sub,
  entries,
  unit,
}: {
  title: string;
  sub?: string;
  entries: LeaderboardEntry[];
  unit: number;
}) {
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="ap-label">{title}</span>
        {sub && <span style={{ color: "var(--dim2)", fontSize: 11 }}>{sub}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        {entries.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data</span>}
        {entries.map((e, i) => (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="ap-num" style={{ width: 16, textAlign: "center", color: "var(--dim2)", fontWeight: 700, fontSize: 13 }}>
              {i + 1}
            </span>
            <span className="ap-tag">{sportTag(e.sport)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ap-ell" style={{ fontSize: 13 }}>{e.event}</div>
              <div className="ap-ell" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 2 }}>
                {e.selection || "—"}
              </div>
              <div className="ap-ell" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 3 }}>
                {dateShort(e.eventAt)} · odds {e.odds.toFixed(2)} · insats {uFmt(e.stakeUnits)} ({krFmt(e.stakeUnits * unit)})
              </div>
            </div>
            <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <div className="ap-num" style={{ fontWeight: 700 }}>
                <em className={e.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>
                  {krFmt(e.profitUnits * unit, true)}
                </em>
              </div>
              <div className="ap-num" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 2 }}>
                {pctFmt(e.roiPct, true)} ROI
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Compact card2 stat block (simulator figures, open-bets strip…). */
export function MiniStat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div style={{ background: "var(--card2)", borderRadius: 12, padding: "12px 14px" }}>
      <div className="ap-label">{label}</div>
      <div className={"ap-num " + (tone ?? "")} style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

/** Inline variant: tiny label over a bold number, several-in-a-row in a flex container. */
export function InlineStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <span className="ap-label" style={{ fontSize: 9.5 }}>
        {label}
      </span>
      <span className={"ap-num " + (tone ?? "")} style={{ fontSize: 14.5, fontWeight: 700 }}>
        {value}
      </span>
    </span>
  );
}

// Full bookmaker comparison table (replaces the old single BreakdownCard).
// No avg-odds column on purpose: per-bookmaker averages are polluted by the
// 1.01 loss placeholders from the importers.
export function BookmakerTable({ rows, unit }: { rows: Breakdown[]; unit: number }) {
  const { cc } = useTheme();
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.profitUnits)));
  const cols = "minmax(130px, 1fr) 60px 100px 140px 80px 80px 110px";
  return (
    <Card style={{ padding: 0, marginBottom: 12 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">Per bookmaker</span>
        <span style={{ color: "var(--dim2)", fontSize: 12 }}>{rows.length} bolag</span>
      </div>
      <div className="ap-table-wrap">
        <div className="ap-table">
          <div className="ap-thead" style={{ gridTemplateColumns: cols }}>
            <span>Bookmaker</span>
            <span className="ap-r">Bets</span>
            <span className="ap-r">Omsatt</span>
            <span className="ap-r">P/L</span>
            <span className="ap-r">ROI</span>
            <span className="ap-r">Win rate</span>
            <span />
          </div>
          {rows.length === 0 && (
            <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--dim2)" }}>Ingen data än.</div>
          )}
          {rows.map((r) => (
            <div key={r.key} className="ap-trow" style={{ gridTemplateColumns: cols }}>
              <span className="ap-ell" style={{ fontWeight: 600 }}>{r.key}</span>
              <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{r.bets}</span>
              <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{krShort(r.stakedUnits * unit)}</span>
              <span className="ap-r ap-num" style={{ fontWeight: 600 }}>
                <em className={r.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>
                  {krShort(r.profitUnits * unit, true)}
                </em>{" "}
                <span style={{ color: "var(--dim2)" }}>{uFmt(r.profitUnits, true)}</span>
              </span>
              <span className="ap-r ap-num">
                <em className={(r.roiPct ?? 0) >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>
                  {pctFmt(r.roiPct, true)}
                </em>
              </span>
              <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{pctFmt(r.winRatePct)}</span>
              <span style={{ display: "flex", alignItems: "center" }}>
                <HBar
                  pct={Math.max((Math.abs(r.profitUnits) / max) * 100, 3)}
                  color={r.profitUnits >= 0 ? cc.pos : cc.red}
                  track={cc.grid}
                  h={7}
                />
              </span>
            </div>
          ))}
        </div>
      </div>
      {rows.length > 0 && (
        <PerfCards
          rows={rows.map((r) => ({ label: r.key, bets: r.bets, profitUnits: r.profitUnits, roiPct: r.roiPct, winRatePct: r.winRatePct }))}
          unit={unit}
          cap={false}
        />
      )}
    </Card>
  );
}
