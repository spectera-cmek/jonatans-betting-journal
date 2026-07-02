// Weekly & monthly reports: this period vs the previous one (Swedish calendar)
// with a discipline grade — the stake-weighted share of the period's bets that
// avoided the known leak patterns from lib/discipline.
//
// Pure & dependency-free (besides betting/discipline/time helpers) so it is
// trivially unit-testable.

import { isSettled, settledProfit, countsForWinRate, isWinLike, round2, type BetLike } from "./betting";
import { evaluateBet } from "./discipline";
import { dayIso, weekOf, monthOf, addDays, isoWeekNo, type WeekWindow } from "./time";

export interface WeeklyBetInput extends BetLike {
  event?: string;
  selection?: string | null;
  sport?: string | null;
  market?: string | null;
  betType?: string | null;
}

export interface WeekBetRef {
  event: string;
  selection: string;
  odds: number;
  stakeUnits: number;
  profitUnits: number;
}

export interface PeriodAgg {
  start: string; // first day, inclusive (ISO)
  end: string; // last day, inclusive (ISO)
  bets: number;
  settled: number;
  pending: number;
  stakedUnits: number; // settled stake
  profitUnits: number;
  roiPct: number | null;
  winRatePct: number | null;
  disciplinePct: number | null; // stake share (all bets) without leak warnings
  best: WeekBetRef | null;
  worst: WeekBetRef | null;
}

export interface WeekAgg extends PeriodAgg {
  weekNo: number;
}

export interface WeeklyReport {
  current: WeekAgg;
  previous: WeekAgg;
}

export interface MonthAgg extends PeriodAgg {
  month: string; // YYYY-MM
}

export interface MonthlyReport {
  current: MonthAgg;
  previous: MonthAgg;
}

function toTime(d?: Date | string | null): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Same date precedence as the calendar/insights: the bet lives on its event day.
function betTime(b: BetLike): number {
  return toTime(b.eventAt) || toTime(b.placedAt) || toTime(b.createdAt);
}

/** Aggregate one arbitrary {start,end} window — the week/month reports both wrap this. */
export function aggPeriod(bets: WeeklyBetInput[], win: WeekWindow): PeriodAgg {
  let settled = 0;
  let pending = 0;
  let staked = 0;
  let profit = 0;
  let wins = 0;
  let losses = 0;
  let allStake = 0;
  let cleanStake = 0;
  let best: WeekBetRef | null = null;
  let worst: WeekBetRef | null = null;

  for (const b of bets) {
    const t = betTime(b);
    if (!t) continue;
    const day = dayIso(t);
    if (day < win.start || day > win.end) continue;

    if (b.stakeUnits > 0) {
      allStake += b.stakeUnits;
      const verdict = evaluateBet({
        sport: b.sport,
        selection: b.selection,
        market: b.market,
        odds: b.odds,
        stakeUnits: b.stakeUnits,
        betType: b.betType,
      });
      if (!verdict.notes.some((n) => n.tone === "neg")) cleanStake += b.stakeUnits;
    }

    if (!isSettled(b.outcome)) {
      pending += 1;
      continue;
    }
    settled += 1;
    staked += b.stakeUnits;
    const p = settledProfit(b);
    profit += p;
    if (countsForWinRate(b.outcome)) {
      if (isWinLike(b.outcome)) wins += 1;
      else losses += 1;
    }
    const ref: WeekBetRef = {
      event: b.event ?? "",
      selection: b.selection ?? "",
      odds: b.odds,
      stakeUnits: b.stakeUnits,
      profitUnits: round2(p),
    };
    if (p > 0 && (!best || p > best.profitUnits)) best = ref;
    if (p < 0 && (!worst || p < worst.profitUnits)) worst = ref;
  }

  const denom = wins + losses;
  return {
    start: win.start,
    end: win.end,
    bets: settled + pending,
    settled,
    pending,
    stakedUnits: round2(staked),
    profitUnits: round2(profit),
    roiPct: staked > 0 ? (profit / staked) * 100 : null,
    winRatePct: denom > 0 ? (wins / denom) * 100 : null,
    disciplinePct: allStake > 0 ? (cleanStake / allStake) * 100 : null,
    best,
    worst,
  };
}

export function weeklyReport(bets: WeeklyBetInput[], now: Date | number = Date.now()): WeeklyReport {
  const cur = weekOf(now);
  const prev: WeekWindow = { start: addDays(cur.start, -7), end: addDays(cur.start, -1) };
  return {
    current: { ...aggPeriod(bets, cur), weekNo: isoWeekNo(cur.start) },
    previous: { ...aggPeriod(bets, prev), weekNo: isoWeekNo(prev.start) },
  };
}

/** Calendar-month version of the weekly report: this month vs last month. */
export function monthlyReport(bets: WeeklyBetInput[], now: Date | number = Date.now()): MonthlyReport {
  const cur = monthOf(now);
  const prev = monthOf(addDays(cur.start, -1) + "T12:00:00Z");
  return {
    current: { ...aggPeriod(bets, cur), month: cur.start.slice(0, 7) },
    previous: { ...aggPeriod(bets, prev), month: prev.start.slice(0, 7) },
  };
}
