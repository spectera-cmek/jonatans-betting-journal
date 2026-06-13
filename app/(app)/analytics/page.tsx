"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, SkeletonCard } from "@/components/ui";
import { LineChart, Donut, HBar } from "@/components/charts";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics, type LeaderboardEntry } from "@/lib/useData";
import { uFmt, pctFmt, krShort, krFmt, sportTag, dateShort } from "@/lib/format";
import type { Breakdown } from "@/lib/betting";

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="ap-card ap-lift">
      <span className="ap-label">{label}</span>
      <div className="ap-num ap-kpi-val"><span className={tone || ""}>{value}</span></div>
      {sub && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function BreakdownCard({ title, rows, unit, sub }: { title: string; rows: Breakdown[]; unit: number; sub?: string }) {
  const { cc } = useTheme();
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.profitUnits)));
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="ap-label">{title}</span>
        {sub && <span style={{ color: "var(--dim2)", fontSize: 11 }}>{sub}</span>}
      </div>
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

function LeaderboardCard({ title, sub, entries, unit }: { title: string; sub?: string; entries: LeaderboardEntry[]; unit: number }) {
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="ap-label">{title}</span>
        {sub && <span style={{ color: "var(--dim2)", fontSize: 11 }}>{sub}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        {entries.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data</span>}
        {entries.map((e, i) => (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="ap-num" style={{ width: 16, textAlign: "center", color: "var(--dim2)", fontWeight: 700, fontSize: 13 }}>{i + 1}</span>
            <span className="ap-tag">{sportTag(e.sport)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ap-ell" style={{ fontSize: 13 }}>{e.event}</div>
              <div className="ap-ell" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 2 }}>
                {e.selection || "—"}
              </div>
              <div className="ap-ell" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 3 }}>
                {dateShort(e.eventAt)} · odds {e.odds.toFixed(2)} · insats {uFmt(e.stakeUnits)} ({krFmt(e.stakeUnits * unit)})
              </div>
            </div>
            <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <div className="ap-num" style={{ fontWeight: 700 }}>
                <em className={e.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krFmt(e.profitUnits * unit, true)}</em>
              </div>
              <div className="ap-num" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 2 }}>{pctFmt(e.roiPct, true)} ROI</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

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
  const risk = data?.openRisk;
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
        <Topbar title="Analys" sub="Laddar…" />
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
      <Topbar title="Analys" sub={`${m?.totalBets ?? 0} bets · ${rangeLabel}`} />

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
          label="Öppen risk"
          value={risk ? krShort(risk.stakeUnits * unit) : "—"}
          sub={risk ? `${risk.bets} öppna · möjlig retur ${krShort(risk.potentialReturnUnits * unit)}` : "inga öppna bets"}
        />
        <StatTile
          label="Bästa dag"
          value={ins?.best ? krShort(ins.best.profitUnits * unit, true) : "—"}
          sub={ins?.best ? `${dateShort(ins.best.date)} · ${ins.best.bets} bets` : "ingen data"}
          tone="pos"
        />
        <StatTile
          label="Sämsta dag"
          value={ins?.worst ? krShort(ins.worst.profitUnits * unit, true) : "—"}
          sub={ins?.worst ? `${dateShort(ins.worst.date)} · ${ins.worst.bets} bets` : "ingen data"}
          tone="neg"
        />
      </div>

      {/* CLV — closing line value */}
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <span className="ap-label">Closing line value (CLV)</span>
          <span style={{ color: "var(--dim2)", fontSize: 11 }}>
            {m && m.clvSampleSize > 0 ? `${m.clvSampleSize} bets med stängningsodds` : "kräver Odds API-nyckel"}
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
            stängningsodds — den starkaste enskilda indikatorn på edge. Lägg till en The Odds
            API-nyckel under Inställningar så hämtas closing-odds automatiskt.
          </div>
        )}
      </Card>

      {/* Per år */}
      <Card style={{ padding: 0, marginBottom: 12 }}>
        <div className="ap-card-head"><span className="ap-card-title">Per år</span><span style={{ color: "var(--dim2)", fontSize: 12 }}>{rangeLabel}</span></div>
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

      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="P/L per sport" rows={data?.bySport ?? []} unit={unit} />
        <BreakdownCard title="P/L per marknad" rows={data?.byMarket ?? []} unit={unit} />
        <BreakdownCard title="Singel vs ackumulator" rows={data?.byBetType ?? []} unit={unit} />
      </div>

      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
        <BreakdownCard title="P/L per odds-spann" rows={oddsBands} unit={unit} />
        <BreakdownCard title="P/L per liga" rows={data?.byLeague ?? []} unit={unit} />
        <BreakdownCard title="P/L per bookmaker" rows={data?.byBookmaker ?? []} unit={unit} />
      </div>

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
      </Card>

      {/* Hall of Fame & Biggest L */}
      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
        <LeaderboardCard title="Hall of Fame 🏆" sub="Största vinster" entries={data?.hallOfFame ?? []} unit={unit} />
        <LeaderboardCard title="Biggest L 💀" sub="Största förluster" entries={data?.biggestL ?? []} unit={unit} />
      </div>
    </div>
  );
}
