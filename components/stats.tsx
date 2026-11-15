"use client";

// Shared stat/breakdown building blocks used by Analys, VM 2026 and Insikter.
// Extracted from the pages so the tournament view can't drift from the main one.

import { Card, Hint } from "./ui";
import { HBar } from "./miniCharts";
import { useTheme } from "./ThemeProvider";
import { uFmt, pctFmt, krShort, krFmt, sportTag, dateShort } from "@/lib/format";
import type { Breakdown } from "@/lib/betting";
import type { LeaderboardEntry } from "@/lib/useData";

/** KPI cell with a plain string value — the lighter sibling of ui.Kpi. */
export function StatTile({
  label,
  value,
  sub,
  tone,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  hint?: React.ReactNode;
}) {
  const valueTone = tone === "pos" ? "t-pos" : tone === "neg" ? "t-red" : "";
  return (
    <div className="ap-card ap-kpi">
      <div className="ap-kpi-head">
        <span className="ap-label">
          {label}
          {hint && <Hint>{hint}</Hint>}
        </span>
      </div>
      <div className={"ap-num ap-kpi-val " + valueTone}>{value}</div>
      {sub && <div className="ap-kpi-foot">{sub}</div>}
    </div>
  );
}

/** A ranked breakdown: one ledger row per segment, with a thin P/L bar under it. */
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
      <div className="ap-panel-head">
        <h3 className="ap-card-title">{title}</h3>
        {sub && <span className="ap-t-xs ap-t-dim2">{sub}</span>}
      </div>
      <div className="ap-bd">
        {rows.length === 0 && <span className="ap-note">Ingen data</span>}
        {rows.map((r) => (
          <div key={r.key} className="ap-bd-row">
            <div className="ap-bd-line">
              <span className="ap-bd-name">
                <span className="ap-ell">{r.key}</span>
                <small>
                  {r.bets} bets{r.winRatePct != null ? ` · ${pctFmt(r.winRatePct)}` : ""}
                </small>
              </span>
              <span className="ap-num ap-bd-val">
                <em className={r.profitUnits >= 0 ? "pos" : "neg"}>{krShort(r.profitUnits * unit, true)}</em>
                <small>{pctFmt(r.roiPct, true)}</small>
              </span>
            </div>
            <HBar
              pct={Math.max((Math.abs(r.profitUnits) / max) * 100, 2)}
              color={r.profitUnits >= 0 ? cc.pos : cc.red}
              track={cc.grid}
              h={3}
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
    <div className="ap-betcards is-flush">
      {rows.map((r) => (
        <div key={r.label} className="ap-betcard">
          <div className="ap-betcard-top">
            <span className="ap-betcard-event" style={cap ? { textTransform: "capitalize" } : undefined}>{r.label}</span>
            <b className={"ap-num " + (r.profitUnits >= 0 ? "pos" : "neg")} style={{ fontWeight: 500, fontSize: 15 }}>
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
      <div className="ap-panel-head">
        <h3 className="ap-card-title">{title}</h3>
        {sub && <span className="ap-t-xs ap-t-dim2">{sub}</span>}
      </div>
      <div className="ap-lb">
        {entries.length === 0 && <span className="ap-note">Ingen data</span>}
        {entries.map((e, i) => (
          <div key={e.id} className="ap-lb-row">
            <span className="ap-num ap-lb-rank">{i + 1}</span>
            <span className="ap-tag">{sportTag(e.sport)}</span>
            <div className="ap-lb-main">
              <div className="ap-ell">{e.event}</div>
              <small className="ap-ell">{e.selection || "—"}</small>
              <small className="ap-ell ap-num">
                {dateShort(e.eventAt)} · odds {e.odds.toFixed(2)} · insats {uFmt(e.stakeUnits)} ({krFmt(e.stakeUnits * unit)})
              </small>
            </div>
            <div className="ap-lb-val ap-num">
              <em className={e.profitUnits >= 0 ? "pos" : "neg"}>{krFmt(e.profitUnits * unit, true)}</em>
              <small>{pctFmt(e.roiPct, true)} ROI</small>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Compact recessed stat block (simulator figures, open-bets strip…). */
export function MiniStat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="ap-ministat">
      <div className="ap-label">{label}</div>
      <div className={"ap-num ap-ministat-val " + (tone ?? "")}>{value}</div>
      {sub && <div className="ap-ministat-sub">{sub}</div>}
    </div>
  );
}

/** Inline variant: tiny label over a number, several-in-a-row in a flex container. */
export function InlineStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="ap-inlinestat">
      <span className="ap-label">{label}</span>
      <span className={"ap-num " + (tone ?? "")}>{value}</span>
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
        <span role="heading" aria-level={2} className="ap-card-title">Per bookmaker</span>
        <span className="ap-t-sm ap-t-dim2">{rows.length} bolag</span>
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
            <div className="ap-panel-empty">Ingen data än.</div>
          )}
          {rows.map((r) => (
            <div key={r.key} className="ap-trow" style={{ gridTemplateColumns: cols }}>
              <span className="ap-ell" style={{ fontWeight: 500 }}>{r.key}</span>
              <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{r.bets}</span>
              <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{krShort(r.stakedUnits * unit)}</span>
              <span className="ap-r ap-num">
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
                  h={4}
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
