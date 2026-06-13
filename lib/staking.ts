// Pure staking math — Kelly criterion + bankroll-safety helpers. Units only,
// dependency-free so it is trivially unit-testable (mirrors lib/betting.ts).

/**
 * Full Kelly fraction of bankroll for a single bet.
 *   f* = (b·p − q) / b      with b = odds−1, p = win prob, q = 1−p
 * Returns 0 when there's no edge (f* ≤ 0) — Kelly says don't bet.
 * `odds` are decimal (>1), `winProb` is 0..1.
 */
export function kellyFraction(odds: number, winProb: number): number {
  if (!(odds > 1) || !(winProb > 0) || winProb >= 1) return 0;
  const b = odds - 1;
  const q = 1 - winProb;
  const f = (b * winProb - q) / b;
  return f > 0 ? f : 0;
}

/** Expected value per unit staked: p·(odds−1) − q. Positive = +EV. */
export function expectedValuePerUnit(odds: number, winProb: number): number {
  if (!(odds > 1) || !(winProb >= 0)) return 0;
  const q = 1 - winProb;
  return winProb * (odds - 1) - q;
}

export interface KellyAdvice {
  edge: number; // EV per unit staked (fraction; 0.04 = +4%)
  full: number; // full Kelly fraction of bankroll (0..1)
  half: number;
  quarter: number;
  fullUnits: number; // full Kelly translated to units, given bankroll
  halfUnits: number;
  quarterUnits: number;
  hasEdge: boolean;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function kellyAdvice(odds: number, winProb: number, bankrollUnits: number): KellyAdvice {
  const full = kellyFraction(odds, winProb);
  const bank = bankrollUnits > 0 ? bankrollUnits : 0;
  return {
    edge: expectedValuePerUnit(odds, winProb),
    full,
    half: full / 2,
    quarter: full / 4,
    fullUnits: r2(full * bank),
    halfUnits: r2((full / 2) * bank),
    quarterUnits: r2((full / 4) * bank),
    hasEdge: full > 0,
  };
}

/** Win probability the odds imply (1/odds), as a fraction 0..1. */
export function impliedProb(odds: number): number | null {
  return odds > 1 ? 1 / odds : null;
}

/**
 * How many consecutive flat-staked losses the bankroll can absorb before it's
 * wiped out — the figure a bettor actually reasons about for risk of ruin.
 */
export function survivableLossStreak(bankrollUnits: number, stakeUnits: number): number {
  if (stakeUnits <= 0) return Infinity;
  if (bankrollUnits <= 0) return 0;
  return Math.floor(bankrollUnits / stakeUnits);
}
