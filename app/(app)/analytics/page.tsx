"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, SkeletonCard, SectionHead, AnchorTabs } from "@/components/ui";
import Link from "next/link";
import { LineChart, Donut } from "@/components/charts";
import { HBar } from "@/components/miniCharts";
import { StatTile, BreakdownCard, PerfCards, LeaderboardCard, BookmakerTable } from "@/components/stats";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics } from "@/lib/useData";
import { uFmt, pctFmt, krShort, krFmt } from "@/lib/format";
import type { Breakdown } from "@/lib/betting";

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
  const cov = data?.clvCoverage;
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
  // Win and loss in their own colours; a push is neutral, an open bet is blue.
  const outColors = [cc.pos, cc.red, "var(--dim2)", "var(--info)"];

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
        <Topbar title="Analys" sub="Laddar…" />
        <div className="ap-kpi-row">
          {Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className="ap-board c21">
          <SkeletonCard chartH={180} />
          <SkeletonCard chartH={180} />
        </div>
      </div>
    );
  }

  const yearCols = "minmax(0,1fr) 56px 128px 72px 72px";

  return (
    <div>
      <Topbar title="Analys" sub={`${m?.totalBets ?? 0} bets · ${rangeLabel}`} />

      {/* Eight figures in one ruled block. */}
      <div className="ap-kpi-row">
        <StatTile label="Total P/L" value={uFmt(m?.profitUnits ?? null, true)} sub={`ROI ${pctFmt(m?.roiPct ?? null, true)}`} tone={(m?.profitUnits ?? 0) >= 0 ? "pos" : "neg"} />
        <StatTile label="Träffprocent" value={pctFmt(m?.winRatePct ?? null)} sub={`${m?.wins ?? 0}V · ${m?.losses ?? 0}F`} />
        <StatTile label="Medianodds" value={m?.medianOdds != null ? m.medianOdds.toFixed(2) : "—"} sub={m?.avgOdds != null ? `snitt ${m.avgOdds.toFixed(2)}` : undefined} />
        <StatTile label="Snittinsats" value={ins?.avgStakeUnits != null ? `${ins.avgStakeUnits.toFixed(2)}U` : "—"} sub={ins?.avgStakeUnits != null ? krFmt(ins.avgStakeUnits * unit) : "ingen data"} />
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

      {/* The page is long; these jump between its five parts and follow you down. */}
      <AnchorTabs
        label="Avsnitt"
        items={[
          { id: "utveckling", label: "Utveckling" },
          { id: "fordelningar", label: "Fördelningar" },
          { id: "bookmakers", label: "Bookmakers" },
          { id: "historik", label: "Historik" },
          { id: "rekord", label: "Rekord" },
        ]}
      />

      <SectionHead id="utveckling" title="Utveckling" sub="CLV, år och trend" />

      <div className="ap-board c21">
        <Card>
          <div className="ap-panel-head">
            <h3 className="ap-card-title">ROI-trend</h3>
            <span className="ap-t-sm ap-t-dim2">
              senaste 12 månaderna · <span className={"ap-num " + ((m?.roiPct ?? 0) >= 0 ? "pos" : "neg")}>{pctFmt(m?.roiPct ?? null, true)}</span> totalt
            </span>
          </div>
          <LineChart data={roiCurve} w={640} h={200} formatValue={(v) => `${Math.round(v)} %`} />
          <div className="ap-chart-months" aria-hidden="true">
            {months.map((mo) => <span key={mo.month}>{monthLabel(mo.month)}</span>)}
          </div>
        </Card>

        <Card>
          <div className="ap-panel-head">
            <h3 className="ap-card-title">Utfall</h3>
          </div>
          <div className="ap-outcomes">
            <Donut data={outcomes} size={124} thickness={16} colors={outColors} centerLabel={pctFmt(m?.winRatePct ?? null)} centerSub="TRÄFF" />
            <div className="ap-outcomes-legend">
              {outcomes.map((o, i) => (
                <div key={o.name} className="ap-legrow">
                  <span className="ap-dot" style={{ background: outColors[i] }} />
                  <span className="ap-t-dim" style={{ flex: 1 }}>{o.name}</span>
                  <span className="ap-num">{o.v}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="ap-board c2">
        {/* CLV — closing line value */}
        <Card>
          <div className="ap-panel-head">
            <h3 className="ap-card-title">Closing line value (CLV)</h3>
            <span className="ap-t-xs ap-t-dim2">
              {m && m.clvSampleSize > 0 ? `${m.clvSampleSize} bets med stängningsodds` : "kräver TheStatsAPI eller Odds API"}
            </span>
          </div>
          {m && m.clvSampleSize > 0 ? (
            <>
              <div className="ap-figs">
                <div>
                  <div className={"ap-num ap-kpi-val " + ((m.clvPct ?? 0) >= 0 ? "t-pos" : "t-red")}>{pctFmt(m.clvPct, true)}</div>
                  <div className="ap-note">Snitt-CLV</div>
                </div>
                <div>
                  <div className="ap-num ap-kpi-val">{pctFmt((m.clvBeatCount / m.clvSampleSize) * 100)}</div>
                  <div className="ap-note">
                    Slog stängningsoddset · {m.clvBeatCount}/{m.clvSampleSize}
                  </div>
                </div>
              </div>
              {/* Coverage decides how much the two numbers above are worth: an
                  average over 6 % of the journal is not the journal's CLV. */}
              {cov && cov.eligible > 0 && (
                <div className="ap-meter" style={{ marginTop: 16 }}>
                  <div className="ap-meter-head">
                    <span>
                      Täckning: <b className="ap-num">{cov.withClosing.toLocaleString("sv-SE")}</b> av{" "}
                      {cov.eligible.toLocaleString("sv-SE")} spel har stängningsodds
                    </span>
                    <span className="ap-num">{pctFmt(cov.pct)}</span>
                  </div>
                  <HBar pct={Math.max(cov.pct ?? 0, 1)} color={cc.acc} track={cc.grid} h={4} />
                  <div className="ap-note" style={{ marginTop: 8 }}>
                    {cov.boosted > 0 && `${cov.boosted.toLocaleString("sv-SE")} boostade spel är undantagna (en boost är inget marknadspris). `}
                    {cov.placeholder > 0 && `${cov.placeholder.toLocaleString("sv-SE")} spel med platshållarodds 1,01 är också undantagna. `}
                    <Link href="/bets?clv=missing" className="ap-link">
                      Visa spel utan stängningsodds →
                    </Link>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="ap-note" style={{ maxWidth: 560 }}>
              Inga stängningsodds insamlade än. CLV mäter om du tog bättre odds än marknadens
              stängningsodds — den starkaste enskilda indikatorn på edge. Lägg till en TheStatsAPI-
              eller Odds API-nyckel under Inställningar och kör synk så hämtas closing-odds automatiskt.
            </div>
          )}
        </Card>

        {/* Per år */}
        <Card style={{ padding: 0 }}>
          <div className="ap-card-head"><h3 className="ap-card-title">Per år</h3><span className="ap-t-sm ap-t-dim2">{rangeLabel}</span></div>
          <div className="ap-table-wrap">
            <div className="ap-table">
              <div className="ap-thead" style={{ gridTemplateColumns: yearCols }}>
                <span>År</span><span className="ap-r">Bets</span><span className="ap-r">P/L</span><span className="ap-r">ROI</span><span className="ap-r">Träff</span>
              </div>
              {byYear.length === 0 && <div className="ap-panel-empty">Ingen data än.</div>}
              {byYear.map((y) => (
                <div key={y.key} className="ap-trow" style={{ gridTemplateColumns: yearCols }}>
                  <span className="ap-num">{y.key}</span>
                  <span className="ap-r ap-num ap-t-dim">{y.bets}</span>
                  <span className="ap-r ap-num"><span className={y.profitUnits >= 0 ? "pos" : "neg"}>{krShort(y.profitUnits * unit, true)}</span> <span className="ap-t-dim2">{uFmt(y.profitUnits, true)}</span></span>
                  <span className={"ap-r ap-num " + ((y.roiPct ?? 0) >= 0 ? "pos" : "neg")}>{pctFmt(y.roiPct, true)}</span>
                  <span className="ap-r ap-num ap-t-dim">{pctFmt(y.winRatePct)}</span>
                </div>
              ))}
            </div>
          </div>
          {byYear.length > 0 && (
            <PerfCards rows={byYear.map((y) => ({ label: String(y.key), bets: y.bets, profitUnits: y.profitUnits, roiPct: y.roiPct, winRatePct: y.winRatePct }))} unit={unit} />
          )}
        </Card>
      </div>

      <SectionHead id="fordelningar" title="Fördelningar" sub="var pengarna kommer ifrån" />

      <div className="ap-board c3">
        <BreakdownCard title="P/L per sport" rows={data?.bySport ?? []} unit={unit} />
        <BreakdownCard title="P/L per marknad" sub="vad du bettat på" rows={data?.byMarketDetail ?? []} unit={unit} />
        <BreakdownCard title="P/L: spelare / lag / match" rows={data?.byScope ?? []} unit={unit} />
        <BreakdownCard title="Singel vs ackumulator" rows={data?.byBetType ?? []} unit={unit} />
        <BreakdownCard title="P/L per odds-spann" rows={oddsBands} unit={unit} />
        <BreakdownCard title="P/L per liga" rows={data?.byLeague ?? []} unit={unit} />
      </div>

      <SectionHead id="bookmakers" title="Bookmakers" sub="P/L, ROI och volym per bolag" />

      <BookmakerTable rows={data?.byBookmaker ?? []} unit={unit} />

      <SectionHead id="historik" title="Historik" sub="månad för månad" />

      {/* Per månad med år-väljare */}
      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <h3 className="ap-card-title">Per månad</h3>
          <div className="ap-select">
            <select aria-label="År" value={activeYear} onChange={(e) => setYear(e.target.value)}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div className="ap-table-wrap">
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "1fr 90px 140px 90px 90px" }}>
              <span>Månad</span><span className="ap-r">Bets</span><span className="ap-r">P/L</span><span className="ap-r">ROI</span><span className="ap-r">Träff</span>
            </div>
            {monthRows.length === 0 && <div className="ap-panel-empty">Ingen data för {activeYear}.</div>}
            {monthRows.map((mo) => (
              <div key={mo.month} className="ap-trow" style={{ gridTemplateColumns: "1fr 90px 140px 90px 90px" }}>
                <span style={{ textTransform: "capitalize" }}>{monthLabel(mo.month)} {mo.month.slice(0, 4)}</span>
                <span className="ap-r ap-num ap-t-dim">{mo.bets}</span>
                <span className="ap-r ap-num"><span className={mo.profitUnits >= 0 ? "pos" : "neg"}>{krShort(mo.profitUnits * unit, true)}</span> <span className="ap-t-dim2">{uFmt(mo.profitUnits, true)}</span></span>
                <span className={"ap-r ap-num " + ((mo.roiPct ?? 0) >= 0 ? "pos" : "neg")}>{pctFmt(mo.roiPct, true)}</span>
                <span className="ap-r ap-num ap-t-dim">{pctFmt(mo.winRatePct ?? null)}</span>
              </div>
            ))}
          </div>
        </div>
        {monthRows.length > 0 && (
          <PerfCards rows={monthRows.map((mo) => ({ label: `${monthLabel(mo.month)} ${mo.month.slice(0, 4)}`, bets: mo.bets, profitUnits: mo.profitUnits, roiPct: mo.roiPct, winRatePct: mo.winRatePct ?? null }))} unit={unit} />
        )}
      </Card>

      <SectionHead id="rekord" title="Rekord" sub="största vinster och förluster" />

      {/* Hall of Fame & Biggest L */}
      <div className="ap-board c2">
        <LeaderboardCard title="Hall of Fame 🏆" sub="Största vinster" entries={data?.hallOfFame ?? []} unit={unit} />
        <LeaderboardCard title="Biggest L 💀" sub="Största förluster" entries={data?.biggestL ?? []} unit={unit} />
      </div>
    </div>
  );
}
