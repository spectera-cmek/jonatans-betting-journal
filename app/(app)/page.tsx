"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, Skeleton, SkeletonCard, CountUp, Kpi, PanelHead, SportMark } from "@/components/ui";
import { I, IC } from "@/components/icons";
import { InteractiveLineChart, PLBars, Donut, type TimePoint } from "@/components/charts";
import { ResultBadge } from "@/components/ResultBadge";
import { TiltBanner } from "@/components/TiltBanner";
import { GoalCard } from "@/components/GoalCard";
import { OpenBetsPanel } from "@/components/OpenBetsPanel";
import { BetTags } from "@/components/BetTags";
import { ClvCell, type ClvSaved } from "@/components/ClvCell";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics, useRecentBets } from "@/lib/useData";
import { krFmt, krShort, uFmt, pctFmt, dateShort } from "@/lib/format";
import type { BetListDTO } from "@/lib/types";
import type { StreakInfo } from "@/lib/insights";
import { useEffect } from "react";

const RECENT_GRID = "66px 50px 1.7fr 1.2fr 100px 58px 64px 76px 84px";

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
  // Every KPI reads the selected period, not just the two that used to. The
  // server computes all five windows in one pass, so switching period costs no
  // refetch. Falls back to the all-time metrics until the payload lands.
  const m = data
    ? data.periodMetrics?.[period] ?? { ...data.metrics, drawdown: data.drawdown }
    : undefined;
  const allTime = data?.metrics;
  const profitKr = (m?.profitUnits ?? 0) * unit;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "Hela historiken";
  const showPeriod = period !== "all";

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

  // Max drawdown for the selected period, in kr. Comes from the same
  // maxDrawdown() the API uses everywhere else — this page used to recompute it
  // from the chart's points, so the dashboard and Analys could disagree about
  // what "max drawdown" meant.
  const visDdKr = (m?.drawdown?.maxUnits ?? 0) * unit;

  // ~40 evenly spaced samples of the visible curve for the KPI sparkline.
  const sparkPts = useMemo(() => {
    if (pts.length < 2) return undefined;
    const step = Math.max(1, Math.floor(pts.length / 40));
    const out: number[] = [];
    for (let i = 0; i < pts.length; i += step) out.push(pts[i].v);
    if (out.length && out[out.length - 1] !== pts[pts.length - 1].v) out.push(pts[pts.length - 1].v);
    return out.length > 1 ? out : undefined;
  }, [pts]);

  // Headline P/L and the chart's caption both come from the period metrics, so
  // the number and the count agree. (The chart's own points are still sliced
  // client-side — it is a picture of the curve, not a source of figures.)
  const periodBets = m?.settledBets ?? 0;
  const headlineKr = profitKr;
  // Average stake for the selected period, so this sub-line isn't all-time
  // under a headline that isn't.
  const periodAvgStake = m && m.settledBets > 0 ? m.stakedUnits / m.settledBets : null;

  // sport distribution with pct. Memoised because both of these feed straight
  // into <Donut> / <PLBars>: a fresh array identity on every render made the
  // charts rebuild their geometry even when the underlying data hadn't moved.
  const sportsWithPct = useMemo(() => {
    const sports = data?.bySport ?? [];
    const totalSportBets = sports.reduce((a, s) => a + s.bets, 0) || 1;
    return sports.map((s) => ({ ...s, pct: Math.round((s.bets / totalSportBets) * 100) }));
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

  // The CLV tile shows verified closing prices when there are any, and falls
  // back to the unverified pile — labelled as such — rather than averaging the
  // two into one number that means neither.
  const clv = useMemo(() => {
    const verified = (m?.clvSampleSize ?? 0) > 0;
    return verified
      ? { verified, pct: m?.clvPct ?? null, beat: m?.clvBeatCount ?? 0, sample: m?.clvSampleSize ?? 0 }
      : {
          verified,
          pct: m?.clvUnverifiedPct ?? null,
          beat: m?.clvUnverifiedBeatCount ?? 0,
          sample: m?.clvUnverifiedSampleSize ?? 0,
        };
  }, [m]);

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

  return (
    <div className="ap-dashboard">
      {glow && <div className="ap-glow" />}
      <header className="ap-terminal-head">
        <div>
          <h1>{title}</h1>
          <p>{allTime?.totalBets?.toLocaleString("sv-SE") ?? 0} bets · {rangeLabel ? `${rangeLabel}` : "ingen historik"}</p>
        </div>
        <div className="ap-terminal-status">
          <span>Portfölj</span>
          <strong>{risk ? krFmt(risk.stakeUnits * unit) : "—"} exponerat</strong>
        </div>
      </header>

      {/* Tilt guard — only visible when budgets/chasing trip */}
      {data?.tilt && <TiltBanner tilt={data.tilt} unit={unit} />}

      {/* Six KPI cards: one saturated hue each, sparkline where a trend exists */}
      <section className="ap-kpi-grid">
        {loading && !data
          ? Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} />)
          : (
            <>
              <Kpi
                label="Nettoresultat"
                accent={headlineKr >= 0 ? "emerald" : "red"}
                icon={IC.coins}
                value={<CountUp value={headlineKr} format={(n) => krFmt(n, true)} />}
                spark={sparkPts}
                trend={periodLabel}
                trendTone={headlineKr >= 0 ? "pos" : "neg"}
                meta={`${uFmt(m?.profitUnits ?? 0, true)}`}
              />
              <Kpi
                label="ROI"
                accent={(m?.roiPct ?? 0) >= 0 ? "sky" : "red"}
                icon={IC.percent}
                hint="Avkastning på insatt kapital: nettoresultat delat med totalt insatt belopp på avgjorda spel."
                value={pctFmt(m?.roiPct ?? null, true)}
                trend={`${krShort((m?.stakedUnits ?? 0) * unit, false)} insatt`}
                trendTone="flat"
              />
              <Kpi
                label="Träffprocent"
                accent="amber"
                icon={IC.flame}
                value={pctFmt(m?.winRatePct ?? null)}
                trend={streakText(ins?.streaks)}
                trendTone={streakTone(ins?.streaks) ?? "flat"}
                meta={`${m?.wins ?? 0}V · ${m?.losses ?? 0}F`}
              />
              <Kpi
                label={clv.verified ? "CLV" : "CLV (overifierad)"}
                accent="teal"
                icon={IC.target}
                hint={
                  clv.verified
                    ? "Closing line value: hur mycket bättre ditt odds var än stängningsoddset. Att slå stängningen över tid är den bästa indikatorn på edge."
                    : "Inga spel har ännu ett stängningspris som appen själv hämtat. Talet nedan jämför mot priser vars ursprung inte går att belägga — främst importerade fair odds. Se Analys för uppdelningen."
                }
                value={pctFmt(clv.pct, true)}
                trend={
                  clv.sample
                    ? `${Math.round((clv.beat / clv.sample) * 100)} % ${clv.verified ? "slår stängning" : "bättre än priset"}`
                    : "Ingen stängningsdata"
                }
                trendTone={clv.verified && (clv.pct ?? 0) > 0 ? "pos" : "flat"}
                meta={clv.sample ? `${clv.sample} spel` : undefined}
              />
              <Kpi
                label="Medianodds"
                accent="pink"
                icon={IC.scale}
                hint="Medianodds på avgjorda spel. Medianen, inte snittet: en handfull bet builder-spel prissatta över 1000 drar upp medelvärdet så att det slutar beskriva vad du faktiskt spelar. Spel med placeholder-odds 1,01 räknas inte."
                value={m?.medianOdds != null ? m.medianOdds.toFixed(2) : "—"}
                trend={periodAvgStake != null ? `${periodAvgStake.toFixed(2)}U snittinsats` : "—"}
                trendTone="flat"
              />
              <Kpi
                label="Max drawdown"
                accent="purple"
                icon={IC.trendDown}
                hint="Största fall från en topp till efterföljande botten inom vald period."
                value={visDdKr > 0 ? krShort(-visDdKr, false) : "—"}
                trend={periodLabel}
                trendTone="flat"
                meta={`${(m?.totalBets ?? 0).toLocaleString("sv-SE")} spel`}
              />
            </>
          )}
      </section>

      {/* Cumulative performance */}
      <Card className="ap-chartcard">
        <PanelHead
          icon={IC.chart}
          accent="emerald"
          title="Resultatutveckling"
          sub={`${periodBets.toLocaleString("sv-SE")} avgjorda · ${showPeriod ? periodLabel : "hela perioden"}`}
          actions={
            <div className="ap-seg">
              {PERIODS.map((p) => (
                <button key={p.key} className={period === p.key ? "is-active" : ""} onClick={() => setPeriod(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
          }
        />
        {loading && !data ? (
          <Skeleton h={220} />
        ) : (
          <InteractiveLineChart
            points={pts}
            w={1180}
            h={220}
            stroke={cc.acc}
            fill={cc.fill}
            grid={cc.grid}
            formatValue={(v) => krFmt(v)}
          />
        )}
      </Card>

      {/* Open risk is the primary actionable section. */}
      {data && risk && (
        <OpenBetsPanel open={data.openBets ?? []} risk={risk} unit={unit} onClvSaved={onClvSaved} onSettled={reload} />
      )}

      <div className="ap-section-rule">
        <span>02</span>
        <strong>Resultatfördelning</strong>
        <em>Utveckling per månad och sport</em>
      </div>

      {/* Monthly bars + sport mix */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 360px", marginBottom: 16 }}>
        <Card>
          <PanelHead icon={IC.bars} accent="sky" title="P/L per månad" sub="Resultat i units, senaste månaderna" />
          <PLBars data={months} w={400} h={150} pos={cc.pos} neg={cc.red} labelColor={cc.dim} track={cc.line} />
        </Card>
        <Card>
          <PanelHead icon={IC.pie} accent="purple" title="Fördelning per sport" sub="Andel av alla spel" />
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Donut data={sportsWithPct} size={116} thickness={19} colors={cc.palette} track={cc.grid} centerLabel={String(m?.totalBets ?? 0)} centerSub="SPEL" centerColor={cc.txt} centerSubColor={cc.dim} />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {sportsWithPct.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data än</span>}
              {sportsWithPct.slice(0, 5).map((s, i) => (
                <div key={s.key} className="ap-legrow">
                  <span className="ap-dot" style={{ background: cc.palette[i % cc.palette.length] }} />
                  <span className="ap-ell" style={{ flex: 1, color: "var(--dim)" }}>{s.key}</span>
                  <span className="ap-num" style={{ fontWeight: 700 }}>{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <Card>
          <PanelHead icon={IC.flame} accent="amber" title="Form &amp; rekord" sub="Sviter över hela historiken" />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <FormRow label="Nuvarande svit" value={streakText(ins?.streaks)} tone={streakTone(ins?.streaks)} />
            <FormRow label="Längsta vinstsvit" value={ins ? `${ins.streaks.longestWin} i rad` : "—"} tone="pos" />
            <FormRow label="Längsta förlustsvit" value={ins ? `${ins.streaks.longestLoss} i rad` : "—"} tone="neg" />
          </div>
        </Card>
        <Card>
          <PanelHead
            icon={IC.award}
            accent="teal"
            title="Extremer &amp; insats"
            sub="Bästa och sämsta dagarna"
            actions={<Link href="/insights" className="ap-link">Mer →</Link>}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div className="ap-card-head">
          <span className="ap-card-title">
            <span className="ap-chip-icon is-sm is-emerald" aria-hidden="true"><I p={IC.ticket} size={13} /></span>
            Senaste bets
          </span>
          <Link href="/bets" className="ap-link">Visa alla →</Link>
        </div>
        <div className="ap-table-wrap">
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: RECENT_GRID }}>
              <span>Datum</span><span>Sport</span><span>Match</span><span className="ap-hide-sm">Spel</span><span className="ap-hide-sm">Bookmaker</span><span className="ap-r">Odds</span><span className="ap-r">CLV</span><span className="ap-r">Insats</span><span className="ap-r">Resultat</span>
            </div>
            {recent.map((b) => (
              <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: RECENT_GRID }}>
                <span style={{ color: "var(--dim)" }} className="ap-num">{dateShort(b.eventAt ?? b.placedAt)}</span>
                <span style={{ minWidth: 0 }}><SportMark sport={b.sport} /></span>
                <span className="ap-ell">{b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}</span>
                <span className="ap-hide-sm" style={{ color: "var(--dim)", minWidth: 0 }}>
                  <span className="ap-ell" style={{ display: "block" }}>{b.selection || "—"}</span>
                  <BetTags bet={b} compact hideSport />
                </span>
                <span className="ap-hide-sm" style={{ color: "var(--dim)" }}>{b.bookmaker || "—"}</span>
                <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                <span className="ap-r">
                  <ClvCell
                    betId={b.id}
                    odds={b.odds}
                    closingOdds={b.closingOdds}
                    clvPctValue={b.clvPct}
                    onSaved={(next) => onClvSaved(b.id, next)}
                  />
                </span>
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
                <span className="ap-betcard-date"><SportMark sport={b.sport} /> <span className="ap-num">{dateShort(b.eventAt ?? b.placedAt)}</span></span>
                <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
              </div>
              <div className="ap-betcard-event">{b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}</div>
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

// One label/value line in the "Form & rekord" card.
function FormRow({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="ap-legrow">
      <span style={{ flex: 1, color: "var(--dim)" }}>{label}</span>
      <span className="ap-num" style={{ fontWeight: 700 }}>
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
