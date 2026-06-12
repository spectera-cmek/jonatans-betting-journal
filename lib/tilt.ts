// Tilt guard: stake budgets + chasing detection over the live bet list.
// Budget windows follow the Swedish calendar day/week (lib/time). "Staked
// today" counts every bet placed today, settled or not — exposure is exposure.
//
// Pure & dependency-free (besides betting/time helpers) so it is trivially
// unit-testable from both the API route and scripts.

import { countsForWinRate, isWinLike, round2, type BetLike } from "./betting";
import { dayIso, weekOf } from "./time";

export interface TiltBudgets {
  dailyBudgetUnits: number | null; // null/0 = budget off
  weeklyBudgetUnits: number | null;
}

export type TiltLevel = "ok" | "warn" | "danger";

export interface TiltStatus {
  level: TiltLevel;
  notes: string[];
  stakedTodayUnits: number;
  betsToday: number;
  stakedWeekUnits: number;
  betsWeek: number;
  dailyBudgetUnits: number | null;
  weeklyBudgetUnits: number | null;
  lossStreak: number; // trailing consecutive losses among settled bets
  chasing: boolean;
}

// Recent stake must exceed the baseline by this factor to flag chasing.
const CHASE_STAKE_FACTOR = 1.5;
const CHASE_MIN_STREAK = 3;

function toTime(d?: Date | string | null): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function placedTime(b: BetLike): number {
  return toTime(b.placedAt) || toTime(b.eventAt) || toTime(b.createdAt);
}

function eventTime(b: BetLike): number {
  return toTime(b.eventAt) || toTime(b.placedAt) || toTime(b.createdAt);
}

function fmtU(n: number): string {
  return n.toLocaleString("sv-SE", { maximumFractionDigits: 1 }) + " u";
}

/** Trailing consecutive losses among settled win/loss bets, by event time. */
export function currentLossStreak(bets: BetLike[]): number {
  const seq = bets
    .filter((b) => countsForWinRate(b.outcome))
    .map((b) => ({ t: eventTime(b), win: isWinLike(b.outcome) }))
    .sort((a, b) => a.t - b.t);
  let n = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i].win) break;
    n += 1;
  }
  return n;
}

/**
 * Chasing = a loss streak running AND the latest stakes clearly above the
 * personal baseline (mean stake of the ~30 bets placed before the recent 3).
 */
export function isChasing(bets: BetLike[], lossStreak: number): boolean {
  if (lossStreak < CHASE_MIN_STREAK) return false;
  const byPlaced = [...bets].sort((a, b) => placedTime(a) - placedTime(b));
  if (byPlaced.length < 5) return false;
  const recent = byPlaced.slice(-3);
  const baseline = byPlaced.slice(-33, -3);
  if (!baseline.length) return false;
  const avg = (arr: BetLike[]) => arr.reduce((s, b) => s + b.stakeUnits, 0) / arr.length;
  return avg(recent) >= CHASE_STAKE_FACTOR * avg(baseline);
}

/** Evaluate budgets + chasing for the banner and the add-bet guard. */
export function tiltStatus(
  bets: BetLike[],
  budgets: TiltBudgets,
  now: Date | number = Date.now()
): TiltStatus {
  const today = dayIso(now);
  const week = weekOf(now);

  let stakedToday = 0;
  let betsToday = 0;
  let stakedWeek = 0;
  let betsWeek = 0;
  for (const b of bets) {
    const day = dayIso(placedTime(b) || Date.now());
    if (day === today) {
      stakedToday += b.stakeUnits;
      betsToday += 1;
    }
    if (day >= week.start && day <= week.end) {
      stakedWeek += b.stakeUnits;
      betsWeek += 1;
    }
  }

  const daily = budgets.dailyBudgetUnits && budgets.dailyBudgetUnits > 0 ? budgets.dailyBudgetUnits : null;
  const weekly = budgets.weeklyBudgetUnits && budgets.weeklyBudgetUnits > 0 ? budgets.weeklyBudgetUnits : null;

  const lossStreak = currentLossStreak(bets);
  const chasing = isChasing(bets, lossStreak);

  const notes: string[] = [];
  let level: TiltLevel = "ok";
  const raise = (l: TiltLevel) => {
    if (l === "danger" || (l === "warn" && level === "ok")) level = l;
  };

  if (daily != null && stakedToday >= daily) {
    raise("danger");
    notes.push(`Dagsbudgeten är nådd: ${fmtU(stakedToday)} av ${fmtU(daily)}. Inga fler spel idag.`);
  } else if (daily != null && stakedToday >= 0.75 * daily) {
    raise("warn");
    notes.push(`${Math.round((stakedToday / daily) * 100)} % av dagsbudgeten är använd (${fmtU(stakedToday)} av ${fmtU(daily)}).`);
  }

  if (weekly != null && stakedWeek >= weekly) {
    raise("danger");
    notes.push(`Veckobudgeten är nådd: ${fmtU(stakedWeek)} av ${fmtU(weekly)}. Stäng boken för veckan.`);
  } else if (weekly != null && stakedWeek >= 0.75 * weekly) {
    raise("warn");
    notes.push(`${Math.round((stakedWeek / weekly) * 100)} % av veckobudgeten är använd (${fmtU(stakedWeek)} av ${fmtU(weekly)}).`);
  }

  if (chasing) {
    raise(lossStreak >= 5 ? "danger" : "warn");
    notes.push(`${lossStreak} förluster i rad och insatserna ökar — klassiskt chasing-mönster. Ta en paus.`);
  } else if (lossStreak >= 5) {
    raise("warn");
    notes.push(`${lossStreak} förluster i rad — håll insatsen nere tills formen vänder.`);
  }

  return {
    level,
    notes,
    stakedTodayUnits: round2(stakedToday),
    betsToday,
    stakedWeekUnits: round2(stakedWeek),
    betsWeek,
    dailyBudgetUnits: daily,
    weeklyBudgetUnits: weekly,
    lossStreak,
    chasing,
  };
}
