"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty, Skeleton, SportMark } from "@/components/ui";
import { ResultBadge } from "@/components/ResultBadge";
import { useTheme } from "@/components/ThemeProvider";
import { useBets } from "@/lib/useData";
import { hexA, type ChartColors } from "@/lib/theme";
import { krShort, krFmt, uFmt, dateShort } from "@/lib/format";
import { IC } from "@/components/icons";
import { settledProfit } from "@/lib/betting";

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
      else { a.settled += 1; a.profit += settledProfit(b); }
      map.set(iso, a);
    }
    return map;
  }, [bets]);

  // Default the view to the most recent bet month that is not in the future
  // (fall back to today). Futures — a league winner settling next summer — carry
  // an eventAt months ahead, and would otherwise open the calendar on an empty
  // month a year from now.
  const latest = useMemo(() => {
    const now = Date.now();
    let t = 0;
    for (const b of bets) {
      const bt = new Date(b.eventAt ?? b.placedAt).getTime();
      if (bt <= now) t = Math.max(t, bt);
    }
    return t ? new Date(t) : new Date();
  }, [bets]);

  const [view, setView] = useState<{ y: number; m: number } | null>(null);
  const cur = view ?? { y: latest.getFullYear(), m: latest.getMonth() };
  // "" = nothing picked. Until the user picks or pages, the day panel opens on
  // the latest day that has bets, so the pane beside the month is never blank.
  const [picked, setPicked] = useState<string | null>(null);
  const latestIso = useMemo(() => (bets.length ? isoOf(latest) : ""), [bets.length, latest]);
  const selected = picked ?? (view === null ? latestIso : "");
  const setSelected = (iso: string) => setPicked(iso);

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
  const dayAgg = selected ? byDay.get(selected) : undefined;
  const todayIso = isoOf(new Date());

  return (
    <div>
      <Topbar title="Kalender" sub={`${bets.length} bets · välj en dag för att se spelen`} />

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

      {/* The month beside the day it is showing. */}
      <div className="ap-board c21">
        <Card style={{ padding: 0 }}>
          <div className="ap-card-head">
            <div className="ap-stepper">
              <button className="ap-iconbtn" onClick={() => shift(-1)} aria-label="Föregående månad">‹</button>
              <h2 className="ap-card-title">{MONTHS_SV[cur.m]} {cur.y}</h2>
              <button className="ap-iconbtn" onClick={() => shift(1)} aria-label="Nästa månad">›</button>
            </div>
            <span className="ap-t-sm ap-t-dim2">
              {monthTotal.count} bets ·{" "}
              <span className={"ap-num " + (monthTotal.profit >= 0 ? "pos" : "neg")}>{krShort(monthTotal.profit * unit, true)}</span>{" "}
              <span className="ap-num">{uFmt(monthTotal.profit, true)}</span>
            </span>
          </div>

          <div className="ap-cal-grid">
            {WEEKDAYS.map((w) => (
              <div key={w} className="ap-cal-head">{w}</div>
            ))}
            {cells.map((c, i) => {
              if (!c) return <div key={i} className="ap-cal-day is-out" aria-hidden="true" />;
              const a = byDay.get(c.iso);
              const isSel = selected === c.iso;
              const tone = !a || a.settled === 0 ? "" : a.profit >= 0 ? " is-win" : " is-loss";
              return (
                <button
                  key={c.iso}
                  onClick={() => setSelected(isSel ? "" : c.iso)}
                  className={"ap-cal-day" + tone + (isSel ? " is-sel" : "") + (c.iso === todayIso ? " is-today" : "")}
                  aria-pressed={isSel}
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
        <Card className="ap-daypanel" style={{ padding: 0 }}>
          <div className="ap-card-head">
            <h2 className="ap-card-title">{selected ? dateShort(selected) : "Dagens spel"}</h2>
            {selected && (
              <span className="ap-t-sm ap-t-dim2">
                {dayBets.length} {dayBets.length === 1 ? "bet" : "bets"}
                {dayAgg && dayAgg.settled > 0 ? (
                  <>
                    {" · "}
                    <span className={"ap-num " + (dayAgg.profit >= 0 ? "pos" : "neg")}>{krShort(dayAgg.profit * unit, true)}</span>
                  </>
                ) : null}
              </span>
            )}
          </div>
          {loading && bets.length === 0 ? (
            <div className="ap-panel-empty">Laddar…</div>
          ) : !selected ? (
            <Empty icon={IC.calendar} title="Ingen dag vald" hint="Välj en dag i månaden eller i årsöversikten för att se spelen." />
          ) : dayBets.length === 0 ? (
            <div className="ap-panel-empty">Inga spel den här dagen.</div>
          ) : (
            <ul className="ap-daybets">
              {dayBets.map((b) => (
                <li key={b.id} className="ap-openbet">
                  <div className="ap-openbet-main">
                    <div className="ap-openbet-sel" title={b.selection || undefined}>{b.selection || "—"}</div>
                    <div className="ap-openbet-event" title={b.event}>
                      {b.event}
                      {b.league ? ` · ${b.league}` : ""}
                    </div>
                    <div className="ap-openbet-meta">
                      <SportMark sport={b.sport} />
                      <span className="ap-num">
                        {b.stakeUnits.toFixed(2)}U @ {b.odds.toFixed(2)}
                      </span>
                      {b.bookmaker && <span>{b.bookmaker}</span>}
                    </div>
                  </div>
                  <div className="ap-openbet-side">
                    <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
                    <span className={"ap-num ap-t-xs " + (b.outcome === "pending" ? "ap-t-dim2" : (b.profitUnits ?? 0) >= 0 ? "pos" : "neg")}>
                      {b.outcome === "pending" ? "—" : krShort((b.profitUnits ?? 0) * unit, true)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
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
  const CELL = 13;
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
    if (!agg || agg.count === 0) return "var(--card2)";
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

  // The cell that represents the grid in the tab order: the selected day if it
  // is in this year, else the latest day with bets, else January 1st.
  const tabStop = useMemo(() => {
    if (cells.some((c) => c.iso === selected)) return selected;
    let last: string | undefined;
    for (const c of cells) if (c.agg?.count) last = c.iso;
    return last ?? cells[0]?.iso;
  }, [cells, selected]);

  return (
    <Card style={{ padding: 0, marginBottom: 12 }}>
      <div className="ap-card-head">
        <div className="ap-stepper">
          <button className="ap-iconbtn" onClick={() => onShiftYear(-1)} aria-label="Föregående år">‹</button>
          <h2 className="ap-card-title ap-num">{year}</h2>
          <button className="ap-iconbtn" onClick={() => onShiftYear(1)} aria-label="Nästa år">›</button>
        </div>
        <span className="ap-t-sm ap-t-dim2">
          {totals.count} bets · <span className={"ap-num " + (totals.profit >= 0 ? "pos" : "neg")}>{krShort(totals.profit * unit, true)}</span>
        </span>
      </div>

      <div className="ap-heat">
      <div ref={scrollRef} style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ width: nCols * (CELL + GAP) + 26 }}>
          <div style={{ display: "flex", gap: GAP, marginLeft: 26, marginBottom: 4 }}>
            {Array.from({ length: nCols }, (_, c) => (
              <span key={c} className="ap-heat-lbl" style={{ width: CELL }}>
                {monthCols.get(c) ?? ""}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <div style={{ display: "grid", gridTemplateRows: `repeat(7, ${CELL}px)`, rowGap: GAP, width: 22, flexShrink: 0 }}>
              {["M", "", "O", "", "F", "", "S"].map((d, i) => (
                <span key={i} className="ap-heat-lbl" style={{ lineHeight: `${CELL}px` }}>{d}</span>
              ))}
            </div>
            <div
              role="group"
              aria-label={`Årsöversikt ${year} — piltangenterna flyttar mellan dagar`}
              onKeyDown={(e) => {
                // One tab stop for the whole year; arrows move day by day
                // (up/down) and week by week (left/right), Home/End jump to
                // the ends. Cells are laid out column-first, so ±7 is a week.
                const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[e.key];
                const btns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
                const at = btns.indexOf(document.activeElement as HTMLButtonElement);
                if (at < 0) return;
                let to = at;
                if (step != null) to = at + step;
                else if (e.key === "Home") to = 0;
                else if (e.key === "End") to = btns.length - 1;
                else return;
                e.preventDefault();
                btns[Math.max(0, Math.min(btns.length - 1, to))].focus();
              }}
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
                  aria-label={`${dateShort(c.iso)}: ${c.agg?.count ?? 0} bets${c.agg && c.agg.settled > 0 ? `, ${krFmt(c.agg.profit * unit, true)}` : ""}`}
                  aria-pressed={selected === c.iso}
                  // Roving tabindex: 365 cells would otherwise be 365 tab stops.
                  tabIndex={c.iso === tabStop ? 0 : -1}
                  style={{
                    gridRow: c.row + 1,
                    gridColumn: c.col + 1,
                    width: CELL,
                    height: CELL,
                    borderRadius: 1,
                    border: 0,
                    // Selected: an amber frame drawn outside the cell, so the
                    // day's own colour stays readable inside it.
                    outline: selected === c.iso ? "2px solid var(--acc)" : undefined,
                    outlineOffset: selected === c.iso ? 1 : undefined,
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
      <div className="ap-heat-legend">
        <i style={{ background: hexA(cc.red, 0.7) }} /> förlust
        <i style={{ background: "var(--card2)" }} /> inga bets
        <i style={{ background: hexA(cc.pos, 0.7) }} /> vinst
      </div>
      </div>
    </Card>
  );
}
