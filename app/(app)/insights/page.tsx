"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Skeleton, SkeletonCard } from "@/components/ui";
import { HBar, CompareChart, type TimePoint } from "@/components/charts";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics, useBets } from "@/lib/useData";
import { uFmt, krShort, krFmt, pctFmt, dateShort } from "@/lib/format";
import { settledProfit, isSettled, countsForWinRate, isWinLike } from "@/lib/betting";
import { betCategory } from "@/lib/discipline";
import { noEdgeVariance, varianceByKey } from "@/lib/variance";
import type { WeeklyReport, WeekAgg, WeekBetRef } from "@/lib/weekly";
import type { BetListDTO } from "@/lib/types";
import type { ChartColors } from "@/lib/theme";

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
function monthLabel(ym?: string): string {
  if (!ym) return "—";
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="ap-card ap-lift">
      <span className="ap-label">{label}</span>
      <div className="ap-num ap-kpi-val"><span className={tone || ""}>{value}</span></div>
      {sub && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export default function InsightsPage() {
  const { cc } = useTheme();
  const { data, loading } = useMetrics();
  const { bets, loading: betsLoading } = useBets();
  const unit = data?.settings.unitValue ?? 100;
  const ins = data?.insights;

  const streakValue = !ins || ins.streaks.currentType === "none"
    ? "—"
    : `${ins.streaks.current} ${ins.streaks.currentType === "win" ? "vinster" : "förluster"}`;
  const streakTone = ins?.streaks.currentType === "win" ? "pos" : ins?.streaks.currentType === "loss" ? "neg" : "";

  const mom = ins?.monthCurrent;
  const momPrev = ins?.monthPrevious;
  const momDelta = mom && momPrev ? mom.profitUnits - momPrev.profitUnits : null;

  const weekdays = ins?.byWeekday ?? [];
  const maxWd = Math.max(1, ...weekdays.map((w) => Math.abs(w.profitUnits)));

  return (
    <div>
      <Topbar title="Insikter" sub="Din form, dina rekord och dina mönster" />

      {loading && !data && (
        <>
          <div className="ap-kpi-row">
            <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
          <Card>
            <Skeleton w={120} h={12} />
            <Skeleton h={120} style={{ marginTop: 14 }} />
          </Card>
        </>
      )}

      {data && (
        <>
          {data.weekly && <WeeklyCard weekly={data.weekly} unit={unit} />}

          <div className="ap-kpi-row">
            <Tile label="Nuvarande svit" value={streakValue} tone={streakTone} sub={ins?.streaks.currentType === "none" ? "ingen data" : "i rad"} />
            <Tile label="Längsta vinstsvit" value={ins ? `${ins.streaks.longestWin}` : "—"} tone="pos" sub="i rad" />
            <Tile label="Längsta förlustsvit" value={ins ? `${ins.streaks.longestLoss}` : "—"} tone="neg" sub="i rad" />
            <Tile label="Snittinsats" value={ins?.avgStakeUnits != null ? `${ins.avgStakeUnits.toFixed(2)}U` : "—"} sub={ins?.avgStakeUnits != null ? krFmt(ins.avgStakeUnits * unit) : undefined} />
          </div>

          <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
            <Card>
              <span className="ap-label">Bästa dag 🟢</span>
              {ins?.best ? (
                <>
                  <div className="ap-num" style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>
                    <span className="pos">{krShort(ins.best.profitUnits * unit, true)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>{dateShort(ins.best.date)} · {ins.best.bets} bets · {uFmt(ins.best.profitUnits, true)}</div>
                </>
              ) : <div style={{ color: "var(--dim2)", fontSize: 13, marginTop: 10 }}>Ingen data</div>}
            </Card>

            <Card>
              <span className="ap-label">Sämsta dag 🔴</span>
              {ins?.worst ? (
                <>
                  <div className="ap-num" style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>
                    <span className="neg">{krShort(ins.worst.profitUnits * unit, true)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>{dateShort(ins.worst.date)} · {ins.worst.bets} bets · {uFmt(ins.worst.profitUnits, true)}</div>
                </>
              ) : <div style={{ color: "var(--dim2)", fontSize: 13, marginTop: 10 }}>Ingen data</div>}
            </Card>

            <Card>
              <span className="ap-label">Den här månaden</span>
              {mom ? (
                <>
                  <div className="ap-num" style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>
                    <span className={mom.profitUnits >= 0 ? "pos" : "neg"}>{krShort(mom.profitUnits * unit, true)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>
                    {monthLabel(mom.month)} · {mom.bets} bets
                    {momDelta != null && (
                      <> · <span className={momDelta >= 0 ? "pos" : "neg"}>{momDelta >= 0 ? "▲" : "▼"} {uFmt(Math.abs(momDelta))}</span> vs {monthLabel(momPrev?.month)}</>
                    )}
                  </div>
                </>
              ) : <div style={{ color: "var(--dim2)", fontSize: 13, marginTop: 10 }}>Ingen data</div>}
            </Card>
          </div>

          <Card style={{ marginBottom: 12 }}>
            <span className="ap-label">P/L per veckodag</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
              {weekdays.every((w) => w.bets === 0) && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data</span>}
              {weekdays.map((w) => (
                w.bets > 0 && (
                  <div key={w.weekday}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                      <span>{WEEKDAYS[w.weekday]} <span style={{ color: "var(--dim2)", fontSize: 12 }}>· {w.bets} bets</span></span>
                      <span className="ap-num" style={{ fontWeight: 600 }}>
                        <em className={w.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(w.profitUnits * unit, true)}</em>
                        <span style={{ color: "var(--dim2)", marginLeft: 8 }}>{pctFmt(w.roiPct, true)}</span>
                      </span>
                    </div>
                    <HBar pct={Math.max((Math.abs(w.profitUnits) / maxWd) * 100, 3)} color={w.profitUnits >= 0 ? cc.acc : cc.red} track={cc.grid} h={7} />
                  </div>
                )
              ))}
            </div>
          </Card>

          {!betsLoading && bets.length > 0 && (
            <>
              <LuckCard bets={bets} unit={unit} cc={cc} />
              <Simulator bets={bets} unit={unit} cc={cc} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------- Veckorapport ------------------------------ */

function WeekCol({ title, agg, unit, dim }: { title: string; agg: WeekAgg; unit: number; dim?: boolean }) {
  return (
    <div style={{ opacity: dim ? 0.75 : 1 }}>
      <div style={{ fontSize: 12, color: "var(--dim)", fontWeight: 600 }}>{title}</div>
      <div className="ap-num" style={{ fontSize: 27, fontWeight: 700, marginTop: 6 }}>
        <span className={agg.profitUnits >= 0 ? "pos" : "neg"}>{krFmt(agg.profitUnits * unit, true)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 10, fontSize: 12.5, color: "var(--dim)" }}>
        <span>{agg.bets} bets{agg.pending > 0 ? ` · ${agg.pending} öppna` : ""}</span>
        <span>Träff {agg.winRatePct != null ? pctFmt(agg.winRatePct) : "—"} · ROI {agg.roiPct != null ? pctFmt(agg.roiPct, true) : "—"}</span>
        <span>Omsatt {uFmt(agg.stakedUnits)} · {krFmt(agg.stakedUnits * unit)}</span>
      </div>
    </div>
  );
}

function WeekBetLine({ label, bet, unit, tone }: { label: string; bet: WeekBetRef | null; unit: number; tone: "pos" | "neg" }) {
  if (!bet) return null;
  return (
    <div className="ap-leg" style={{ fontSize: 12.5 }}>
      <span style={{ color: "var(--dim2)", width: 100, flexShrink: 0 }}>{label}</span>
      <span className="ap-ell" style={{ flex: 1, color: "var(--dim)" }}>{bet.event}{bet.selection ? ` · ${bet.selection}` : ""}</span>
      <span className={"ap-num " + tone} style={{ fontWeight: 600 }}>{krFmt(bet.profitUnits * unit, true)}</span>
    </div>
  );
}

function disciplineGradeLabel(pct: number | null): { text: string; tone: string } {
  if (pct == null) return { text: "—", tone: "" };
  if (pct >= 85) return { text: "A", tone: "pos" };
  if (pct >= 70) return { text: "B", tone: "pos" };
  if (pct >= 50) return { text: "C", tone: "" };
  if (pct >= 30) return { text: "D", tone: "neg" };
  return { text: "E", tone: "neg" };
}

function WeeklyCard({ weekly, unit }: { weekly: WeeklyReport; unit: number }) {
  const cur = weekly.current;
  const prev = weekly.previous;
  const delta = cur.profitUnits - prev.profitUnits;
  const grade = disciplineGradeLabel(cur.disciplinePct);
  return (
    <Card style={{ padding: 0, marginBottom: 12 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">Veckorapport</span>
        <span style={{ color: "var(--dim2)", fontSize: 12 }}>
          v.{cur.weekNo} · {dateShort(cur.start)}–{dateShort(cur.end)}
        </span>
      </div>
      <div style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 18, alignItems: "start" }} className="ap-week-grid">
        <WeekCol title={`Denna vecka (v.${cur.weekNo})`} agg={cur} unit={unit} />
        <WeekCol title={`Förra veckan (v.${prev.weekNo})`} agg={prev} unit={unit} dim />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <span className={"ap-pill " + (delta >= 0 ? "pos" : "neg")}>{delta >= 0 ? "▲" : "▼"} {krFmt(Math.abs(delta) * unit)} vs förra veckan</span>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              className={"ap-num " + grade.tone}
              style={{ fontSize: 24, fontWeight: 700, width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--card2)", border: "1px solid var(--line)" }}
            >
              {grade.text}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: 1.4 }}>
              Disciplin<br />
              {cur.disciplinePct != null ? `${Math.round(cur.disciplinePct)} % av insatserna utan kända läckor` : "ingen data ännu"}
            </span>
          </div>
        </div>
      </div>
      {(cur.best || cur.worst) && (
        <div style={{ padding: "0 20px 16px", display: "flex", flexDirection: "column", gap: 7 }}>
          <WeekBetLine label="Veckans bästa" bet={cur.best} unit={unit} tone="pos" />
          <WeekBetLine label="Veckans sämsta" bet={cur.worst} unit={unit} tone="neg" />
        </div>
      )}
    </Card>
  );
}

/* ------------------------------ Tur-index --------------------------------- */

function luckVerdict(z: number): string {
  if (z >= 1.5) return "Klart över slumpens spann — det här ser ut som edge, inte tur.";
  if (z >= 0.5) return "Något över den marginalfria baslinjen — försiktigt positivt.";
  if (z > -0.5) return "Mitt i slumpens spann — varken tur eller otur dominerar.";
  if (z > -1.5) return "Strax under baslinjen — ungefär vad spelbolagets marginal kostar över tid.";
  return "Klart under slumpens spann — läckorna syns även här.";
}

function zFmt(z: number): string {
  return (z >= 0 ? "+" : "−") + Math.abs(z).toLocaleString("sv-SE", { maximumFractionDigits: 1 }) + "σ";
}

function LuckCard({ bets, unit, cc }: { bets: BetListDTO[]; unit: number; cc: ChartColors }) {
  const overall = useMemo(() => noEdgeVariance(bets), [bets]);
  const cats = useMemo(
    () =>
      varianceByKey(
        bets,
        (b) => betCategory({ selection: (b as BetListDTO).selection, market: (b as BetListDTO).market }),
        50
      ).slice(0, 10),
    [bets]
  );
  if (overall.z == null) return null;
  const maxZ = Math.max(1, ...cats.map((c) => Math.abs(c.z ?? 0)));
  return (
    <Card style={{ marginBottom: 12 }}>
      <span className="ap-label">Tur eller skicklighet?</span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <span className="ap-num" style={{ fontSize: 30, fontWeight: 700 }}>
          <span className={overall.z >= 0 ? "pos" : "neg"}>{zFmt(overall.z)}</span>
        </span>
        <span style={{ fontSize: 13, color: "var(--dim)" }}>{luckVerdict(overall.z)}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--dim2)", marginTop: 8 }}>
        Utfall {krFmt(overall.actualUnits * unit, true)} över {overall.n.toLocaleString("sv-SE")} avgjorda bets ·
        slumpens spann ±{krFmt(overall.sigmaUnits * unit)} (1σ) · percentil {overall.percentile != null ? Math.round(overall.percentile) : "—"}
      </div>

      {cats.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 13, marginTop: 18 }}>
          {cats.map((c) => (
            <div key={c.key}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                <span>{c.key} <span style={{ color: "var(--dim2)", fontSize: 12 }}>· {c.n} bets</span></span>
                <span className="ap-num" style={{ fontWeight: 600 }}>
                  <em className={(c.z ?? 0) >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{zFmt(c.z ?? 0)}</em>
                  <span style={{ color: "var(--dim2)", marginLeft: 8 }}>{krShort(c.actualUnits * unit, true)}</span>
                </span>
              </div>
              <HBar pct={Math.max((Math.abs(c.z ?? 0) / maxZ) * 100, 3)} color={(c.z ?? 0) >= 0 ? cc.pos : cc.red} track={cc.grid} h={7} />
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 11.5, color: "var(--dim2)", lineHeight: 1.55, marginTop: 16, marginBottom: 0 }}>
        Baslinjen antar att varje bet vinner med sannolikheten 1/odds (utan spelbolagsmarginal) — då är förväntat
        resultat exakt 0. En kategori som ligger flera σ över baslinjen efter hundratals bets är sannolikt skicklighet;
        samma siffra efter 30 bets är mest varians.
      </p>
    </Card>
  );
}

/* ----------------------------- Tänk om-simulatorn -------------------------- */

const EDGE_PRESET = new Set(["Skott", "Returer", "Hörnor", "Halvlek"]);

interface SimResult {
  actual: TimePoint[];
  filtered: TimePoint[];
  nBets: number;
  profitUnits: number;
  stakedUnits: number;
  winRatePct: number | null;
  actualProfitUnits: number;
}

function Simulator({ bets, unit, cc }: { bets: BetListDTO[]; unit: number; cc: ChartColors }) {
  const [cats, setCats] = useState<Set<string>>(new Set(EDGE_PRESET));
  const [oddsMin, setOddsMin] = useState("1.5");
  const [oddsMax, setOddsMax] = useState("3");
  const [maxStake, setMaxStake] = useState("");
  const [singlesOnly, setSinglesOnly] = useState(true);

  // Category chip list: every category seen in the history, biggest first.
  const allCats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bets) {
      const c = betCategory({ selection: b.selection, market: b.market });
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [bets]);

  const sim = useMemo<SimResult>(() => {
    const lo = parseFloat(oddsMin.replace(",", "."));
    const hi = parseFloat(oddsMax.replace(",", "."));
    const cap = parseFloat(maxStake.replace(",", "."));
    const hasLo = Number.isFinite(lo);
    const hasHi = Number.isFinite(hi);
    const hasCap = Number.isFinite(cap) && cap > 0;

    const settled = bets
      .filter((b) => isSettled(b.outcome))
      .map((b) => ({ b, t: Date.parse(b.eventAt ?? b.placedAt) }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);

    const actual: TimePoint[] = [];
    const filtered: TimePoint[] = [];
    let cumA = 0;
    let cumF = 0;
    let nBets = 0;
    let staked = 0;
    let wins = 0;
    let losses = 0;

    for (const { b, t } of settled) {
      const p = settledProfit(b);
      cumA += p;
      actual.push({ t, v: cumA * unit });

      if (cats.size > 0 && !cats.has(betCategory({ selection: b.selection, market: b.market }))) continue;
      if (hasLo && b.odds < lo) continue;
      if (hasHi && b.odds > hi) continue;
      if (singlesOnly && b.betType === "accumulator") continue;

      const scale = hasCap && b.stakeUnits > cap ? cap / b.stakeUnits : 1;
      cumF += p * scale;
      nBets += 1;
      staked += b.stakeUnits * scale;
      if (countsForWinRate(b.outcome)) {
        if (isWinLike(b.outcome)) wins += 1;
        else losses += 1;
      }
      filtered.push({ t, v: cumF * unit });
    }

    return {
      actual,
      filtered,
      nBets,
      profitUnits: cumF,
      stakedUnits: staked,
      winRatePct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
      actualProfitUnits: cumA,
    };
  }, [bets, cats, oddsMin, oddsMax, maxStake, singlesOnly, unit]);

  const toggleCat = (c: string) => {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const applyEdgePreset = () => {
    setCats(new Set(EDGE_PRESET));
    setOddsMin("1.5");
    setOddsMax("3");
    setSinglesOnly(true);
    setMaxStake("");
  };
  const reset = () => {
    setCats(new Set());
    setOddsMin("");
    setOddsMax("");
    setSinglesOnly(false);
    setMaxStake("");
  };

  const diff = (sim.profitUnits - sim.actualProfitUnits) * unit;
  const roi = sim.stakedUnits > 0 ? (sim.profitUnits / sim.stakedUnits) * 100 : null;

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Tänk om-simulatorn</span>
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Spela om hela historiken med dina regler</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <button className="ap-btn ghost" style={{ padding: "7px 12px", fontSize: 12 }} onClick={applyEdgePreset}>⚡ Edge-paketet</button>
        <button className="ap-btn ghost" style={{ padding: "7px 12px", fontSize: 12 }} onClick={reset}>Nollställ filter</button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        {allCats.map((c) => (
          <button key={c} className={"ap-chip" + (cats.has(c) ? " is-active" : "")} onClick={() => toggleCat(c)}>
            {c}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--dim2)", marginTop: 6 }}>
        {cats.size === 0 ? "Inga kategorichips valda = alla kategorier ingår." : `${cats.size} kategorier valda.`}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
        <div className="ap-field" style={{ width: 92 }}>
          <label>Odds från</label>
          <input className="ap-input ap-num" inputMode="decimal" placeholder="alla" value={oddsMin} onChange={(e) => setOddsMin(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 92 }}>
          <label>Odds till</label>
          <input className="ap-input ap-num" inputMode="decimal" placeholder="alla" value={oddsMax} onChange={(e) => setOddsMax(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 110 }}>
          <label>Max insats (U)</label>
          <input className="ap-input ap-num" inputMode="decimal" placeholder="ingen" value={maxStake} onChange={(e) => setMaxStake(e.target.value)} />
        </div>
        <button className={"ap-chip" + (singlesOnly ? " is-active" : "")} style={{ marginBottom: 4 }} onClick={() => setSinglesOnly(!singlesOnly)}>
          Endast singlar
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 16 }}>
        <MiniStat label="Bets" value={sim.nBets.toLocaleString("sv-SE")} />
        <MiniStat label="P/L" value={krFmt(sim.profitUnits * unit, true)} tone={sim.profitUnits >= 0 ? "pos" : "neg"} />
        <MiniStat label="ROI" value={roi != null ? pctFmt(roi, true) : "—"} tone={(roi ?? 0) >= 0 ? "pos" : "neg"} />
        <MiniStat label="Träff" value={sim.winRatePct != null ? pctFmt(sim.winRatePct) : "—"} />
      </div>

      <div style={{ fontSize: 13, color: "var(--dim)", marginTop: 14, lineHeight: 1.5 }}>
        Med de här reglerna hade du legat på{" "}
        <span className={"ap-num " + (sim.profitUnits >= 0 ? "pos" : "neg")} style={{ fontWeight: 700 }}>{krFmt(sim.profitUnits * unit, true)}</span>
        {" — "}
        <span className={"ap-num " + (diff >= 0 ? "pos" : "neg")} style={{ fontWeight: 700 }}>{krFmt(Math.abs(diff))}</span>{" "}
        {diff >= 0 ? "bättre" : "sämre"} än ditt verkliga resultat.
      </div>

      <div style={{ marginTop: 14 }}>
        <CompareChart a={sim.actual} b={sim.filtered} colorA={cc.dim} colorB={cc.acc} grid={cc.grid} h={210} />
        <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
          <span className="ap-leg" style={{ color: "var(--dim)", fontSize: 12 }}>
            <span className="ap-dot" style={{ background: cc.dim }} /> Verklig P/L
          </span>
          <span className="ap-leg" style={{ color: "var(--dim)", fontSize: 12 }}>
            <span className="ap-dot" style={{ background: cc.acc }} /> Scenario
          </span>
        </div>
      </div>
    </Card>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ background: "var(--card2)", borderRadius: 12, padding: "12px 14px" }}>
      <div className="ap-label">{label}</div>
      <div className={"ap-num " + (tone ?? "")} style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>{value}</div>
    </div>
  );
}
