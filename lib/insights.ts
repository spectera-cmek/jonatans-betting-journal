// Personal "form" insights derived purely from the bet history — no API, no
// closing odds. These replace the dead CLV / single-bookmaker widgets with
// numbers that actually mean something for a recreational bettor.
//
// Pure & dependency-free (only imports the math helpers) so it is trivially
// unit-testable. Everything is in UNITS; format to currency at display time.

import {
  isSettled,
  settledProfit,
  countsForWinRate,
  isWinLike,
  type BetLike,
} from "./betting";

function toTime(d?: Date | string | null): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function betTime(b: BetLike): number {
  return toTime(b.eventAt) || toTime(b.placedAt) || toTime(b.createdAt);
}

function isoDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/* --------------------------------- Streaks -------------------------------- */

export interface StreakInfo {
  longestWin: number;
  longestLoss: number;
  current: number; // length of the trailing run (always >= 0)
  currentType: "win" | "loss" | "none";
}

/**
 * Win/loss streaks over settled win-or-loss bets ordered by event time.
 * Push/void/pending are skipped (they don't break or extend a streak).
 */
export function streaks(bets: BetLike[]): StreakInfo {
  const seq = bets
    .filter((b) => countsForWinRate(b.outcome))
    .map((b) => ({ t: betTime(b), win: isWinLike(b.outcome) }))
    .sort((a, b) => a.t - b.t);

  let longestWin = 0;
  let longestLoss = 0;
  let run = 0;
  let runWin: boolean | null = null;
  for (const s of seq) {
    if (s.win === runWin) run += 1;
    else {
      run = 1;
      runWin = s.win;
    }
    if (s.win) longestWin = Math.max(longestWin, run);
    else longestLoss = Math.max(longestLoss, run);
  }

  // Current streak = trailing run from the most recent bet backwards.
  let current = 0;
  let curWin = false;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (i === seq.length - 1) {
      current = 1;
      curWin = seq[i].win;
    } else if (seq[i].win === curWin) {
      current += 1;
    } else break;
  }

  return {
    longestWin,
    longestLoss,
    current,
    currentType: seq.length ? (curWin ? "win" : "loss") : "none",
  };
}

/* ------------------------------ Best / worst day -------------------------- */

export interface DayPL {
  date: string; // ISO day
  profitUnits: number;
  bets: number;
}

export function bestWorstDay(bets: BetLike[]): {
  best: DayPL | null;
  worst: DayPL | null;
} {
  const map = new Map<string, { p: number; n: number }>();
  for (const b of bets) {
    if (!isSettled(b.outcome)) continue;
    const t = betTime(b);
    if (!t) continue;
    const iso = isoDay(t);
    const e = map.get(iso) ?? { p: 0, n: 0 };
    e.p += settledProfit(b);
    e.n += 1;
    map.set(iso, e);
  }

  let best: DayPL | null = null;
  let worst: DayPL | null = null;
  for (const [date, { p, n }] of map) {
    if (!best || p > best.profitUnits) best = { date, profitUnits: p, bets: n };
    if (!worst || p < worst.profitUnits) worst = { date, profitUnits: p, bets: n };
  }
  return { best, worst };
}

/* ------------------------------- Avg stake -------------------------------- */

export function avgStakeUnits(bets: BetLike[]): number | null {
  const settled = bets.filter((b) => isSettled(b.outcome));
  if (!settled.length) return null;
  return settled.reduce((a, b) => a + b.stakeUnits, 0) / settled.length;
}

/* ---------------------------- Month over month ---------------------------- */

export interface MonthPL {
  month: string; // YYYY-MM
  profitUnits: number;
  bets: number;
}

/** Latest month with settled bets + the month immediately before it (by key). */
export function monthOverMonth(bets: BetLike[]): {
  current: MonthPL | null;
  previous: MonthPL | null;
} {
  const map = new Map<string, { p: number; n: number }>();
  for (const b of bets) {
    if (!isSettled(b.outcome)) continue;
    const t = betTime(b);
    if (!t) continue;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const e = map.get(key) ?? { p: 0, n: 0 };
    e.p += settledProfit(b);
    e.n += 1;
    map.set(key, e);
  }
  const keys = [...map.keys()].sort();
  const at = (i: number): MonthPL | null =>
    i >= 0 && i < keys.length
      ? { month: keys[i], profitUnits: map.get(keys[i])!.p, bets: map.get(keys[i])!.n }
      : null;
  return { current: at(keys.length - 1), previous: at(keys.length - 2) };
}

/* ----------------------------- Day of week -------------------------------- */

export interface WeekdayPL {
  weekday: number; // 0 = Monday … 6 = Sunday
  profitUnits: number;
  bets: number;
  roiPct: number | null;
}

/** P/L per weekday (Monday-first) across settled bets. */
export function byWeekday(bets: BetLike[]): WeekdayPL[] {
  const p = new Array(7).fill(0);
  const n = new Array(7).fill(0);
  const staked = new Array(7).fill(0);
  for (const b of bets) {
    if (!isSettled(b.outcome)) continue;
    const t = betTime(b);
    if (!t) continue;
    const wd = (new Date(t).getDay() + 6) % 7; // Mon=0 … Sun=6
    p[wd] += settledProfit(b);
    n[wd] += 1;
    staked[wd] += b.stakeUnits;
  }
  return p.map((profit, i) => ({
    weekday: i,
    profitUnits: profit,
    bets: n[i],
    roiPct: staked[i] > 0 ? (profit / staked[i]) * 100 : null,
  }));
}

/* ------------------------------ Bundle for API ---------------------------- */

export interface Insights {
  streaks: StreakInfo;
  best: DayPL | null;
  worst: DayPL | null;
  avgStakeUnits: number | null;
  monthCurrent: MonthPL | null;
  monthPrevious: MonthPL | null;
  byWeekday: WeekdayPL[];
}

export function computeInsights(bets: BetLike[]): Insights {
  const s = streaks(bets);
  const { best, worst } = bestWorstDay(bets);
  const { current, previous } = monthOverMonth(bets);
  return {
    streaks: s,
    best,
    worst,
    avgStakeUnits: avgStakeUnits(bets),
    monthCurrent: current,
    monthPrevious: previous,
    byWeekday: byWeekday(bets),
  };
}
