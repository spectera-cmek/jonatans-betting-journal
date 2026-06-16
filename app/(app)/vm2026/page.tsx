"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty, SkeletonCard } from "@/components/ui";
import { InteractiveLineChart, Donut, HBar } from "@/components/charts";
import { useTheme } from "@/components/ThemeProvider";
import { useBets } from "@/lib/useData";
import { uFmt, pctFmt, krShort, krFmt, dateShort } from "@/lib/format";
import {
  computeMetrics,
  breakdownBy,
  bankrollSeries,
  topBetsByProfit,
  type BetLike,
  type Breakdown,
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

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="ap-card ap-lift">
      <span className="ap-label">{label}</span>
      <div className="ap-num ap-kpi-val"><span className={tone || ""}>{value}</span></div>
      {sub && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function BreakdownCard({ title, rows, unit }: { title: string; rows: Breakdown[]; unit: number }) {
  const { cc } = useTheme();
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.profitUnits)));
  return (
    <Card>
      <span className="ap-label">{title}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
        {rows.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data</span>}
        {rows.map((r) => (
          <div key={r.key}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span>{r.key} <span style={{ color: "var(--dim2)", fontSize: 12 }}>· {r.bets} bets{r.winRatePct != null ? ` · ${pctFmt(r.winRatePct)}` : ""}</span></span>
              <span className="ap-num" style={{ fontWeight: 600 }}>
                <em className={r.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(r.profitUnits * unit, true)}</em>
                <span style={{ color: "var(--dim2)", marginLeft: 8 }}>{pctFmt(r.roiPct, true)}</span>
              </span>
            </div>
            <HBar pct={Math.max((Math.abs(r.profitUnits) / max) * 100, 3)} color={r.profitUnits >= 0 ? cc.acc : cc.red} track={cc.grid} h={7} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function WorldCupPage() {
  const { cc } = useTheme();
  const { bets, settings, loading } = useBets();
  const unit = settings?.unitValue ?? 100;

  const wc = useMemo(() => bets.filter(isWorldCup), [bets]);
  const metrics = useMemo(() => computeMetrics(wc), [wc]);

  // Cumulative profit (kr) over the tournament, one step per settled bet.
  const points = useMemo(() => {
    const series = bankrollSeries(wc, 0);
    return series.map((p) => ({ t: Date.parse(p.date), v: p.profitUnits * unit }));
  }, [wc, unit]);

  const byMarket = useMemo(() => breakdownBy(wc, (b) => (b as BetListDTO).market), [wc]);
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
        return { event, t, count: group.length, profitUnits: m.profitUnits, roiPct: m.roiPct, winRatePct: m.winRatePct, pending: m.pendingBets };
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
        <Topbar title="VM 2026 🏆" sub="Laddar…" />
        <div className="ap-kpi-row"><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
        <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 330px" }}><SkeletonCard chartH={200} /><SkeletonCard chartH={200} /></div>
      </div>
    );
  }

  if (!loading && wc.length === 0) {
    return (
      <div>
        <Topbar title="VM 2026 🏆" sub="Fotbolls-VM 11 juni – 19 juli 2026" />
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
      <Topbar title="VM 2026 🏆" sub={`${wc.length} bets${span ? ` · ${span}` : ""} · fotbolls-VM`} />

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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="ap-label">Ackumulerad P/L under turneringen</span>
            <span className="ap-num" style={{ fontWeight: 600 }}>
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
        <div className="ap-card-head"><span className="ap-card-title">Per match</span><span style={{ color: "var(--dim2)", fontSize: 12 }}>{perMatch.length} matcher</span></div>
        <div className="ap-table">
          <div className="ap-thead" style={{ gridTemplateColumns: "70px 1fr 70px 120px 90px 90px" }}>
            <span>Datum</span><span>Match</span><span className="ap-r">Bets</span><span className="ap-r">P/L</span><span className="ap-r">ROI</span><span className="ap-r">Win rate</span>
          </div>
          {perMatch.map((mm) => (
            <div key={mm.event} className="ap-trow" style={{ gridTemplateColumns: "70px 1fr 70px 120px 90px 90px" }}>
              <span style={{ color: "var(--dim)" }}>{dateShort(new Date(mm.t).toISOString())}</span>
              <span className="ap-ell">{mm.event}{mm.pending ? <span style={{ color: "var(--dim2)" }}> · {mm.pending} öppna</span> : null}</span>
              <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{mm.count}</span>
              <span className="ap-r ap-num" style={{ fontWeight: 600 }}><em className={mm.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(mm.profitUnits * unit, true)}</em> <span style={{ color: "var(--dim2)" }}>{uFmt(mm.profitUnits, true)}</span></span>
              <span className="ap-r ap-num"><em className={(mm.roiPct ?? 0) >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{pctFmt(mm.roiPct, true)}</em></span>
              <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{pctFmt(mm.winRatePct)}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="P/L per marknad" rows={byMarket} unit={unit} />
        <BreakdownCard title="Singel vs ackumulator" rows={byType} unit={unit} />
      </div>

      {/* Biggest wins / losses */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {([["Största vinster 🏆", wins], ["Största förluster 💀", losses]] as const).map(([title, list]) => (
          <Card key={title}>
            <span className="ap-label">{title}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
              {list.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data</span>}
              {list.map((b, i) => {
                const p = (b.profitUnits ?? 0) * unit;
                return (
                  <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="ap-num" style={{ width: 16, textAlign: "center", color: "var(--dim2)", fontWeight: 700, fontSize: 13 }}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="ap-ell" style={{ fontSize: 13 }}>{b.event}</div>
                      <div className="ap-ell" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 2 }}>{b.selection || "—"}</div>
                      <div className="ap-ell" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 3 }}>{dateShort(b.eventAt ?? b.placedAt)} · odds {b.odds.toFixed(2)} · insats {uFmt(b.stakeUnits)}</div>
                    </div>
                    <div className="ap-num" style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                      <em className={p >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krFmt(p, true)}</em>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
