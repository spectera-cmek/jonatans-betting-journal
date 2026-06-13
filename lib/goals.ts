// Pure goal / pace math. Units only, dependency-free for easy unit testing.

export interface GoalProgress {
  goalUnits: number;
  profitUnits: number; // realised so far in the period
  pct: number; // progress toward goal, 0..(100+)
  elapsedFraction: number; // 0..1 of the period elapsed
  projectedUnits: number; // profit extrapolated to period end at current pace
  onTrack: boolean; // projection ≥ goal
  remainingUnits: number; // goal − profit, never below 0
}

/**
 * Progress toward a units goal. `elapsedFraction` is how far through the period
 * we are (0..1); the projection linearly extrapolates the current pace.
 */
export function goalProgress(
  goalUnits: number,
  profitUnits: number,
  elapsedFraction: number
): GoalProgress {
  const ef = Math.min(1, Math.max(0, elapsedFraction)) || 0;
  const projected = ef > 0 ? profitUnits / ef : profitUnits;
  return {
    goalUnits,
    profitUnits,
    pct: goalUnits > 0 ? (profitUnits / goalUnits) * 100 : 0,
    elapsedFraction: ef,
    projectedUnits: projected,
    onTrack: projected >= goalUnits,
    remainingUnits: Math.max(0, goalUnits - profitUnits),
  };
}

/** Fraction of the current month elapsed, by day (day 1 → 1/N, not 0). */
export function monthElapsedFraction(now = new Date()): number {
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return now.getDate() / days;
}

/** Fraction of the current year elapsed, by time (handles leap years). */
export function yearElapsedFraction(now = new Date()): number {
  const start = new Date(now.getFullYear(), 0, 1).getTime();
  const end = new Date(now.getFullYear() + 1, 0, 1).getTime();
  return (now.getTime() - start) / (end - start);
}
