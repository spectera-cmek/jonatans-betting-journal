// Pure fair-odds math for multi-leg specials (bet builders) — de-vig bookmaker
// prices to fair probabilities, combine the legs and price the combo. Units of
// nothing but probabilities and decimal odds; dependency-free so it is
// trivially unit-testable (mirrors lib/staking.ts).

export const DEFAULT_ONE_SIDED_MARGIN_PCT = 6; // typical player-prop overround
export const MARGIN_PCT_MIN = 0;
export const MARGIN_PCT_MAX = 50; // goalscorer books (första/anytime målskytt) run 25–45%
export const ET_BOOST_PCT_MAX = 30; // extra-time playing-time bonus, ~7% typical in knockouts
export const RHO_MIN = -0.2;
export const RHO_MAX = 0.6;
export const MAX_LEGS = 6;

const P_EPS = 1e-9;
const clampProb = (p: number) => Math.min(1 - P_EPS, Math.max(P_EPS, p));

export interface DevigResult {
  p: number; // fair probability of the bettor's outcome, in (0,1)
  overround: number; // market margin as a fraction (0.053 = 5.3%)
  lambda?: number; // Poisson modes: match/combined expected goals
  lambdaPlayer?: number; // player+Ö/U mode: player involvement rate
  q?: number; // player+Ö/U mode: share of match goals involving the player
}

/**
 * Proportional (multiplicative) de-vig for an n-outcome market:
 *   p = (1/myOdds) / Σ(1/odds_k)
 * `otherOdds` holds the remaining outcomes' prices (1 entry for over/under,
 * 2 for a 1X2 leg). Null when no opposing price is given or any odds ≤ 1.
 */
export function devigProportional(myOdds: number, otherOdds: number[]): DevigResult | null {
  const valid = (o: number) => Number.isFinite(o) && o > 1;
  if (!valid(myOdds) || otherOdds.length === 0 || !otherOdds.every(valid)) return null;
  const mine = 1 / myOdds;
  const book = otherOdds.reduce((s, o) => s + 1 / o, mine);
  return { p: clampProb(mine / book), overround: book - 1 };
}

/**
 * One-sided fallback for markets where only the bettor's price is visible
 * (common for player props): assume the market carries `marginPct` overround
 * shared proportionally → p = (1/myOdds) / (1 + margin).
 */
export function devigOneSided(
  myOdds: number,
  marginPct: number = DEFAULT_ONE_SIDED_MARGIN_PCT
): DevigResult | null {
  if (!Number.isFinite(myOdds) || !(myOdds > 1) || !Number.isFinite(marginPct)) return null;
  const margin = Math.min(MARGIN_PCT_MAX, Math.max(MARGIN_PCT_MIN, marginPct)) / 100;
  return { p: clampProb(1 / myOdds / (1 + margin)), overround: margin };
}

/**
 * Poisson rate that reproduces an anytime-scorer probability:
 *   P(X ≥ 1) = 1 − e^(−λ)  →  λ = −ln(1 − p)
 */
export function lambdaFromScoreProb(p: number): number {
  return -Math.log(1 - clampProb(p));
}

/** P(X ≥ k) for X ~ Poisson(lambda), via the complement of the CDF. */
export function poissonAtLeast(k: number, lambda: number): number {
  if (k <= 0) return 1;
  if (!(lambda > 0)) return 0;
  let term = Math.exp(-lambda); // P(X = 0)
  let cdf = term;
  for (let j = 1; j < k; j++) {
    term *= lambda / j;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/**
 * "Mål tillsammans"-specials (e.g. two players combined over 1.5 goals) from
 * the players' anytime-scorer prices: de-vig each price one-sidedly, convert
 * to a Poisson rate, sum the rates (players assumed independent) and take the
 * tail P(total ≥ minGoals). `minGoals` is the line's threshold: Ö0.5 → 1,
 * Ö1.5 → 2, Ö2.5 → 3. `etBoostPct` scales the rates up when the special
 * includes extra time the anytime prices don't (~7% typical in knockouts).
 */
export function devigPoissonGoals(
  anytimeOdds: number[],
  minGoals: number,
  marginPct: number = DEFAULT_ONE_SIDED_MARGIN_PCT,
  etBoostPct = 0
): DevigResult | null {
  if (anytimeOdds.length === 0) return null;
  if (!Number.isInteger(minGoals) || minGoals < 1) return null;
  if (!Number.isFinite(marginPct) || !Number.isFinite(etBoostPct)) return null;
  const margin = Math.min(MARGIN_PCT_MAX, Math.max(MARGIN_PCT_MIN, marginPct)) / 100;
  const boost = 1 + Math.min(ET_BOOST_PCT_MAX, Math.max(0, etBoostPct)) / 100;
  let lambda = 0;
  for (const o of anytimeOdds) {
    if (!Number.isFinite(o) || !(o > 1)) return null;
    lambda += lambdaFromScoreProb(1 / o / (1 + margin));
  }
  lambda *= boost;
  return { p: clampProb(poissonAtLeast(minGoals, lambda)), overround: margin, lambda };
}

/**
 * Invert an over-line probability into a Poisson rate: the λ that gives
 * P(N ≥ k) = pOver. poissonAtLeast is strictly increasing in λ → bisection.
 */
export function lambdaFromOverProb(k: number, pOver: number): number | null {
  if (!Number.isInteger(k) || k < 1 || !Number.isFinite(pOver)) return null;
  const p = clampProb(pOver);
  let lo = 0;
  let hi = 40; // P(N ≥ 6) at λ = 40 is ≈ 1 — far beyond any football line
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (poissonAtLeast(k, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * "Spelare + Ö/U i samma match" — gamblingcabins specialspels-metod (betingade
 * sannolikheter i stället för oberoende multiplikation): dela upp på matchens
 * måltal N ~ Poisson(λ), där λ backas ut ur Ö/U-marknaden, och låt varje mål
 * involvera spelaren (mål eller assist) med samma chans q. Poisson-tunning ger
 * q = λ_spelare/λ med λ_spelare = −ln(1 − p_spelare), och grensumman
 * Σ P(N = n)·P(involverad | n) har sluten form:
 *   P(involverad ∧ N ≥ k) = P(N ≥ k) − e^(−λq)·P(N' ≥ k),  N' ~ Poisson(λ(1−q))
 * Konsistens: k = 1 kollapsar till exakt p_spelare (involvering kräver mål).
 * `underOdds` null ⇒ ensidig de-vig av över-oddset med `marginPct`; spelar-
 * oddset de-viggas alltid ensidigt (mål/assist-marknader visar en sida).
 * q klampas till 1 när spelarpriset är inkonsistent med Ö/U-marknaden.
 */
export function devigPlayerOverJoint(
  playerOdds: number,
  overOdds: number,
  underOdds: number | null,
  minGoals: number,
  marginPct: number = DEFAULT_ONE_SIDED_MARGIN_PCT
): DevigResult | null {
  if (!Number.isInteger(minGoals) || minGoals < 1) return null;
  const player = devigOneSided(playerOdds, marginPct);
  const over = underOdds == null ? devigOneSided(overOdds, marginPct) : devigProportional(overOdds, [underOdds]);
  if (!player || !over) return null;
  const lambda = lambdaFromOverProb(minGoals, over.p);
  if (lambda == null || !(lambda > 0)) return null;
  const lambdaPlayer = lambdaFromScoreProb(player.p);
  const q = Math.min(1, lambdaPlayer / lambda);
  const pJoint =
    poissonAtLeast(minGoals, lambda) - Math.exp(-lambda * q) * poissonAtLeast(minGoals, lambda * (1 - q));
  return { p: clampProb(pJoint), overround: over.overround, lambda, lambdaPlayer, q };
}

export interface OverComponent {
  overOdds: number;
  underOdds: number | null; // null → one-sided de-vig with the assumed margin
  line: number; // over-line threshold k: Ö0.5 → 1, Ö1.5 → 2 …
}

/**
 * "Kombinerade mål över en linje" — gamblingcabins uppställning ("oddsmarknaden
 * räknar på specialare") i sluten form: artikeln räknar grenar med lagens/
 * matchernas Ö/U-priser (A=0 & B≥2, A=1 & B≥1, A≥2 …) och antar oberoende
 * mellan källorna. Med varje källa ~ Poisson(λᵢ), där λᵢ backas ut ur källans
 * Ö/U-marknad, är totalen Poisson(Σλᵢ) och grensumman exakt P(total ≥ K).
 * En ensam källa fungerar som linjeflytt (fair Ö2.5 ur Ö1.5-marknaden).
 */
export function devigCombinedOver(
  components: OverComponent[],
  totalLine: number,
  marginPct: number = DEFAULT_ONE_SIDED_MARGIN_PCT
): DevigResult | null {
  if (components.length === 0 || !Number.isInteger(totalLine) || totalLine < 1) return null;
  let lambda = 0;
  let overroundSum = 0;
  for (const c of components) {
    if (!Number.isInteger(c.line) || c.line < 1) return null;
    const d = c.underOdds == null ? devigOneSided(c.overOdds, marginPct) : devigProportional(c.overOdds, [c.underOdds]);
    if (!d) return null;
    const L = lambdaFromOverProb(c.line, d.p);
    if (L == null || !(L > 0)) return null;
    lambda += L;
    overroundSum += d.overround;
  }
  return { p: clampProb(poissonAtLeast(totalLine, lambda)), overround: overroundSum / components.length, lambda };
}

/**
 * P(A ∩ B) for two Bernoulli events with correlation `rho`:
 *   pA·pB + rho·√(pA·qA·pB·qB)
 * clamped to the Fréchet bounds [max(0, pA+pB−1), min(pA, pB)] so the result
 * is always a valid joint probability, whatever rho is fed in.
 */
export function jointProb(pA: number, pB: number, rho: number): number {
  const a = clampProb(pA);
  const b = clampProb(pB);
  const raw = a * b + rho * Math.sqrt(a * (1 - a) * b * (1 - b));
  return Math.min(Math.min(a, b), Math.max(Math.max(0, a + b - 1), raw));
}

/**
 * Normalize a free-text match label for grouping: trim, lowercase, collapse
 * whitespace. An empty result means the leg is independent of every other leg.
 */
export function matchKeyOf(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface FairLeg {
  p: number; // fair prob from devig*, in (0,1)
  overround: number;
  matchKey?: string; // from matchKeyOf(); "" or undefined = own group
}

export interface ComboResult {
  n: number;
  pIndependent: number; // Π p_i
  pAdjusted: number; // after within-group correlation; == pIndependent at rho 0
  fairOddsIndependent: number; // 1 / pIndependent
  fairOdds: number; // 1 / pAdjusted
  avgOverround: number; // mean leg margin (display only)
  correlatedGroups: number[][]; // leg indexes sharing a matchKey (groups of ≥2)
}

/** How the legs make the special win: "all" = every leg must hit (kombo),
 *  "any" = at least one leg hits ("X eller Y"-specials). */
export type ComboMode = "all" | "any";

/**
 * Combine legs into one special. Legs sharing a matchKey get the pairwise
 * correlation `rho` applied via a chained jointProb fold — exact at rho 0,
 * a rough but always-valid approximation otherwise. Distinct groups are
 * independent. Mode "all" multiplies the group joints; mode "any" computes
 * 1 − P(no leg hits), where each group's miss probability is the same fold
 * over the complements (a Bernoulli pair's complements share the same rho).
 * Null when there are no legs or a p is out of range.
 */
export function combineLegs(legs: FairLeg[], rho = 0, mode: ComboMode = "all"): ComboResult | null {
  if (legs.length === 0 || legs.some((l) => !(l.p > 0) || !(l.p < 1))) return null;
  const r = Math.min(RHO_MAX, Math.max(RHO_MIN, rho));
  const any = mode === "any";
  // In "any" mode we track miss probabilities and complement at the end.
  const legP = (l: FairLeg) => (any ? 1 - l.p : l.p);

  // matchKey → leg indexes; unlabelled legs each get their own bucket.
  const groups = new Map<string, number[]>();
  legs.forEach((l, i) => {
    const key = l.matchKey ? l.matchKey : `#${i}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });

  let pIndependent = 1;
  for (const l of legs) pIndependent *= legP(l);

  let pAdjusted = 1;
  const correlatedGroups: number[][] = [];
  for (const idxs of groups.values()) {
    if (idxs.length === 1) {
      pAdjusted *= legP(legs[idxs[0]]);
    } else {
      correlatedGroups.push(idxs);
      let pg = legP(legs[idxs[0]]);
      for (let j = 1; j < idxs.length; j++) pg = jointProb(pg, legP(legs[idxs[j]]), r);
      pAdjusted *= pg;
    }
  }

  pIndependent = clampProb(any ? 1 - pIndependent : pIndependent);
  pAdjusted = clampProb(any ? 1 - pAdjusted : pAdjusted);
  return {
    n: legs.length,
    pIndependent,
    pAdjusted,
    fairOddsIndependent: 1 / pIndependent,
    fairOdds: 1 / pAdjusted,
    avgOverround: legs.reduce((s, l) => s + l.overround, 0) / legs.length,
    correlatedGroups,
  };
}

/**
 * Price edge of the offered combo odds against the fair probability:
 *   offered·p − 1  (≡ offered/fairOdds − 1)
 * Mathematically identical to EV per unit staked.
 */
export function priceEdge(offeredOdds: number, fairProb: number): number {
  if (!(offeredOdds > 1) || !(fairProb > 0) || fairProb >= 1) return 0;
  return offeredOdds * fairProb - 1;
}
