"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Skeleton } from "@/components/ui";
import { ResultBadge } from "@/components/ResultBadge";
import { useTheme } from "@/components/ThemeProvider";
import { useBets } from "@/lib/useData";
import { hexA, type ChartColors } from "@/lib/theme";
import { krShort, krFmt, uFmt, sportTag, dateShort } from "@/lib/format";
import { I, IC } from "@/components/icons";

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
const MONTHS_SV = ["Januari", "Februari", "Mars", "April", "Maj", "Juni", "Juli", "Augusti", "September", "Oktober", "November", "December"];

interface DayAgg { profit: number; count: number; pending: number; settled: number }

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CalendarPage() {
  const { cc } = useTheme();
  const { bets, settings, loading } = useBets();
  const unit = settings?.unitValue ?? 100;

  // Aggregate P/L per ISO day.
  const byDay = useMemo(() => {
    const map = new Map<string, DayAgg>();
    for (const b of bets) {
      const iso = isoOf(new Date(b.eventAt ?? b.placedAt));
      const a = map.get(iso) ?? { profit: 0, count: 0, pending: 0, settled: 0 };
      a.count += 1;
      if (b.outcome === "pending") a.pending += 1;
      else { a.settled += 1; a.profit += b.profitUnits ?? 0; }
      map.set(iso, a);
    }
    return map;
  }, [bets]);

  // Default the view to the most recent bet month (fall back to today).
  const latest = useMemo(() => {
    let t = 0;
    for (const b of bets) t = Math.max(t, new Date(b.eventAt ?? b.placedAt).getTime());
    return t ? new Date(t) : new Date();
  }, [bets]);

  const [view, setView] = useState<{ y: number; m: number } | null>(null);
  const cur = view ?? { y: latest.getFullYear(), m: latest.getMonth() };
  const [selected, setSelected] = useState<string>("");

  const shift = (delta: number) => {
    const d = new Date(cur.y, cur.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
    setSelected("");
  };

  // Build the calendar grid (Monday-first) for the viewed month.
  const cells = useMemo(() => {
    const first = new Date(cur.y, cur.m, 1);
    const lead = (first.getDay() + 6) % 7; // Mon=0
    const days = new Date(cur.y, cur.m + 1, 0).getDate();
    const out: ({ iso: string; day: number } | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push({ iso: isoOf(new Date(cur.y, cur.m, d)), day: d });
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cur.y, cur.m]);

  // Month total.
  const monthTotal = useMemo(() => {
    let profit = 0, count = 0;
    for (const c of cells) {
      if (!c) continue;
      const a = byDay.get(c.iso);
      if (a) { profit += a.profit; count += a.count; }
    }
    return { profit, count };
  }, [cells, byDay]);

  const dayBets = useMemo(
    () => (selected ? bets.filter((b) => isoOf(new Date(b.eventAt ?? b.placedAt)) === selected) : []),
    [bets, selected]
  );

  const tint = (profit: number, settled: number) => {
    if (settled === 0) return "transparent";
    return (profit >= 0 ? cc.pos : cc.red) + "22";
  };

  return (
    <div>
      <Topbar title="Kalender" sub={`${bets.length} bets · klicka på en dag för att se spelen`} />

      {loading && bets.length === 0 ? (
        <Card style={{ marginBottom: 12 }}>
          <Skeleton w={140} h={12} />
          <Skeleton h={110} style={{ marginTop: 14 }} />
        </Card>
      ) : (
        <YearHeatmap
          year={cur.y}
          byDay={byDay}
          unit={unit}
          cc={cc}
          selected={selected}
          onShiftYear={(dy) => {
            setView({ y: cur.y + dy, m: cur.m });
            setSelected("");
          }}
          onPick={(iso) => {
            setView({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) - 1 });
            setSelected(iso);
          }}
        />
      )}

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button className="ap-iconbtn" onClick={() => shift(-1)} aria-label="Föregående månad">‹</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{MONTHS_SV[cur.m]} {cur.y}</div>
            <div style={{ fontSize: 12, color: "var(--dim2)" }}>
              {monthTotal.count} bets · <em className={monthTotal.profit >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal", fontWeight: 600 }}>{krShort(monthTotal.profit * unit, true)}</em> <span style={{ color: "var(--dim2)" }}>{uFmt(monthTotal.profit, true)}</span>
            </div>
          </div>
          <button className="ap-iconbtn" onClick={() => shift(1)} aria-label="Nästa månad">›</button>
        </div>

        <div className="ap-cal-grid">
          {WEEKDAYS.map((w) => (
            <div key={w} style={{ textAlign: "center", fontSize: 11, color: "var(--dim2)", fontWeight: 600, paddingBottom: 4 }}>{w}</div>
          ))}
          {cells.map((c, i) => {
            if (!c) return <div key={i} />;
            const a = byDay.get(c.iso);
            const isSel = selected === c.iso;
            return (
              <button
                key={c.iso}
                onClick={() => setSelected(isSel ? "" : c.iso)}
                className="ap-cal-day"
                style={{
                  background: tint(a?.profit ?? 0, a?.settled ?? 0),
                  border: `1px solid ${isSel ? cc.acc : "var(--grid, rgba(255,255,255,.06))"}`,
                }}
              >
                <span className="ap-cal-num">{c.day}</span>
                {a ? (
                  <span className="ap-cal-body">
                    <em className={a.settled === 0 ? "" : a.profit >= 0 ? "pos" : "neg"}>
                      <span className="ap-cal-val-u">{a.settled === 0 ? "—" : uFmt(a.profit, true)}</span>
                      <span className="ap-cal-val-kr">{a.settled === 0 ? "—" : krShort(Math.round(a.profit * unit), true)}</span>
                    </em>
                    <span className="ap-cal-sub">{a.count} {a.count === 1 ? "bet" : "bets"}{a.pending ? ` · ${a.pending} öppna` : ""}</span>
                  </span>
                ) : (
                  <span />
                )}
                {a?.pending ? <span className="ap-cal-dot" /> : null}
              </button>
            );
          })}
        </div>
      </Card>

      {/* Selected-day bets */}
      {selected && (
        <Card style={{ padding: 0, marginTop: 12 }}>
          <div className="ap-card-head">
            <span className="ap-card-title">Spel {selected}</span>
            <span style={{ color: "var(--dim2)", fontSize: 12 }}>{dayBets.length} bets</span>
          </div>
          <div className="ap-table-wrap">
            <div className="ap-table">
              <div className="ap-thead" style={{ gridTemplateColumns: "46px 1.4fr 1.1fr 70px 64px 96px" }}>
                <span>Sport</span><span>Match</span><span>Spel</span><span className="ap-r">Odds</span><span className="ap-r">Insats</span><span className="ap-r">Resultat</span>
              </div>
              {dayBets.length === 0 && <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--dim2)" }}>Inga spel den här dagen.</div>}
              {dayBets.map((b) => (
                <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: "46px 1.4fr 1.1fr 70px 64px 96px" }}>
                  <span><span className="ap-tag">{sportTag(b.sport)}</span></span>
                  <span className="ap-ell">{b.event}{b.market ? <span style={{ color: "var(--dim2)" }}> · {b.market}</span> : null}</span>
                  <span className="ap-ell" style={{ color: "var(--dim)" }}>{b.selection || "—"}</span>
                  <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                  <span className="ap-r ap-num">{b.stakeUnits.toFixed(2)}U</span>
                  <span className="ap-r"><ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} /></span>
                </div>
              ))}
            </div>
          </div>
          <div className="ap-betcards" style={{ padding: "12px 14px 14px" }}>
            {dayBets.length === 0 && <div className="ap-betcard-empty">Inga spel den här dagen.</div>}
            {dayBets.map((b) => (
              <div key={b.id} className="ap-betcard">
                <div className="ap-betcard-top">
                  <span className="ap-betcard-date"><span className="ap-tag">{sportTag(b.sport)}</span></span>
                  <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
                </div>
                <div className="ap-betcard-event">
                  {b.event}{b.market ? <span style={{ color: "var(--dim2)" }}> · {b.market}</span> : null}
                </div>
                <div className="ap-betcard-sel">{b.selection || "—"}</div>
                <div className="ap-betcard-stats">
                  <div><span>Odds</span><b className="ap-num">{b.odds.toFixed(2)}</b></div>
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
      )}

      {loading && <div style={{ padding: "24px", textAlign: "center", color: "var(--dim2)" }}>Laddar…</div>}
      {!loading && !selected && (
        <div style={{ marginTop: 12, textAlign: "center", color: "var(--dim2)", fontSize: 13, display: "flex", gap: 6, justifyContent: "center", alignItems: "center" }}>
          <I p={IC.calendar} size={15} /> Klicka på en dag i kalendern för att se spelen.
        </div>
      )}
    </div>
  );
}

const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

// GitHub-style year overview: one column per week, one cell per day, tinted by
// the day's settled P/L. Intensity is scaled against the year's 90th-percentile
// day so a single outlier doesn't wash everything else out.
function YearHeatmap({
  year,
  byDay,
  unit,
  cc,
  selected,
  onShiftYear,
  onPick,
}: {
  year: number;
  byDay: Map<string, DayAgg>;
  unit: number;
  cc: ChartColors;
  selected: string;
  onShiftYear: (dy: number) => void;
  onPick: (iso: string) => void;
}) {
  const CELL = 12;
  const GAP = 2;

  const { cells, monthCols, nCols, totals, scale } = useMemo(() => {
    const start = new Date(year, 0, 1);
    const lead = (start.getDay() + 6) % 7; // Mon=0
    const days = (new Date(year + 1, 0, 1).getTime() - start.getTime()) / 864e5;
    const cells: { iso: string; col: number; row: number; agg?: DayAgg }[] = [];
    const monthCols = new Map<number, string>();
    const absDays: number[] = [];
    const totals = { profit: 0, count: 0 };
    for (let d = 0; d < days; d++) {
      const date = new Date(year, 0, 1 + d);
      const iso = isoOf(date);
      const idx = lead + d;
      const agg = byDay.get(iso);
      if (date.getDate() === 1) monthCols.set(Math.floor(idx / 7), MONTHS_SHORT[date.getMonth()]);
      if (agg) {
        totals.profit += agg.profit;
        totals.count += agg.count;
        if (agg.settled > 0) absDays.push(Math.abs(agg.profit));
      }
      cells.push({ iso, col: Math.floor(idx / 7), row: idx % 7, agg });
    }
    absDays.sort((a, b) => a - b);
    const p90 = absDays.length ? absDays[Math.floor(0.9 * (absDays.length - 1))] : 0;
    return { cells, monthCols, nCols: Math.ceil((lead + days) / 7), totals, scale: p90 || 1 };
  }, [year, byDay]);

  const fill = (agg?: DayAgg): string => {
    if (!agg || agg.count === 0) return "var(--hover)";
    if (agg.settled === 0) return "var(--line)"; // only open bets
    const alpha = 0.16 + 0.74 * Math.min(1, Math.abs(agg.profit) / scale);
    return hexA(agg.profit >= 0 ? cc.pos : cc.red, alpha);
  };

  // On a phone the year is wider than the screen and the container opens scrolled
  // to January — scroll so the latest week with bets is in view instead.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastCol = 0;
    for (const c of cells) if (c.agg?.count) lastCol = Math.max(lastCol, c.col);
    el.scrollLeft = Math.max(0, 26 + (lastCol + 1) * (CELL + GAP) + 12 - el.clientWidth);
  }, [cells]);

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <button className="ap-iconbtn" onClick={() => onShiftYear(-1)} aria-label="Föregående år">‹</button>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{year}</div>
          <div style={{ fontSize: 12, color: "var(--dim2)" }}>
            {totals.count} bets · <em className={totals.profit >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal", fontWeight: 600 }}>{krShort(totals.profit * unit, true)}</em>
          </div>
        </div>
        <button className="ap-iconbtn" onClick={() => onShiftYear(1)} aria-label="Nästa år">›</button>
      </div>

      <div ref={scrollRef} style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ width: nCols * (CELL + GAP) + 26 }}>
          <div style={{ display: "flex", gap: GAP, marginLeft: 26, marginBottom: 4 }}>
            {Array.from({ length: nCols }, (_, c) => (
              <span key={c} style={{ width: CELL, fontSize: 9.5, color: "var(--dim2)", overflow: "visible", whiteSpace: "nowrap" }}>
                {monthCols.get(c) ?? ""}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <div style={{ display: "grid", gridTemplateRows: `repeat(7, ${CELL}px)`, rowGap: GAP, width: 22, flexShrink: 0 }}>
              {["M", "", "O", "", "F", "", "S"].map((d, i) => (
                <span key={i} style={{ fontSize: 9.5, color: "var(--dim2)", lineHeight: `${CELL}px` }}>{d}</span>
              ))}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateRows: `repeat(7, ${CELL}px)`,
                gridAutoFlow: "column",
                gridAutoColumns: `${CELL}px`,
                gap: GAP,
              }}
            >
              {cells.map((c) => (
                <button
                  key={c.iso}
                  onClick={() => onPick(c.iso)}
                  title={`${dateShort(c.iso)} · ${c.agg && c.agg.settled > 0 ? krFmt(c.agg.profit * unit, true) : "—"} · ${c.agg?.count ?? 0} bets`}
                  aria-label={c.iso}
                  style={{
                    gridRow: c.row + 1,
                    gridColumn: c.col + 1,
                    width: CELL,
                    height: CELL,
                    borderRadius: 3,
                    border: selected === c.iso ? `1.5px solid ${cc.acc}` : "1px solid transparent",
                    background: fill(c.agg),
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 11, color: "var(--dim2)" }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: hexA(cc.red, 0.65), display: "inline-block" }} /> förlust
        <span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--hover)", display: "inline-block", marginLeft: 6 }} /> inga bets
        <span style={{ width: 9, height: 9, borderRadius: 2, background: hexA(cc.pos, 0.65), display: "inline-block", marginLeft: 6 }} /> vinst
      </div>
    </Card>
  );
}
