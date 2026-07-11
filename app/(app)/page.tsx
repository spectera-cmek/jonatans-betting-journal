"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, Skeleton, CountUp } from "@/components/ui";
import { InteractiveLineChart, PLBars, Donut, type TimePoint } from "@/components/charts";
import { ResultBadge } from "@/components/ResultBadge";
import { TiltBanner } from "@/components/TiltBanner";
import { GoalCard } from "@/components/GoalCard";
import { OpenBetsPanel } from "@/components/OpenBetsPanel";
import { BetTags } from "@/components/BetTags";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics } from "@/lib/useData";
import { api } from "@/lib/fetcher";
import { krFmt, krShort, uFmt, pctFmt, sportTag, dateShort } from "@/lib/format";
import type { BetListDTO } from "@/lib/types";
import type { StreakInfo } from "@/lib/insights";
import { useEffect } from "react";

const PERIODS = [
  { key: "all", label: "Allt", days: null },
  { key: "1y", label: "1 år", days: 365 },
  { key: "90d", label: "90 d", days: 90 },
  { key: "30d", label: "30 d", days: 30 },
  { key: "7d", label: "7 d", days: 7 },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

export default function OverviewPage() {
  const { cc, glow } = useTheme();
  const { data, loading } = useMetrics();
  const [recent, setRecent] = useState<BetListDTO[]>([]);
  const [period, setPeriod] = useState<PeriodKey>("all");

  // Re-fetch the short list whenever the metrics refresh (a save/settle
  // triggers reload → new data → fresh recent rows).
  useEffect(() => {
    api.get<BetListDTO[]>("/api/bets?limit=7&fields=list").then(setRecent);
  }, [data]);

  const m = data?.metrics;
  const unit = data?.settings.unitValue ?? 100;
  const profitKr = (m?.profitUnits ?? 0) * unit;

  // Chart points cut to the chosen period. The point just before the cutoff
  // is kept so the curve enters at its real level.
  const allPts = useMemo<TimePoint[]>(
    () => (data?.bankroll ?? []).map((p) => ({ t: Date.parse(p.date), v: p.profitUnits * unit })),
    [data, unit]
  );
  const pts = useMemo(() => {
    const days = PERIODS.find((p) => p.key === period)?.days;
    if (!days) return allPts;
    const cutoff = Date.now() - days * 864e5;
    const idx = allPts.findIndex((p) => p.t >= cutoff);
    if (idx === -1) return [];
    return allPts.slice(Math.max(0, idx - 1));
  }, [allPts, period]);

  // Max drawdown over the visible period, in kr. (No %-of-peak — that only
  // made sense against the old arbitrary starting bankroll.)
  const visDdKr = useMemo(() => {
    let peak = -Infinity;
    let maxDd = 0;
    for (const p of pts) {
      if (p.v > peak) peak = p.v;
      if (peak - p.v > maxDd) maxDd = peak - p.v;
    }
    return maxDd;
  }, [pts]);

  // Period P/L: last point vs the period's entry level. The headline follows
  // the selected period; "Allt" shows the all-time total.
  const periodDiff = pts.length >= 2 ? pts[pts.length - 1].v - pts[0].v : null;
  const periodBets = Math.max(0, pts.length - 1); // every point after the entry = one settled bet
  const showPeriod = period !== "all" && periodDiff != null;
  const headlineKr = showPeriod ? (periodDiff as number) : profitKr;

  // sport distribution with pct
  const sports = (data?.bySport ?? []).map((s) => ({ ...s }));
  const totalSportBets = sports.reduce((a, s) => a + s.bets, 0) || 1;
  const sportsWithPct = sports.map((s) => ({ ...s, pct: Math.round((s.bets / totalSportBets) * 100) }));

  const months = (data?.monthly ?? []).map((mo) => ({ m: monthLabel(mo.month), units: mo.profitUnits }));
  // First year present in the data -> "sedan 2023" copy in the header.
  const allMonths = data?.byMonth ?? [];
  const rangeLabel = allMonths.length ? allMonths[0].month.slice(0, 4) : "";
  const ins = data?.insights;
  const risk = data?.openRisk;

  // Current month/year realised P/L (units) for the goal-pace card.
  const now = new Date();
  const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthProfitU = (data?.byMonth ?? []).find((mo) => mo.month === curYM)?.profitUnits ?? 0;
  const yearProfitU = (data?.byYear ?? []).find((y) => y.key === String(now.getFullYear()))?.profitUnits ?? 0;

  // Per-user header: "Jonatans Betting Journal" for jonatan, etc.
  const username = data?.username;
  const title = username
    ? `${username[0].toUpperCase() + username.slice(1)}s Betting Journal`
    : "Betting Journal";

  return (
    <div className="ap-dashboard">
      {glow && <div className="ap-glow" />}
      <header className="ap-terminal-head">
        <div>
          <h1>{title}</h1>
          <p>{m?.totalBets?.toLocaleString("sv-SE") ?? 0} bets · {rangeLabel ? `${rangeLabel}` : "ingen historik"}</p>
        </div>
        <div className="ap-terminal-status">
          <span>Portfölj</span>
          <strong>{risk ? krFmt(risk.stakeUnits * unit) : "—"} exponerat</strong>
        </div>
      </header>

      {/* Tilt guard — only visible when budgets/chasing trip */}
      {data?.tilt && <TiltBanner tilt={data.tilt} unit={unit} />}

      {/* Compact terminal overview */}
      <section className="ap-terminal-overview">
        <div className="ap-terminal-strip">
          <div className="ap-terminal-primary">
            <span>Nettoresultat</span>
            {loading && !data ? (
              <Skeleton w={150} h={30} style={{ marginTop: 8 }} />
            ) : (
              <strong className={headlineKr >= 0 ? "pos" : "neg"}>
                <CountUp value={headlineKr} format={(n) => krFmt(n, true)} />
              </strong>
            )}
          </div>
          <div><span>ROI</span><strong className={(m?.roiPct ?? 0) >= 0 ? "pos" : "neg"}>{pctFmt(m?.roiPct ?? null, true)}</strong></div>
          <div><span>Units</span><strong className={(m?.profitUnits ?? 0) >= 0 ? "pos" : "neg"}>{uFmt(m?.profitUnits ?? 0, true)}</strong></div>
          <div><span>Win rate</span><strong>{pctFmt(m?.winRatePct ?? null)}</strong></div>
          <div><span>Avgjorda</span><strong>{(m?.settledBets ?? 0).toLocaleString("sv-SE")}</strong></div>
          <div><span>Max DD</span><strong className="neg">{visDdKr > 0 ? krShort(-visDdKr, false) : "—"}</strong></div>
        </div>

        <div className="ap-terminal-chart-head">
          <div>
            <strong>Resultatutveckling</strong>
            <span>
              {showPeriod
                ? `${periodBets.toLocaleString("sv-SE")} avgjorda · ${PERIODS.find((p) => p.key === period)?.label}`
                : `${(m?.settledBets ?? 0).toLocaleString("sv-SE")} avgjorda · hela perioden`}
            </span>
          </div>
          <div className="ap-terminal-periods">
            {PERIODS.map((p) => (
              <button key={p.key} className={period === p.key ? "is-active" : ""} onClick={() => setPeriod(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ap-terminal-chart">
          {loading && !data ? (
            <Skeleton h={176} />
          ) : (
            <InteractiveLineChart
              points={pts}
              w={940}
              h={176}
              stroke={cc.acc}
              fill={cc.fill}
              grid={cc.grid}
              formatValue={(v) => krFmt(v)}
            />
          )}
        </div>
      </section>

      {/* Open risk is the primary actionable section. */}
      {data && risk && <OpenBetsPanel open={data.openBets ?? []} risk={risk} unit={unit} />}

      <div className="ap-section-rule">
        <span>02</span>
        <strong>Resultatfördelning</strong>
        <em>Utveckling per månad och sport</em>
      </div>

      {/* Monthly bars + sport mix */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 330px", marginBottom: 12 }}>
        <Card>
          <span className="ap-label">P/L per månad (units)</span>
          <div style={{ marginTop: 14 }}>
            <PLBars data={months} w={400} h={150} pos={cc.pos} neg={cc.red} labelColor={cc.dim} track={cc.line} />
          </div>
        </Card>
        <Card>
          <span className="ap-label">Fördelning per sport</span>
          <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 14 }}>
            <Donut data={sportsWithPct} size={112} thickness={17} colors={cc.palette} track={cc.grid} centerLabel={String(m?.totalBets ?? 0)} centerSub="BETS" centerColor={cc.txt} centerSubColor={cc.dim} />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 9 }}>
              {sportsWithPct.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data än</span>}
              {sportsWithPct.slice(0, 5).map((s, i) => (
                <div key={s.key} className="ap-leg">
                  <span className="ap-dot" style={{ background: cc.palette[i % cc.palette.length] }} />
                  <span className="ap-ell" style={{ flex: 1, color: "var(--dim)" }}>{s.key}</span>
                  <span className="ap-num" style={{ fontWeight: 600 }}>{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 12 }}>
        <Card>
          <span className="ap-label">Form &amp; rekord</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 14 }}>
            <FormRow label="Nuvarande svit" value={streakText(ins?.streaks)} tone={streakTone(ins?.streaks)} />
            <FormRow label="Längsta vinstsvit" value={ins ? `${ins.streaks.longestWin} i rad` : "—"} tone="pos" />
            <FormRow label="Längsta förlustsvit" value={ins ? `${ins.streaks.longestLoss} i rad` : "—"} tone="neg" />
          </div>
        </Card>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="ap-label">Extremer &amp; insats</span>
            <Link href="/insights" className="ap-link">Mer →</Link>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 14 }}>
            <FormRow label="Bästa dag" value={ins?.best ? `${krShort(ins.best.profitUnits * unit, true)} · ${dateShort(ins.best.date)}` : "—"} tone="pos" />
            <FormRow label="Sämsta dag" value={ins?.worst ? `${krShort(ins.worst.profitUnits * unit, true)} · ${dateShort(ins.worst.date)}` : "—"} tone="neg" />
            <FormRow label="Snittinsats" value={ins?.avgStakeUnits != null ? `${ins.avgStakeUnits.toFixed(2)}U · ${krFmt(ins.avgStakeUnits * unit)}` : "—"} />
          </div>
        </Card>
      </div>

      {/* Goals & pace */}
      {!loading && data && (
        <GoalCard monthProfitUnits={monthProfitU} yearProfitUnits={yearProfitU} unit={unit} />
      )}

      {/* Recent bets */}
      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Senaste bets</span>
          <Link href="/bets" className="ap-link">Visa alla →</Link>
        </div>
        <div className="ap-table-wrap">
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "66px 50px 1.7fr 1.2fr 100px 58px 76px 84px" }}>
              <span>Datum</span><span>Sport</span><span>Match</span><span className="ap-hide-sm">Spel</span><span className="ap-hide-sm">Bookmaker</span><span className="ap-r">Odds</span><span className="ap-r">Insats</span><span className="ap-r">Resultat</span>
            </div>
            {recent.map((b) => (
              <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: "66px 50px 1.7fr 1.2fr 100px 58px 76px 84px" }}>
                <span style={{ color: "var(--dim)" }}>{dateShort(b.eventAt ?? b.placedAt)}</span>
                <span><span className="ap-tag">{sportTag(b.sport)}</span></span>
                <span className="ap-ell">{b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}</span>
                <span className="ap-hide-sm" style={{ color: "var(--dim)", minWidth: 0 }}>
                  <span className="ap-ell" style={{ display: "block" }}>{b.selection || "—"}</span>
                  <BetTags bet={b} compact hideSport />
                </span>
                <span className="ap-hide-sm" style={{ color: "var(--dim)" }}>{b.bookmaker || "—"}</span>
                <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                <span className="ap-r ap-num">{b.stakeUnits.toFixed(2)}U</span>
                <span className="ap-r"><ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} /></span>
              </div>
            ))}
            {recent.length === 0 && (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--dim2)", fontSize: 14 }}>Inga bets än — logga din första bet.</div>
            )}
          </div>
        </div>
        {/* Mobile: stacked cards instead of a sideways-scrolling 8-column table. */}
        <div className="ap-betcards" style={{ padding: "12px 14px 14px" }}>
          {recent.length === 0 && <div className="ap-betcard-empty">Inga bets än — logga din första bet.</div>}
          {recent.map((b) => (
            <div key={b.id} className="ap-betcard">
              <div className="ap-betcard-top">
                <span className="ap-betcard-date"><span className="ap-tag">{sportTag(b.sport)}</span> {dateShort(b.eventAt ?? b.placedAt)}</span>
                <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
              </div>
              <div className="ap-betcard-event">{b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}</div>
              <div className="ap-betcard-sel">{b.selection || "—"}</div>
              <div className="ap-betcard-stats">
                <div><span>Odds</span><b className="ap-num">{b.odds.toFixed(2)}</b></div>
                <div><span>Insats</span><b className="ap-num">{b.stakeUnits.toFixed(2)}U</b></div>
                <div>
                  <span>P/L</span>
                  <b className={"ap-num " + (b.outcome === "pending" ? "" : (b.profitUnits ?? 0) >= 0 ? "pos" : "neg")}>
                    {b.outcome === "pending" ? "—" : krShort((b.profitUnits ?? 0) * unit, true)}
                  </b>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function monthLabel(ym: string): string {
  // ym = "2026-05" -> "Maj"
  const months = ["Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"];
  const mi = parseInt(ym.slice(5, 7), 10) - 1;
  return months[mi] ?? ym;
}

// One label/value line in the "Form & rekord" card.
function FormRow({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="ap-leg">
      <span style={{ flex: 1, color: "var(--dim)" }}>{label}</span>
      <span className="ap-num" style={{ fontWeight: 600 }}>
        <em className={tone ?? ""} style={{ fontStyle: "normal" }}>{value}</em>
      </span>
    </div>
  );
}

function streakText(s?: StreakInfo): string {
  if (!s || s.currentType === "none" || s.current === 0) return "—";
  const noun = s.currentType === "win" ? (s.current === 1 ? "vinst" : "vinster") : (s.current === 1 ? "förlust" : "förluster");
  return `${s.current} ${noun} i rad`;
}

function streakTone(s?: StreakInfo): "pos" | "neg" | undefined {
  if (!s || s.currentType === "none") return undefined;
  return s.currentType === "win" ? "pos" : "neg";
}
