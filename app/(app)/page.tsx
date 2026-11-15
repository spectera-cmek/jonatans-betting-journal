"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Skeleton, SkeletonCard, CountUp, Kpi, PanelHead, SportMark } from "@/components/ui";
import { Topbar } from "@/components/Shell";
import { InteractiveLineChart, PLBars, type TimePoint } from "@/components/charts";
import { ResultBadge } from "@/components/ResultBadge";
import { TiltBanner } from "@/components/TiltBanner";
import { GoalCard } from "@/components/GoalCard";
import { OpenBetsPanel } from "@/components/OpenBetsPanel";
import { BetTags } from "@/components/BetTags";
import { ClvCell, type ClvSaved } from "@/components/ClvCell";
import { useMetrics, useRecentBets } from "@/lib/useData";
import { krFmt, krShort, uFmt, pctFmt, dateShort } from "@/lib/format";
import type { BetListDTO } from "@/lib/types";
import type { StreakInfo } from "@/lib/insights";
import { CHART_PERIODS } from "@/lib/periods";

const RECENT_GRID = "58px 44px minmax(0,1.5fr) minmax(0,1.7fr) 96px 52px 78px 62px 92px";

const PERIODS = CHART_PERIODS;
type PeriodKey = string;

export default function OverviewPage() {
  const { data, loading, reload } = useMetrics();
  // Shared + deduped fetch. The previous effect keyed on `data` fired twice per
  // visit (once on mount, once when the metrics object identity changed) and
  // bypassed the cache. useRecentBets registers with revalidateAll, so a save or
  // sync still refreshes these rows.
  const { data: recentData, reload: reloadRecent } = useRecentBets(7);
  const [recent, setRecent] = useState<BetListDTO[]>([]);
  const [period, setPeriod] = useState<PeriodKey>("all");

  // Mirror the fetched rows into local state so the optimistic CLV edit below
  // can patch a single row without waiting for a refetch.
  useEffect(() => {
    if (recentData) setRecent(recentData);
  }, [recentData]);

  const onClvSaved = (id: string, next: ClvSaved) => {
    setRecent((rows) =>
      rows.map((b) => (b.id === id ? { ...b, closingOdds: next.closingOdds, clvPct: next.clvPct } : b))
    );
    reload();
    reloadRecent();
  };

  const unit = data?.settings.unitValue ?? 100;
  // Every KPI card reads the selected period. Falls back to the all-time
  // figures only while an older cached payload without periodMetrics is shown.
  const m = data?.periodMetrics?.[period] ?? data?.metrics;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "Allt";
  const periodTrend = period === "all" ? "Hela historiken" : periodLabel;
  const headlineKr = (m?.profitUnits ?? 0) * unit;
  const ddU = (data?.periodMetrics?.[period]?.drawdown ?? data?.drawdown)?.maxUnits ?? 0;
  const avgStakeU = m?.settledBets ? m.stakedUnits / m.settledBets : null;

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

  // ~40 evenly spaced samples of the visible curve for the KPI sparkline.
  const sparkPts = useMemo(() => {
    if (pts.length < 2) return undefined;
    const step = Math.max(1, Math.floor(pts.length / 40));
    const out: number[] = [];
    for (let i = 0; i < pts.length; i += step) out.push(pts[i].v);
    if (out.length && out[out.length - 1] !== pts[pts.length - 1].v) out.push(pts[pts.length - 1].v);
    return out.length > 1 ? out : undefined;
  }, [pts]);

  // sport distribution with pct. Memoised because both of these feed straight
  // into <Donut> / <PLBars>: a fresh array identity on every render made the
  // charts rebuild their geometry even when the underlying data hadn't moved.
  const sportsWithPct = useMemo(() => {
    const sports = data?.bySport ?? [];
    const totalSportBets = sports.reduce((a, s) => a + s.bets, 0) || 1;
    // Largest share first: the bar shows share, so the list reads as a ranking.
    return sports
      .map((s) => ({ ...s, pct: Math.round((s.bets / totalSportBets) * 100) }))
      .sort((a, b) => b.bets - a.bets);
  }, [data?.bySport]);

  const months = useMemo(
    () => (data?.monthly ?? []).map((mo) => ({ m: monthLabel(mo.month), units: mo.profitUnits })),
    [data?.monthly]
  );
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

  // Per-user header: "Jonatans Betting Översikt" for jonatan, etc.
  const username = data?.username;
  const title = username
    ? `${username[0].toUpperCase() + username.slice(1)}s Betting Översikt`
    : "Betting Översikt";

  const settled = (m?.settledBets ?? 0).toLocaleString("sv-SE");

  return (
    <div className="ap-dashboard">
      <Topbar
        title={title}
        docTitle="Betting Översikt"
        sub={
          <>
            {(data?.metrics.totalBets ?? 0).toLocaleString("sv-SE")} spel{rangeLabel ? ` sedan ${rangeLabel}` : " · ingen historik"}
            {risk ? ` · ${krFmt(risk.stakeUnits * unit)} exponerat` : ""}
          </>
        }
        actions={
          // One period for the whole page: every figure and the curve follow it.
          <div className="ap-seg" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.key} className={period === p.key ? "is-active" : ""} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {/* Tilt guard — only visible when budgets/chasing trip */}
      {data?.tilt && <TiltBanner tilt={data.tilt} unit={unit} />}

      {/* Six figures in one ruled strip. Colour only where the sign means something. */}
      <section className="ap-kpi-grid" aria-label="Nyckeltal">
        {loading && !data
          ? Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} />)
          : (
            <>
              <Kpi
                label="Nettoresultat"
                tone={headlineKr >= 0 ? "pos" : "neg"}
                value={<CountUp value={headlineKr} format={(n) => krFmt(n, true)} />}
                spark={sparkPts}
                trend={periodTrend}
                meta={`${uFmt(m?.profitUnits ?? 0, true)}`}
              />
              <Kpi
                label="ROI"
                tone={m?.roiPct == null ? undefined : m.roiPct >= 0 ? "pos" : "neg"}
                hint="Avkastning på insatt kapital: nettoresultat delat med totalt insatt belopp på avgjorda spel."
                value={pctFmt(m?.roiPct ?? null, true)}
                trend={`${krShort((m?.stakedUnits ?? 0) * unit, false)} insatt`}
              />
              <Kpi
                label="Träffprocent"
                value={pctFmt(m?.winRatePct ?? null)}
                trend={streakText(ins?.streaks)}
                trendTone={streakTone(ins?.streaks) ?? "flat"}
                meta={`${m?.wins ?? 0}V · ${m?.losses ?? 0}F`}
              />
              <Kpi
                label="CLV"
                tone={m?.clvPct == null ? undefined : m.clvPct >= 0 ? "pos" : "neg"}
                hint="Closing line value: hur mycket bättre ditt odds var än stängningsoddset. Att slå stängningen över tid är den bästa indikatorn på edge."
                value={pctFmt(m?.clvPct ?? null, true)}
                trend={
                  m?.clvSampleSize
                    ? `${Math.round(((m.clvBeatCount ?? 0) / m.clvSampleSize) * 100)} % slår stängning`
                    : "Ingen stängningsdata"
                }
                meta={m?.clvSampleSize ? `${m.clvSampleSize} spel` : undefined}
              />
              <Kpi
                label="Medianodds"
                hint="Medianodds på avgjorda spel — inte snittet, som ett fåtal kombispel över 100x drar upp så att det slutar beskriva vad du faktiskt spelar. Placeholder-odds 1,01 räknas inte."
                value={m?.medianOdds != null ? m.medianOdds.toFixed(2) : "—"}
                trend={avgStakeU != null ? `${avgStakeU.toFixed(2)}U snittinsats` : "—"}
              />
              <Kpi
                label="Max drawdown"
                tone={ddU > 0 ? "neg" : undefined}
                hint="Största fall från en topp till efterföljande botten inom vald period."
                value={ddU > 0 ? krShort(-ddU * unit, false) : "—"}
                trend={periodTrend}
                meta={`${settled} avgjorda`}
              />
            </>
          )}
      </section>

      {/* The equity curve beside what needs doing right now. */}
      <div className="ap-board c21">
        <Card className="ap-chartcard" style={{ padding: 0 }}>
          <div className="ap-card-head">
            <h2 className="ap-card-title">Resultatutveckling</h2>
            <span className="ap-t-sm ap-t-dim2">
              {settled} avgjorda · {period === "all" ? "hela perioden" : periodLabel}
            </span>
          </div>
          <div className="ap-chart-body">
            {loading && !data ? (
              <Skeleton h={300} />
            ) : (
              <InteractiveLineChart points={pts} w={900} h={300} formatValue={(v) => krFmt(v)} formatAxis={(v) => krShort(v)} />
            )}
          </div>
        </Card>

        {data && risk ? (
          <OpenBetsPanel open={data.openBets ?? []} risk={risk} unit={unit} onClvSaved={onClvSaved} onSettled={reload} />
        ) : (
          <SkeletonCard chartH={220} />
        )}
      </div>

      {/* Where the result came from: by month, by sport, against the goal. */}
      <div className="ap-board c3">
        <Card>
          <PanelHead title="P/L per månad" sub="Units, senaste månaderna" />
          <PLBars data={months} h={150} />
        </Card>
        <Card>
          <PanelHead title="Per sport" sub="Andel av spelen · resultat" />
          <div className="ap-rank">
            {sportsWithPct.length === 0 && <span className="ap-note">Ingen data än</span>}
            {sportsWithPct.slice(0, 6).map((s) => (
              <div key={s.key} className="ap-rank-row">
                <SportMark sport={s.key} long />
                <span className="ap-rank-bar" aria-hidden="true">
                  <i style={{ width: `${s.pct}%`, background: "var(--dim2)" }} />
                </span>
                <span className="ap-num ap-r ap-t-dim">{s.pct}%</span>
                <span className={"ap-num ap-r " + (s.profitUnits >= 0 ? "pos" : "neg")}>{krShort(s.profitUnits * unit, true)}</span>
              </div>
            ))}
          </div>
        </Card>
        {!loading && data ? (
          <GoalCard monthProfitUnits={monthProfitU} yearProfitUnits={yearProfitU} unit={unit} />
        ) : (
          <SkeletonCard />
        )}
      </div>

      {/* Recent bets */}
      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <h2 className="ap-card-title">Senaste bets</h2>
          <Link href="/bets" className="ap-link">Visa alla →</Link>
        </div>
        <div className="ap-table-wrap">
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: RECENT_GRID }}>
              <span>Datum</span><span>Sport</span><span>Match</span><span>Spel</span><span>Bookmaker</span><span className="ap-r">Odds</span><span className="ap-r">CLV</span><span className="ap-r">Insats</span><span className="ap-r">Resultat</span>
            </div>
            {recent.map((b) => (
              <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: RECENT_GRID }}>
                <span className="ap-num ap-t-dim">{dateShort(b.eventAt ?? b.placedAt)}</span>
                <span style={{ minWidth: 0 }}><SportMark sport={b.sport} /></span>
                <span className="ap-ell">{b.event}{b.league && <span className="ap-t-dim2"> · {b.league}</span>}</span>
                <span className="ap-selcell">
                  <span className="ap-ell">{b.selection || "—"}</span>
                  <BetTags bet={b} compact hideSport />
                </span>
                <span className="ap-ell ap-t-dim">{b.bookmaker || "—"}</span>
                <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                <span className="ap-r">
                  <ClvCell
                    betId={b.id}
                    odds={b.odds}
                    closingOdds={b.closingOdds}
                    clvPctValue={b.clvPct}
                    boosted={b.boosted}
                    onSaved={(next) => onClvSaved(b.id, next)}
                  />
                </span>
                <span className="ap-r ap-num">{b.stakeUnits.toFixed(2)}U</span>
                <span className="ap-r"><ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} /></span>
              </div>
            ))}
            {recent.length === 0 && <div className="ap-panel-empty">Inga bets än — logga din första bet.</div>}
          </div>
        </div>
        {/* Mobile: stacked cards instead of a sideways-scrolling 9-column table. */}
        <div className="ap-betcards is-flush">
          {recent.length === 0 && <div className="ap-panel-empty">Inga bets än — logga din första bet.</div>}
          {recent.map((b) => (
            <div key={b.id} className={"ap-betcard" + (b.outcome === "pending" ? " is-open" : (b.profitUnits ?? 0) > 0 ? " is-win" : (b.profitUnits ?? 0) < 0 ? " is-loss" : "")}>
              <div className="ap-betcard-top">
                <span className="ap-betcard-date"><SportMark sport={b.sport} /> <span className="ap-num">{dateShort(b.eventAt ?? b.placedAt)}</span></span>
                <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
              </div>
              <div className="ap-betcard-event">{b.event}{b.league && <span className="ap-t-dim2"> · {b.league}</span>}</div>
              <div className="ap-betcard-sel">{b.selection || "—"}</div>
              <div className="ap-betcard-stats">
                <div><span>Odds</span><b className="ap-num">{b.odds.toFixed(2)}</b></div>
                <div>
                  <span>CLV</span>
                  <b className="ap-num" style={{ display: "block" }}>
                    <ClvCell
                      betId={b.id}
                      odds={b.odds}
                      closingOdds={b.closingOdds}
                      clvPctValue={b.clvPct}
                      boosted={b.boosted}
                      onSaved={(next) => onClvSaved(b.id, next)}
                    />
                  </b>
                </div>
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


function streakText(s?: StreakInfo): string {
  if (!s || s.currentType === "none" || s.current === 0) return "—";
  const noun = s.currentType === "win" ? (s.current === 1 ? "vinst" : "vinster") : (s.current === 1 ? "förlust" : "förluster");
  return `${s.current} ${noun} i rad`;
}

function streakTone(s?: StreakInfo): "pos" | "neg" | undefined {
  if (!s || s.currentType === "none") return undefined;
  return s.currentType === "win" ? "pos" : "neg";
}
