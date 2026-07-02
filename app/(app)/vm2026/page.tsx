"use client";

import { Fragment, useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty, SkeletonCard } from "@/components/ui";
import { InteractiveLineChart, Donut } from "@/components/charts";
import { ResultBadgeKr } from "@/components/ResultBadge";
import { StatTile, BreakdownCard, LeaderboardCard } from "@/components/stats";
import { useTheme } from "@/components/ThemeProvider";
import { useBets } from "@/lib/useData";
import { uFmt, pctFmt, krShort, krFmt, dateShort } from "@/lib/format";
import {
  computeMetrics,
  breakdownBy,
  bankrollSeries,
  topBetsByProfit,
  settledProfit,
  singleRoiPct,
} from "@/lib/betting";
import type { BetListDTO } from "@/lib/types";
import { I, IC } from "@/components/icons";

// A bet counts as a World Cup 2026 bet when it carries the explicit league tag
// "VM 2026". Tag/untag any bet from the bets list (🏆) or the add/edit modal — this
// is fully manual so it tracks exactly what you decide, across every bookmaker/sport.
const VM_TAG = "VM 2026";

function isWorldCup(b: BetListDTO): boolean {
  return (b.league ?? "").trim() === VM_TAG;
}

// The shared LeaderboardCard renders metrics-API entries; map the locally
// filtered list rows into the same shape.
function toLeaderboardEntry(b: BetListDTO) {
  return {
    id: b.id,
    event: b.event,
    selection: b.selection ?? "",
    sport: b.sport,
    league: b.league,
    bookmaker: b.bookmaker,
    eventAt: (b.eventAt ?? b.placedAt) as string,
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    profitUnits: settledProfit(b),
    roiPct: singleRoiPct(b),
  };
}

// Individual bets for one match — rendered when a "Per match" row is expanded.
function MatchDetail({ bets, unit }: { bets: BetListDTO[]; unit: number }) {
  const sorted = [...bets].sort((a, b) => (b.profitUnits ?? 0) - (a.profitUnits ?? 0));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }} onClick={(e) => e.stopPropagation()}>
      {sorted.map((b) => (
        <div
          key={b.id}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", background: "var(--card2)", borderRadius: 10 }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.35 }}>{b.selection || "—"}</div>
            <div style={{ fontSize: 11, color: "var(--dim2)", marginTop: 3 }}>
              {b.bookmaker ? `${b.bookmaker} · ` : ""}
              {b.betType === "accumulator" ? "ack · " : ""}odds {b.odds.toFixed(2)} · insats {uFmt(b.stakeUnits)}
            </div>
          </div>
          <div style={{ flexShrink: 0, textAlign: "right" }}>
            <ResultBadgeKr outcome={b.outcome} profitKr={(b.profitUnits ?? 0) * unit} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WorldCupPage() {
  const { cc } = useTheme();
  const { bets, settings, loading } = useBets();
  const unit = settings?.unitValue ?? 100;
  const [expanded, setExpanded] = useState<string | null>(null);

  const wc = useMemo(() => bets.filter(isWorldCup), [bets]);
  const metrics = useMemo(() => computeMetrics(wc), [wc]);

  // Cumulative profit (kr) over the tournament, one step per settled bet.
  const points = useMemo(() => {
    const series = bankrollSeries(wc, 0);
    return series.map((p) => ({ t: Date.parse(p.date), v: p.profitUnits * unit }));
  }, [wc, unit]);

  const byMarketDetail = useMemo(() => breakdownBy(wc, (b) => (b as BetListDTO).marketCategory, "Okänd"), [wc]);
  const byScope = useMemo(
    () =>
      breakdownBy(
        wc,
        (b) => {
          const sc = (b as BetListDTO).marketScope;
          return sc === "player" ? "Spelare" : sc === "team" ? "Lag" : sc === "match" ? "Match (totalt)" : null;
        },
        "Okänd"
      ),
    [wc]
  );
  const byType = useMemo(
    () => breakdownBy(wc, (b) => ((b as BetListDTO).betType === "accumulator" ? "Ackumulator / Bet Builder" : "Singel")),
    [wc]
  );

  // Per-match results, chronological.
  const perMatch = useMemo(() => {
    const map = new Map<string, BetListDTO[]>();
    for (const b of wc) {
      const arr = map.get(b.event);
      if (arr) arr.push(b);
      else map.set(b.event, [b]);
    }
    return [...map.entries()]
      .map(([event, group]) => {
        const m = computeMetrics(group);
        const t = Math.min(...group.map((g) => Date.parse((g.eventAt ?? g.placedAt) as string)));
        return { event, t, count: group.length, bets: group, profitUnits: m.profitUnits, roiPct: m.roiPct, winRatePct: m.winRatePct, pending: m.pendingBets };
      })
      .sort((a, b) => a.t - b.t);
  }, [wc]);

  const wins = useMemo(() => topBetsByProfit(wc, "win", 5), [wc]);
  const losses = useMemo(() => topBetsByProfit(wc, "loss", 5), [wc]);

  const outcomes = [
    { name: "Vunna", v: metrics.wins, pct: metrics.settledBets ? (metrics.wins / metrics.settledBets) * 100 : 0 },
    { name: "Förlorade", v: metrics.losses, pct: metrics.settledBets ? (metrics.losses / metrics.settledBets) * 100 : 0 },
    { name: "Push/Void", v: metrics.pushVoid, pct: metrics.settledBets ? (metrics.pushVoid / metrics.settledBets) * 100 : 0 },
    { name: "Öppna", v: metrics.pendingBets, pct: metrics.totalBets ? (metrics.pendingBets / metrics.totalBets) * 100 : 0 },
  ];
  const outColors = [cc.pos, cc.red, cc.acc, cc.dim];

  if (loading && bets.length === 0) {
    return (
      <div>
        <Topbar title="VM 2026" sub="Laddar…" icon={<I p={IC.trophy} />} />
        <div className="ap-kpi-row"><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
        <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 330px" }}><SkeletonCard chartH={200} /><SkeletonCard chartH={200} /></div>
      </div>
    );
  }

  if (!loading && wc.length === 0) {
    return (
      <div>
        <Topbar title="VM 2026" sub="Fotbolls-VM 11 juni – 19 juli 2026" icon={<I p={IC.trophy} />} />
        <Card>
          <Empty
            icon={<I p={IC.trophy} />}
            title="Inga VM-bets taggade ännu"
            hint='Markera ett spel som VM genom att klicka på 🏆 i bets-listan, eller sätt liga till "VM 2026" när du loggar.'
          />
        </Card>
      </div>
    );
  }

  const span =
    perMatch.length > 0
      ? `${dateShort(new Date(perMatch[0].t).toISOString())} – ${dateShort(new Date(perMatch[perMatch.length - 1].t).toISOString())}`
      : "";

  return (
    <div>
      <Topbar title="VM 2026" sub={`${wc.length} bets${span ? ` · ${span}` : ""} · fotbolls-VM`} icon={<I p={IC.trophy} />} />

      <div className="ap-kpi-row">
        <StatTile
          label="P/L"
          value={krFmt(metrics.profitUnits * unit, true)}
          sub={`${uFmt(metrics.profitUnits, true)} · insats ${krShort(metrics.stakedUnits * unit)}`}
          tone={metrics.profitUnits >= 0 ? "pos" : "neg"}
        />
        <StatTile label="ROI" value={pctFmt(metrics.roiPct, true)} sub={`${metrics.settledBets} avgjorda`} tone={(metrics.roiPct ?? 0) >= 0 ? "pos" : "neg"} />
        <StatTile label="Win rate" value={pctFmt(metrics.winRatePct)} sub={`${metrics.wins}V · ${metrics.losses}F`} />
        <StatTile label="Öppna spel" value={String(metrics.pendingBets)} sub={metrics.pendingBets ? "väntar på avgörande" : "alla avgjorda"} />
      </div>

      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 330px", marginBottom: 12 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <span className="ap-label">Ackumulerad P/L under turneringen</span>
            <span className="ap-num" style={{ fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <span className={metrics.profitUnits >= 0 ? "pos" : "neg"}>{krFmt(metrics.profitUnits * unit, true)}</span>
            </span>
          </div>
          <div style={{ marginTop: 16 }}>
            <InteractiveLineChart
              points={points}
              w={640}
              h={200}
              stroke={metrics.profitUnits >= 0 ? cc.acc : cc.red}
              fill={cc.fill}
              grid={cc.grid}
              formatValue={(v) => krFmt(v, true)}
            />
          </div>
        </Card>

        <Card>
          <span className="ap-label">Utfall</span>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, marginTop: 14 }}>
            <Donut data={outcomes} size={132} thickness={20} colors={outColors} track={cc.grid} centerLabel={pctFmt(metrics.winRatePct)} centerSub="WIN RATE" centerColor={cc.txt} centerSubColor={cc.dim} />
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 9 }}>
              {outcomes.map((o, i) => (
                <div key={o.name} className="ap-leg">
                  <span className="ap-dot" style={{ background: outColors[i] }} />
                  <span style={{ flex: 1, color: "var(--dim)" }}>{o.name}</span>
                  <span className="ap-num" style={{ fontWeight: 600 }}>{o.v}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Per match */}
      <Card style={{ padding: 0, marginBottom: 12 }}>
        <div className="ap-card-head"><span className="ap-card-title">Per match</span><span style={{ color: "var(--dim2)", fontSize: 12 }}>{perMatch.length} matcher · klicka för spel</span></div>
        <div className="ap-table-wrap">
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "70px 1fr 70px 120px 90px 90px" }}>
              <span>Datum</span><span>Match</span><span className="ap-r">Bets</span><span className="ap-r">P/L</span><span className="ap-r">ROI</span><span className="ap-r">Win rate</span>
            </div>
            {perMatch.map((mm) => {
              const open = expanded === mm.event;
              return (
                <Fragment key={mm.event}>
                  <div
                    className="ap-trow"
                    style={{ gridTemplateColumns: "70px 1fr 70px 120px 90px 90px", cursor: "pointer" }}
                    onClick={() => setExpanded(open ? null : mm.event)}
                    role="button"
                    aria-expanded={open}
                  >
                    <span style={{ color: "var(--dim)" }}>{dateShort(new Date(mm.t).toISOString())}</span>
                    <span className="ap-ell">
                      <span style={{ color: "var(--dim2)", display: "inline-block", width: 12 }}>{open ? "▾" : "▸"}</span>
                      {mm.event}{mm.pending ? <span style={{ color: "var(--dim2)" }}> · {mm.pending} öppna</span> : null}
                    </span>
                    <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{mm.count}</span>
                    <span className="ap-r ap-num" style={{ fontWeight: 600 }}><em className={mm.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(mm.profitUnits * unit, true)}</em> <span style={{ color: "var(--dim2)" }}>{uFmt(mm.profitUnits, true)}</span></span>
                    <span className="ap-r ap-num"><em className={(mm.roiPct ?? 0) >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{pctFmt(mm.roiPct, true)}</em></span>
                    <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{pctFmt(mm.winRatePct)}</span>
                  </div>
                  {open && (
                    <div style={{ padding: "2px 20px 14px 36px", borderBottom: "1px solid var(--line2)" }}>
                      <MatchDetail bets={mm.bets} unit={unit} />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
        {/* Mobile: stacked cards so P/L, ROI and win rate stay visible without sideways scroll. */}
        <div className="ap-betcards" style={{ padding: "12px 14px 14px" }}>
          {perMatch.map((mm) => {
            const open = expanded === mm.event;
            return (
              <div
                key={mm.event}
                className="ap-betcard"
                style={{ cursor: "pointer" }}
                onClick={() => setExpanded(open ? null : mm.event)}
                role="button"
                aria-expanded={open}
              >
                <div className="ap-betcard-top">
                  <span className="ap-betcard-date">
                    {dateShort(new Date(mm.t).toISOString())}
                    {mm.pending ? <span style={{ color: "var(--dim2)" }}> · {mm.pending} öppna</span> : null}
                  </span>
                  <b className={"ap-num " + (mm.profitUnits >= 0 ? "pos" : "neg")} style={{ fontWeight: 700, fontSize: 15 }}>{krShort(mm.profitUnits * unit, true)}</b>
                </div>
                <div className="ap-betcard-event"><span style={{ color: "var(--dim2)" }}>{open ? "▾ " : "▸ "}</span>{mm.event}</div>
                <div className="ap-betcard-stats">
                  <div><span>Bets</span><b className="ap-num">{mm.count}</b></div>
                  <div><span>ROI</span><b className={"ap-num " + ((mm.roiPct ?? 0) >= 0 ? "pos" : "neg")}>{pctFmt(mm.roiPct, true)}</b></div>
                  <div><span>Win rate</span><b className="ap-num">{pctFmt(mm.winRatePct)}</b></div>
                </div>
                {open && (
                  <div style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--line2)" }}>
                    <MatchDetail bets={mm.bets} unit={unit} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="P/L per marknad" rows={byMarketDetail} unit={unit} />
        <BreakdownCard title="Spelare / lag / match" rows={byScope} unit={unit} />
        <BreakdownCard title="Singel vs ackumulator" rows={byType} unit={unit} />
      </div>

      {/* Biggest wins / losses */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <LeaderboardCard title="Största vinster 🏆" sub="under turneringen" entries={wins.map(toLeaderboardEntry)} unit={unit} />
        <LeaderboardCard title="Största förluster 💀" sub="under turneringen" entries={losses.map(toLeaderboardEntry)} unit={unit} />
      </div>
    </div>
  );
}
