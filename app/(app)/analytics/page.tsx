"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, SkeletonCard, SectionHead } from "@/components/ui";
import { LineChart, Donut } from "@/components/charts";
import { StatTile, BreakdownCard, PerfCards, LeaderboardCard, BookmakerTable } from "@/components/stats";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics } from "@/lib/useData";
import { uFmt, pctFmt, krShort, krFmt } from "@/lib/format";
import type { Breakdown } from "@/lib/betting";
import { I, IC } from "@/components/icons";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
function monthLabel(ym: string): string {
  const [, m] = ym.split("-");
  return MONTH_NAMES[Number(m) - 1] ?? ym;
}

export default function AnalyticsPage() {
  const { cc } = useTheme();
  const { data, loading } = useMetrics();
  const m = data?.metrics;
  const ins = data?.insights;
  const dd = data?.drawdown;
  const unit = data?.settings.unitValue ?? 100;

  const roiCurve = (data?.monthly ?? []).map((mo) => mo.roiPct ?? 0);
  const months = data?.monthly ?? [];
  const byYear = data?.byYear ?? [];
  const byMonth = data?.byMonth ?? [];

  // Years present, newest first; selector for the monthly table.
  const years = useMemo(
    () => Array.from(new Set(byMonth.map((mo) => mo.month.slice(0, 4)))).sort((a, b) => b.localeCompare(a)),
    [byMonth]
  );
  const [year, setYear] = useState<string>("");
  const activeYear = year || years[0] || "";
  const monthRows = useMemo(
    () => byMonth.filter((mo) => mo.month.startsWith(activeYear)).reverse(),
    [byMonth, activeYear]
  );
  const rangeLabel = years.length ? `${years[years.length - 1]}–${years[0]}` : "";

  // Best/worst calendar month over the full history (for the KPI row).
  const bestMonth = useMemo(
    () => (byMonth.length ? byMonth.reduce((a, b) => (b.profitUnits > a.profitUnits ? b : a)) : null),
    [byMonth]
  );
  const worstMonth = useMemo(
    () => (byMonth.length ? byMonth.reduce((a, b) => (b.profitUnits < a.profitUnits ? b : a)) : null),
    [byMonth]
  );

  const outcomes = m
    ? [
        { name: "Vunna", v: m.wins, pct: m.settledBets ? (m.wins / m.settledBets) * 100 : 0 },
        { name: "Förlorade", v: m.losses, pct: m.settledBets ? (m.losses / m.settledBets) * 100 : 0 },
        { name: "Push/Void", v: m.pushVoid, pct: m.settledBets ? (m.pushVoid / m.settledBets) * 100 : 0 },
        { name: "Öppna", v: m.pendingBets, pct: m.totalBets ? (m.pendingBets / m.totalBets) * 100 : 0 },
      ]
    : [];
  const outColors = [cc.pos, cc.red, cc.acc, cc.dim];

  const oddsBands: Breakdown[] = (data?.oddsBands ?? []).map((o) => ({
    key: o.label,
    bets: o.bets,
    settled: 0,
    stakedUnits: 0,
    profitUnits: o.profitUnits,
    roiPct: o.roiPct,
    avgOdds: null,
    winRatePct: o.winRatePct,
  }));

  if (loading && !data) {
    return (
      <div>
        <Topbar title="Analys" sub="Laddar…" icon={<I p={IC.chart} />} />
        <div className="ap-kpi-row">
          <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
        <div className="ap-kpi-row">
          <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
        <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SkeletonCard chartH={150} />
          <SkeletonCard chartH={150} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <Topbar title="Analys" sub={`${m?.totalBets ?? 0} bets · ${rangeLabel}`} icon={<I p={IC.chart} />} />

      <div className="ap-kpi-row">
        <StatTile label="Total P/L" value={uFmt(m?.profitUnits ?? null, true)} sub={`ROI ${pctFmt(m?.roiPct ?? null, true)}`} tone={(m?.profitUnits ?? 0) >= 0 ? "pos" : "neg"} />
        <StatTile label="Win rate" value={pctFmt(m?.winRatePct ?? null)} sub={`${m?.wins ?? 0}V · ${m?.losses ?? 0}F`} />
        <StatTile label="Snittodds" value={(m?.avgOdds ?? 0).toFixed(2)} sub={`${m?.settledBets ?? 0} avgjorda`} />
        <StatTile label="Snittinsats" value={ins?.avgStakeUnits != null ? `${ins.avgStakeUnits.toFixed(2)}U` : "—"} sub={ins?.avgStakeUnits != null ? krFmt(ins.avgStakeUnits * unit) : "ingen data"} />
      </div>

      <div className="ap-kpi-row">
        <StatTile
          label="Max drawdown"
          value={dd ? `−${krShort(dd.maxUnits * unit)}` : "—"}
          sub={dd ? `största tapp från toppen · ${uFmt(-dd.maxUnits, true)}` : "största tapp från toppen"}
          tone="neg"
        />
        <StatTile
          label="Omsatt"
          value={m ? krShort(m.stakedUnits * unit) : "—"}
          sub={m ? `${uFmt(m.stakedUnits)} över ${m.settledBets} avgjorda` : "ingen data"}
        />
        <StatTile
          label="Bästa månad"
          value={bestMonth ? krShort(bestMonth.profitUnits * unit, true) : "—"}
          sub={bestMonth ? `${monthLabel(bestMonth.month)} ${bestMonth.month.slice(0, 4)} · ${bestMonth.bets} bets` : "ingen data"}
          tone="pos"
        />
        <StatTile
          label="Sämsta månad"
          value={worstMonth ? krShort(worstMonth.profitUnits * unit, true) : "—"}
          sub={worstMonth ? `${monthLabel(worstMonth.month)} ${worstMonth.month.slice(0, 4)} · ${worstMonth.bets} bets` : "ingen data"}
          tone="neg"
        />
      </div>

      <SectionHead icon={<I p={IC.chart} />} title="Utveckling" sub="CLV, år och trend" />

      {/* CLV — closing line value */}
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <span className="ap-label">Closing line value (CLV)</span>
          <span style={{ color: "var(--dim2)", fontSize: 11 }}>
            {m && m.clvSampleSize > 0 ? `${m.clvSampleSize} bets med stängningsodds` : "kräver TheStatsAPI eller Odds API"}
          </span>
        </div>
        {m && m.clvSampleSize > 0 ? (
          <div style={{ display: "flex", gap: 36, flexWrap: "wrap" }}>
            <div>
              <div className="ap-num ap-kpi-val" style={{ marginTop: 0 }}>
                <span className={(m.clvPct ?? 0) >= 0 ? "pos" : "neg"}>{pctFmt(m.clvPct, true)}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>Snitt-CLV</div>
            </div>
            <div>
              <div className="ap-num ap-kpi-val" style={{ marginTop: 0 }}>
                {pctFmt((m.clvBeatCount / m.clvSampleSize) * 100)}
              </div>
              <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>
                Slog stängningsoddset · {m.clvBeatCount}/{m.clvSampleSize}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--dim2)", fontSize: 13, lineHeight: 1.5, maxWidth: 560 }}>
            Inga stängningsodds insamlade än. CLV mäter om du tog bättre odds än marknadens
            stängningsodds — den starkaste enskilda indikatorn på edge. Lägg till en TheStatsAPI-
            eller Odds API-nyckel under Inställningar och kör synk så hämtas closing-odds automatiskt.
          </div>
        )}
      </Card>

      {/* Per år */}
      <Card style={{ padding: 0, marginBottom: 12 }}>
        <div className="ap-card-head"><span className="ap-card-title">Per år</span><span style={{ color: "var(--dim2)", fontSize: 12 }}>{rangeLabel}</span></div>
        <div className="ap-table-wrap">
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "1fr 90px 120px 90px 90px" }}>
              <span>År</span><span className="ap-r">Bets</span><span className="ap-r">P/L</span><span className="ap-r">ROI</span><span className="ap-r">Win rate</span>
            </div>
            {byYear.length === 0 && <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--dim2)" }}>Ingen data än.</div>}
            {byYear.map((y) => (
              <div key={y.key} className="ap-trow" style={{ gridTemplateColumns: "1fr 90px 120px 90px 90px" }}>
                <span style={{ fontWeight: 600 }}>{y.key}</span>
                <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{y.bets}</span>
                <span className="ap-r ap-num" style={{ fontWeight: 600 }}><em className={y.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(y.profitUnits * unit, true)}</em> <span style={{ color: "var(--dim2)" }}>{uFmt(y.profitUnits, true)}</span></span>
                <span className="ap-r ap-num"><em className={(y.roiPct ?? 0) >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{pctFmt(y.roiPct, true)}</em></span>
                <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{pctFmt(y.winRatePct)}</span>
              </div>
            ))}
          </div>
        </div>
        {byYear.length > 0 && (
          <PerfCards rows={byYear.map((y) => ({ label: String(y.key), bets: y.bets, profitUnits: y.profitUnits, roiPct: y.roiPct, winRatePct: y.winRatePct }))} unit={unit} />
        )}
      </Card>

      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 330px", marginBottom: 12 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="ap-label">ROI-trend (senaste 12 mån)</span>
            <span className="ap-num pos" style={{ fontWeight: 600 }}>{pctFmt(m?.roiPct ?? null, true)} totalt</span>
          </div>
          <div style={{ marginTop: 16 }}>
            <LineChart data={roiCurve} w={640} h={180} stroke={cc.acc} fill={cc.fill} grid={cc.grid} strokeW={2.2} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, color: "var(--dim2)", fontSize: 11 }}>
            {months.map((mo) => <span key={mo.month}>{mo.month.slice(5)}</span>)}
          </div>
        </Card>

        <Card>
          <span className="ap-label">Utfall</span>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, marginTop: 14 }}>
            <Donut data={outcomes} size={132} thickness={20} colors={outColors} track={cc.grid} centerLabel={pctFmt(m?.winRatePct ?? null)} centerSub="WIN RATE" centerColor={cc.txt} centerSubColor={cc.dim} />
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

      <SectionHead icon={<I p={IC.grid} />} title="Fördelningar" sub="var pengarna kommer ifrån" />

      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="P/L per sport" rows={data?.bySport ?? []} unit={unit} />
        <BreakdownCard title="P/L per marknad" sub="vad du bettat på" rows={data?.byMarketDetail ?? []} unit={unit} />
        <BreakdownCard title="P/L: spelare / lag / match" rows={data?.byScope ?? []} unit={unit} />
      </div>

      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="Singel vs ackumulator" rows={data?.byBetType ?? []} unit={unit} />
        <BreakdownCard title="P/L per odds-spann" rows={oddsBands} unit={unit} />
        <BreakdownCard title="P/L per liga" rows={data?.byLeague ?? []} unit={unit} />
      </div>

      <SectionHead icon={<I p={IC.book} />} title="Bookmakers" sub="P/L, ROI och volym per bolag" />

      <BookmakerTable rows={data?.byBookmaker ?? []} unit={unit} />

      <SectionHead icon={<I p={IC.calendar} />} title="Historik" sub="månad för månad" />

      {/* Per månad med år-väljare */}
      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Per månad</span>
          <div className="ap-select" style={{ minWidth: 110 }}>
            <select value={activeYear} onChange={(e) => setYear(e.target.value)}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div className="ap-table-wrap">
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "1fr 90px 120px 90px 90px" }}>
              <span>Månad</span><span className="ap-r">Bets</span><span className="ap-r">P/L</span><span className="ap-r">ROI</span><span className="ap-r">Win rate</span>
            </div>
            {monthRows.length === 0 && <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--dim2)" }}>Ingen data för {activeYear}.</div>}
            {monthRows.map((mo) => (
              <div key={mo.month} className="ap-trow" style={{ gridTemplateColumns: "1fr 90px 120px 90px 90px" }}>
                <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{monthLabel(mo.month)} {mo.month.slice(0, 4)}</span>
                <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{mo.bets}</span>
                <span className="ap-r ap-num" style={{ fontWeight: 600 }}><em className={mo.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(mo.profitUnits * unit, true)}</em> <span style={{ color: "var(--dim2)" }}>{uFmt(mo.profitUnits, true)}</span></span>
                <span className="ap-r ap-num"><em className={(mo.roiPct ?? 0) >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{pctFmt(mo.roiPct, true)}</em></span>
                <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{pctFmt(mo.winRatePct ?? null)}</span>
              </div>
            ))}
          </div>
        </div>
        {monthRows.length > 0 && (
          <PerfCards rows={monthRows.map((mo) => ({ label: `${monthLabel(mo.month)} ${mo.month.slice(0, 4)}`, bets: mo.bets, profitUnits: mo.profitUnits, roiPct: mo.roiPct, winRatePct: mo.winRatePct ?? null }))} unit={unit} />
        )}
      </Card>

      <SectionHead icon={<I p={IC.trophy} />} title="Rekord" sub="största vinster och förluster" />

      {/* Hall of Fame & Biggest L */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <LeaderboardCard title="Hall of Fame 🏆" sub="Största vinster" entries={data?.hallOfFame ?? []} unit={unit} />
        <LeaderboardCard title="Biggest L 💀" sub="Största förluster" entries={data?.biggestL ?? []} unit={unit} />
      </div>
    </div>
  );
}
