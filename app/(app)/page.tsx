"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/Shell";
import { Card, Kpi, Skeleton, SkeletonCard, CountUp } from "@/components/ui";
import { InteractiveLineChart, PLBars, Donut, type TimePoint } from "@/components/charts";
import { ResultBadge } from "@/components/ResultBadge";
import { AddBetModal } from "@/components/AddBetModal";
import { SyncButton } from "@/components/SyncButton";
import { TiltBanner } from "@/components/TiltBanner";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics } from "@/lib/useData";
import { api } from "@/lib/fetcher";
import { krFmt, krShort, uFmt, pctFmt, sportTag, dateShort } from "@/lib/format";
import type { BetListDTO } from "@/lib/types";
import type { StreakInfo } from "@/lib/insights";
import { I, IC } from "@/components/icons";
import { useEffect } from "react";

const PERIODS = [
  { key: "all", label: "Allt", days: null },
  { key: "1y", label: "1 år", days: 365 },
  { key: "90d", label: "90 d", days: 90 },
  { key: "30d", label: "30 d", days: 30 },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

export default function OverviewPage() {
  const { cc, glow } = useTheme();
  const { data, settings, loading, reload } = useMetrics();
  const [adding, setAdding] = useState(false);
  const [recent, setRecent] = useState<BetListDTO[]>([]);
  const [period, setPeriod] = useState<PeriodKey>("all");

  // Re-fetch the short list whenever the metrics refresh (a save/settle
  // triggers reload → new data → fresh recent rows).
  useEffect(() => {
    api.get<BetListDTO[]>("/api/bets?limit=7&fields=list").then(setRecent);
  }, [data]);

  const m = data?.metrics;
  const unit = data?.settings.unitValue ?? 100;
  const currency = data?.settings.currency ?? "kr";
  const hasKey = settings?.hasOddsApiKey ?? false;

  // Cumulative P/L in kr (no bankroll framing — the starting-bankroll number
  // was arbitrary, so the chart shows pure result over time instead).
  const curve = (data?.bankroll ?? []).map((p) => p.profitUnits * unit);

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

  // Period P/L: last point vs the period's entry level.
  const periodDiff = pts.length >= 2 ? pts[pts.length - 1].v - pts[0].v : null;

  const profitKr = (m?.profitUnits ?? 0) * unit;

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

  // Per-user header: "Jonatans Betting Journal" for jonatan, etc.
  const username = data?.username;
  const title = username
    ? `${username[0].toUpperCase() + username.slice(1)}s Betting Journal`
    : "Betting Journal";

  return (
    <div>
      {glow && <div className="ap-glow" />}
      <Topbar
        title={title}
        sub={
          loading ? (
            "Laddar…"
          ) : (
            <>Du är {profitKr >= 0 ? "upp" : "ner"} <span className={profitKr >= 0 ? "pos" : "neg"} style={{ fontWeight: 600 }}>{krFmt(Math.abs(profitKr))}</span> {rangeLabel ? `sedan ${rangeLabel}` : "totalt"}</>
          )
        }
        actions={
          <>
            {hasKey && <SyncButton onDone={reload} />}
            <button className="ap-btn" onClick={() => setAdding(true)}>
              <I p={IC.plus} size={15} /> <span className="ap-hide-sm">Logga bet</span>
            </button>
          </>
        }
      />

      {/* Tilt guard — only visible when budgets/chasing trip */}
      {data?.tilt && <TiltBanner tilt={data.tilt} unit={unit} />}

      {/* KPI row */}
      {loading && !data ? (
        <div className="ap-kpi-row">
          <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      ) : (
        <div className="ap-kpi-row">
          <Kpi label="Total P/L" value={<CountUp value={profitKr} format={(n) => krFmt(n, true)} />} valueClass={profitKr >= 0 ? "pos" : "neg"} spark={curve.slice(-16)} />
          <Kpi label="ROI" value={m?.roiPct != null ? <CountUp value={m.roiPct} format={(n) => pctFmt(n, true)} /> : "—"} valueClass={(m?.roiPct ?? 0) >= 0 ? "pos" : "neg"} />
          <Kpi label="+Units" value={<CountUp value={m?.profitUnits ?? 0} format={(n) => uFmt(n, true)} />} valueClass={(m?.profitUnits ?? 0) >= 0 ? "pos" : "neg"} />
          <Kpi label="Win rate" value={m?.winRatePct != null ? <CountUp value={m.winRatePct} format={(n) => pctFmt(n)} /> : "—"} />
        </div>
      )}

      {/* Cumulative P/L + sport donut */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 330px", marginBottom: 12 }}>
        <Card style={{ background: `linear-gradient(180deg, ${cc.fill}, transparent 55%), var(--card)` }}>
          {loading && !data ? (
            <>
              <Skeleton w={90} h={10} />
              <Skeleton w={170} h={30} style={{ marginTop: 12 }} />
              <Skeleton h={184} style={{ marginTop: 16 }} />
            </>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <span className="ap-label">P/L över tid</span>
                  <div className="ap-num" style={{ fontSize: 33, fontWeight: 600, marginTop: 8 }}>
                    <span className={profitKr >= 0 ? "pos" : "neg"}>
                      <CountUp value={profitKr} format={(n) => krFmt(n, true)} />
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>
                    {(m?.settledBets ?? 0).toLocaleString("sv-SE")} avgjorda bets
                    {periodDiff != null && period !== "all" && (
                      <> · perioden <span className={periodDiff >= 0 ? "pos" : "neg"} style={{ fontWeight: 600 }}>{krFmt(periodDiff, true)}</span></>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    {PERIODS.map((p) => (
                      <button
                        key={p.key}
                        className={"ap-chip" + (period === p.key ? " is-active" : "")}
                        onClick={() => setPeriod(p.key)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {visDdKr > 0 && (
                    <span className="ap-pill neg">max drawdown {krShort(-visDdKr, false)}</span>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <InteractiveLineChart
                  points={pts}
                  w={640}
                  h={184}
                  stroke={cc.acc}
                  fill={cc.fill}
                  grid={cc.grid}
                  formatValue={(v) => krFmt(v)}
                />
              </div>
            </>
          )}
        </Card>

        <Card>
          <span className="ap-label">Fördelning per sport</span>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, marginTop: 14 }}>
            <Donut data={sportsWithPct} size={132} thickness={20} colors={cc.palette} track={cc.grid} centerLabel={pctFmt(m?.roiPct ?? null, true)} centerSub="ROI" centerColor={cc.txt} centerSubColor={cc.dim} />
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 9 }}>
              {sportsWithPct.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data än</span>}
              {sportsWithPct.map((s, i) => (
                <div key={s.key} className="ap-leg">
                  <span className="ap-dot" style={{ background: cc.palette[i % cc.palette.length] }} />
                  <span style={{ flex: 1, color: "var(--dim)" }}>{s.key}</span>
                  <span style={{ color: "var(--dim2)" }}>{s.pct}%</span>
                  <span className="ap-num" style={{ width: 54, textAlign: "right", fontWeight: 600 }}>
                    <em className={s.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(s.profitUnits * unit, true)}</em>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Monthly bars + win ring + books */}
      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 200px 310px", marginBottom: 12 }}>
        <Card>
          <span className="ap-label">P/L per månad (units)</span>
          <div style={{ marginTop: 14 }}>
            <PLBars data={months} w={400} h={150} pos={cc.pos} neg={cc.red} labelColor={cc.dim} track={cc.line} />
          </div>
        </Card>
        <Card style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 10 }}>
          <span className="ap-label">Öppen risk</span>
          {risk && risk.bets > 0 ? (
            <>
              <div className="ap-num" style={{ fontSize: 26, fontWeight: 600 }}>{krFmt(risk.stakeUnits * unit)}</div>
              <div style={{ fontSize: 12.5, color: "var(--dim)", lineHeight: 1.5 }}>
                {risk.bets} öppna bets i spel<br />
                Möjlig retur <span className="pos" style={{ fontWeight: 600 }}>{krFmt(risk.potentialReturnUnits * unit)}</span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "var(--dim2)" }}>Inga öppna bets just nu.</div>
          )}
        </Card>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="ap-label">Form &amp; rekord</span>
            <Link href="/insights" className="ap-link">Mer →</Link>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 14 }}>
            <FormRow label="Nuvarande svit" value={streakText(ins?.streaks)} tone={streakTone(ins?.streaks)} />
            <FormRow label="Längsta vinstsvit" value={ins ? `${ins.streaks.longestWin} i rad` : "—"} tone="pos" />
            <FormRow label="Längsta förlustsvit" value={ins ? `${ins.streaks.longestLoss} i rad` : "—"} tone="neg" />
            <FormRow label="Bästa dag" value={ins?.best ? `${krShort(ins.best.profitUnits * unit, true)} · ${dateShort(ins.best.date)}` : "—"} tone="pos" />
            <FormRow label="Sämsta dag" value={ins?.worst ? `${krShort(ins.worst.profitUnits * unit, true)} · ${dateShort(ins.worst.date)}` : "—"} tone="neg" />
            <FormRow label="Snittinsats" value={ins?.avgStakeUnits != null ? `${ins.avgStakeUnits.toFixed(2)}U · ${krFmt(ins.avgStakeUnits * unit)}` : "—"} />
          </div>
        </Card>
      </div>

      {/* Recent bets */}
      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Senaste bets</span>
          <Link href="/bets" className="ap-link">Visa alla →</Link>
        </div>
        <div className="ap-table">
          <div className="ap-thead" style={{ gridTemplateColumns: "66px 50px 1.7fr 1.2fr 100px 58px 76px 84px" }}>
            <span>Datum</span><span>Sport</span><span>Match</span><span className="ap-hide-sm">Spel</span><span className="ap-hide-sm">Bookmaker</span><span className="ap-r">Odds</span><span className="ap-r">Insats</span><span className="ap-r">Resultat</span>
          </div>
          {recent.map((b) => (
            <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: "66px 50px 1.7fr 1.2fr 100px 58px 76px 84px" }}>
              <span style={{ color: "var(--dim)" }}>{dateShort(b.eventAt ?? b.placedAt)}</span>
              <span><span className="ap-tag">{sportTag(b.sport)}</span></span>
              <span className="ap-ell">{b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}</span>
              <span className="ap-ell ap-hide-sm" style={{ color: "var(--dim)" }}>{b.selection || "—"}</span>
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
      </Card>

      <AddBetModal open={adding} onClose={() => setAdding(false)} onSaved={reload} hasOddsApiKey={hasKey} />
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
