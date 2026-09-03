"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, SkeletonCard, SectionHead } from "@/components/ui";
import { LineChart, Donut, HBar } from "@/components/charts";
import { StatTile, BreakdownCard, MiniStat, PerfCards, LeaderboardCard, BookmakerTable } from "@/components/stats";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics } from "@/lib/useData";
import { uFmt, pctFmt, krShort, krFmt } from "@/lib/format";
import type { Breakdown } from "@/lib/betting";
import { I, IC } from "@/components/icons";

// A month's CLV is meaningless on a handful of bets — the series only plots
// months that cleared this many.
const CLV_MONTH_MIN = 10;
// Below this many bets a market's coverage percentage is just noise.
const CLV_COVERAGE_MIN_BETS = 25;

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

  // /api/metrics ships odds bands as full Breakdowns — no reshaping needed.
  const oddsBands: Breakdown[] = data?.oddsBands ?? [];

  // CLV over time. Prefers the verified series and falls back to the unverified
  // one, so the chart isn't blank while capture coverage is still thin — the
  // card's copy says which is which.
  const clvSeries = useMemo(() => {
    const useVerified = byMonth.some((mo) => (mo.clvSampleSize ?? 0) >= CLV_MONTH_MIN);
    return byMonth
      .map((mo) => ({
        month: mo.month,
        pct: (useVerified ? mo.clvPct : mo.clvUnverifiedPct) ?? null,
        n: (useVerified ? mo.clvSampleSize : mo.clvUnverifiedSampleSize) ?? 0,
      }))
      .filter((p): p is { month: string; pct: number; n: number } => p.pct != null && p.n >= CLV_MONTH_MIN);
  }, [byMonth]);

  // Where the capture pipeline actually reaches. Worst coverage first — the
  // point of the panel is the holes, not the wins.
  const clvCoverageRows = useMemo(
    () =>
      (data?.byMarketDetail ?? [])
        .filter((r) => r.bets >= CLV_COVERAGE_MIN_BETS)
        .sort((a, b) => (a.clvCoveragePct ?? 0) - (b.clvCoveragePct ?? 0))
        .slice(0, 10),
    [data?.byMarketDetail]
  );

  if (loading && !data) {
    return (
      <div>
        <Topbar title="Analys" sub="Laddar…" icon={IC.chart} />
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
      <Topbar title="Analys" sub={`${m?.totalBets ?? 0} bets · ${rangeLabel}`} icon={IC.chart} />

      <div className="ap-kpi-row">
        <StatTile label="Total P/L" value={uFmt(m?.profitUnits ?? null, true)} sub={`ROI ${pctFmt(m?.roiPct ?? null, true)}`} tone={(m?.profitUnits ?? 0) >= 0 ? "pos" : "neg"} icon={IC.coins} accent={(m?.profitUnits ?? 0) >= 0 ? "emerald" : "red"} />
        <StatTile label="Träffprocent" value={pctFmt(m?.winRatePct ?? null)} sub={`${m?.wins ?? 0}V · ${m?.losses ?? 0}F`} icon={IC.target} accent="amber" />
        <StatTile
          label="Medianodds"
          value={(m?.medianOdds ?? 0).toFixed(2)}
          sub={`snitt ${(m?.avgOdds ?? 0).toFixed(2)} · ${m?.settledBets ?? 0} avgjorda`}
          hint="Medianen, inte snittet: en handfull bet builder-spel prissatta över 1000 drar upp medelvärdet så att det slutar beskriva vad du faktiskt spelar."
          icon={IC.scale}
          accent="pink"
        />
        <StatTile label="Snittinsats" value={ins?.avgStakeUnits != null ? `${ins.avgStakeUnits.toFixed(2)}U` : "—"} sub={ins?.avgStakeUnits != null ? krFmt(ins.avgStakeUnits * unit) : "ingen data"} icon={IC.layers} accent="purple" />
      </div>

      <div className="ap-kpi-row">
        <StatTile
          label="Max drawdown"
          value={dd ? `−${krShort(dd.maxUnits * unit)}` : "—"}
          sub={dd ? `största tapp från toppen · ${uFmt(-dd.maxUnits, true)}` : "största tapp från toppen"}
          tone="neg"
          icon={IC.trendDown}
        />
        <StatTile
          label="Omsatt"
          value={m ? krShort(m.stakedUnits * unit) : "—"}
          sub={m ? `${uFmt(m.stakedUnits)} över ${m.settledBets} avgjorda` : "ingen data"}
          icon={IC.bars}
          accent="sky"
        />
        <StatTile
          label="Bästa månad"
          value={bestMonth ? krShort(bestMonth.profitUnits * unit, true) : "—"}
          sub={bestMonth ? `${monthLabel(bestMonth.month)} ${bestMonth.month.slice(0, 4)} · ${bestMonth.bets} bets` : "ingen data"}
          tone="pos"
          icon={IC.award}
        />
        <StatTile
          label="Sämsta månad"
          value={worstMonth ? krShort(worstMonth.profitUnits * unit, true) : "—"}
          sub={worstMonth ? `${monthLabel(worstMonth.month)} ${worstMonth.month.slice(0, 4)} · ${worstMonth.bets} bets` : "ingen data"}
          tone="neg"
          icon={IC.alert}
        />
      </div>

      <SectionHead icon={IC.chart} title="Utveckling" sub="CLV, år och trend" />

      {/* CLV — closing line value, split by how trustworthy the closing price is */}
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <span className="ap-label">Closing line value (CLV)</span>
          <span style={{ color: "var(--dim2)", fontSize: 11 }}>
            {m && m.totalBets > 0
              ? `${m.clvAnySampleSize.toLocaleString("sv-SE")} av ${m.totalBets.toLocaleString("sv-SE")} spel · ${pctFmt((m.clvAnySampleSize / m.totalBets) * 100)} täckning`
              : "kräver TheStatsAPI eller Odds API"}
          </span>
        </div>

        {m && m.clvAnySampleSize > 0 ? (
          <>
            <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <MiniStat
                label="Verifierad stängning"
                value={m.clvSampleSize ? pctFmt(m.clvPct, true) : "—"}
                tone={m.clvSampleSize ? ((m.clvPct ?? 0) >= 0 ? "pos" : "neg") : undefined}
                sub={
                  m.clvSampleSize
                    ? `${m.clvBeatCount}/${m.clvSampleSize} slog stängningen · ${pctFmt((m.clvBeatCount / m.clvSampleSize) * 100)}`
                    : "Inga spel med verifierad stängning än"
                }
              />
              <MiniStat
                label="Overifierad proveniens"
                value={m.clvUnverifiedSampleSize ? pctFmt(m.clvUnverifiedPct, true) : "—"}
                tone={m.clvUnverifiedSampleSize ? ((m.clvUnverifiedPct ?? 0) >= 0 ? "pos" : "neg") : undefined}
                sub={
                  m.clvUnverifiedSampleSize
                    ? `${m.clvUnverifiedBeatCount}/${m.clvUnverifiedSampleSize} bättre · ${pctFmt((m.clvUnverifiedBeatCount / m.clvUnverifiedSampleSize) * 100)}`
                    : "Inga"
                }
              />
            </div>
            <p style={{ fontSize: 11.5, color: "var(--dim2)", lineHeight: 1.55, marginTop: 12, marginBottom: 0 }}>
              Talen hålls isär för att de mäter olika saker. Vänster kolumn jämför mot ett
              stängningspris som appen själv hämtat. Höger kolumn är rader vars ursprung inte går
              att belägga i efterhand — främst BetHero-importen, som skrev fair odds i samma fält.
              Att slå ett fair odds är en edge-uppskattning, inte closing line value, och en
              beat-rate nära 100 % är omöjlig mot en verklig stängning.
              {m.clvBoostedSkipped > 0 &&
                ` ${m.clvBoostedSkipped} boostade spel räknas inte alls — en boost är en kampanj, inte marknadens pris.`}
            </p>

            {clvSeries.length > 1 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="ap-label">CLV per månad</span>
                  <span style={{ color: "var(--dim2)", fontSize: 11 }}>
                    månader med minst {CLV_MONTH_MIN} spel
                  </span>
                </div>
                <div style={{ marginTop: 12 }}>
                  <LineChart
                    data={clvSeries.map((p) => p.pct)}
                    w={640}
                    h={140}
                    stroke={cc.acc}
                    fill={cc.fill}
                    grid={cc.grid}
                    strokeW={2.2}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, color: "var(--dim2)", fontSize: 11 }}>
                  {clvSeries.map((p) => (
                    <span key={p.month}>{monthLabel(p.month)}</span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: "var(--dim2)", fontSize: 13, lineHeight: 1.5, maxWidth: 560 }}>
            Inga stängningsodds insamlade än. CLV mäter om du tog bättre odds än marknadens
            stängningsodds — den starkaste enskilda indikatorn på edge. Lägg till en TheStatsAPI-
            eller Odds API-nyckel under Inställningar och kör synk så hämtas closing-odds automatiskt.
          </div>
        )}
      </Card>

      {/* Coverage — which markets the capture pipeline actually reaches. */}
      {clvCoverageRows.length > 0 && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="ap-label">Stängningsodds-täckning per marknad</span>
            <span style={{ color: "var(--dim2)", fontSize: 11 }}>andel spel med stängningspris</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
            {clvCoverageRows.map((r) => (
              <div key={r.key}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                  <span>
                    {r.key} <span style={{ color: "var(--dim2)", fontSize: 12 }}>· {r.bets} spel</span>
                  </span>
                  <span className="ap-num" style={{ fontWeight: 600 }}>{pctFmt(r.clvCoveragePct)}</span>
                </div>
                <HBar
                  pct={Math.max(r.clvCoveragePct ?? 0, 1.5)}
                  color={(r.clvCoveragePct ?? 0) >= 30 ? cc.acc : cc.red}
                  track={cc.grid}
                  h={7}
                />
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11.5, color: "var(--dim2)", lineHeight: 1.55, marginTop: 16, marginBottom: 0 }}>
            Röd stapel = marknaden fångas i praktiken inte. CLV-siffran ovan säger ingenting om
            de marknaderna, hur bra den än ser ut.
          </p>
        </Card>
      )}

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
            <span
              className={"ap-num " + ((m?.roiPct ?? 0) >= 0 ? "pos" : "neg")}
              style={{ fontWeight: 600 }}
            >
              {pctFmt(m?.roiPct ?? null, true)} totalt
            </span>
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

      <SectionHead icon={IC.grid} title="Fördelningar" sub="var pengarna kommer ifrån" />

      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="P/L per sport" rows={data?.bySport ?? []} unit={unit} />
        <BreakdownCard title="P/L per marknad" sub="vad du bettat på" rows={data?.byMarketDetail ?? []} unit={unit} showClv />
        <BreakdownCard title="P/L: spelare / lag / match" rows={data?.byScope ?? []} unit={unit} />
      </div>

      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="Singel vs ackumulator" rows={data?.byBetType ?? []} unit={unit} />
        <BreakdownCard title="P/L per odds-spann" rows={oddsBands} unit={unit} />
        <BreakdownCard title="P/L per liga" rows={data?.byLeague ?? []} unit={unit} />
      </div>

      <SectionHead icon={IC.book} title="Bookmakers" sub="P/L, ROI och volym per bolag" />

      <BookmakerTable rows={data?.byBookmaker ?? []} unit={unit} />

      <SectionHead icon={IC.calendar} title="Historik" sub="månad för månad" />

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

      <SectionHead icon={IC.trophy} title="Rekord" sub="största vinster och förluster" />

      {/* Hall of Fame & Biggest L */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <LeaderboardCard title="Hall of Fame 🏆" sub="Största vinster" entries={data?.hallOfFame ?? []} unit={unit} />
        <LeaderboardCard title="Biggest L 💀" sub="Största förluster" entries={data?.biggestL ?? []} unit={unit} />
      </div>
    </div>
  );
}
