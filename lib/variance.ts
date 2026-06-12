// "Tur eller skicklighet": compares actual P/L to a no-edge baseline where
// each bet wins with its margin-free implied probability p = 1/odds. Under
// that baseline the expected profit of every bet is exactly 0, so the actual
// total measured in baseline standard deviations (z) says how far from pure
// coin-flip luck the result sits. Persistent positive z over many bets points
// to real edge; a large |z| over few bets is mostly variance.
//
// Caveat baked into the framing: the bookmaker margin means the true win
// probability is below 1/odds, so a slightly negative z is the *expected*
// outcome for a no-edge bettor — present results against that backdrop.
//
// Pure & dependency-free so it is trivially unit-testable.

import { countsForWinRate, settledProfit, type BetLike } from "./betting";

export interface VarianceResult {
  n: number; // bets included (settled win/loss with odds > 1)
  actualUnits: number; // total realized profit
  sigmaUnits: number; // std dev of the no-edge baseline total
  z: number | null; // actual / sigma
  percentile: number | null; // Phi(z) * 100 — share of no-edge worlds doing worse
}

/** Abramowitz & Stegun 7.1.26 — max error ~1.5e-7, plenty for percentiles. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Aggregate no-edge variance over a set of bets. */
export function noEdgeVariance(bets: BetLike[]): VarianceResult {
  let n = 0;
  let actual = 0;
  let varSum = 0;
  for (const b of bets) {
    if (!countsForWinRate(b.outcome)) continue;
    if (!(b.odds > 1) || !(b.stakeUnits > 0)) continue;
    const p = 1 / b.odds;
    // X = stake(odds-1) w.p. p, -stake w.p. 1-p. E[X] = 0, Var = E[X^2].
    varSum += b.stakeUnits * b.stakeUnits * (p * (b.odds - 1) * (b.odds - 1) + (1 - p));
    actual += settledProfit(b);
    n += 1;
  }
  const sigma = Math.sqrt(varSum);
  const z = n > 0 && sigma > 0 ? actual / sigma : null;
  return {
    n,
    actualUnits: actual,
    sigmaUnits: sigma,
    z,
    percentile: z == null ? null : normalCdf(z) * 100,
  };
}

export interface KeyedVariance extends VarianceResult {
  key: string;
}

/**
 * Per-group variance (market category, sport...), best z first. Groups with
 * fewer than minN qualifying bets are dropped — z is meaningless on tiny n.
 */
export function varianceByKey(
  bets: BetLike[],
  keyFn: (b: BetLike) => string | null | undefined,
  minN = 30
): KeyedVariance[] {
  const groups = new Map<string, BetLike[]>();
  for (const b of bets) {
    const k = (keyFn(b) || "Övrigt").toString();
    const arr = groups.get(k);
    if (arr) arr.push(b);
    else groups.set(k, [b]);
  }
  const out: KeyedVariance[] = [];
  for (const [key, group] of groups) {
    const v = noEdgeVariance(group);
    if (v.n >= minN && v.z != null) out.push({ key, ...v });
  }
  out.sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  return out;
}
