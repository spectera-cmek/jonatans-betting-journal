// Pure math for the everyday-decision betting tools (cashout, hedge/surebet,
// asian handicap, bonus value) — grounded in the formulas from Gambling
// Cabin's bettingskola. Dependency-free so it is trivially unit-testable
// (mirrors lib/staking.ts and lib/fairOdds.ts).

const isOdds = (o: number) => Number.isFinite(o) && o > 1;

// ---------- Cashout (bettingskolan kap. 12) ----------
// Bookies price cashout as: potential payout ÷ current odds, minus a fee of
// "up to 5%". Fair cashout = payout × P(win now); holding the bet is worth
// exactly that in expectation, so the offer's shave is pure cost.

export interface CashoutAdvice {
  fairCashout: number; // payout × pNow — also the EV of holding
  shave: number; // 1 − offered/fairCashout (fraction the bookie skims)
  evDiff: number; // fairCashout − offered; >0 → holding is +EV
  breakEvenProb: number; // offered / payout — win prob where cashing = holding
}

export function cashoutAdvice(potentialPayout: number, pNow: number, offered: number): CashoutAdvice | null {
  if (!(potentialPayout > 0) || !(pNow > 0) || pNow >= 1 || !(offered >= 0)) return null;
  const fair = potentialPayout * pNow;
  return {
    fairCashout: fair,
    shave: fair > 0 ? 1 - offered / fair : 0,
    evDiff: fair - offered,
    breakEvenProb: offered / potentialPayout,
  };
}

// ---------- Surebet / arbitrage (kap. 10) ----------
// Arb exists when Σ 1/odds < 1 across the outcomes (best price per outcome,
// different books). Stakes proportional to 1/odds give the same payout
// whatever happens: payout = budget / Σ(1/odds).

export interface ArbResult {
  impliedSum: number; // Σ 1/o — under 1 = surebet
  isArb: boolean;
  arbPct: number; // guaranteed ROI: 1/impliedSum − 1 (negative if no arb)
  stakes: number[]; // per outcome, sums to budget
  payout: number; // equal payout for every outcome
  profit: number; // payout − budget
}

export function arbStakes(odds: number[], budget: number): ArbResult | null {
  if (odds.length < 2 || !odds.every(isOdds) || !(budget > 0)) return null;
  const impliedSum = odds.reduce((s, o) => s + 1 / o, 0);
  const payout = budget / impliedSum;
  return {
    impliedSum,
    isArb: impliedSum < 1,
    arbPct: 1 / impliedSum - 1,
    stakes: odds.map((o) => (budget * (1 / o)) / impliedSum),
    payout,
    profit: payout - budget,
  };
}

// Hedge an open bet: original stake S at odds O (payout S·O) and the opposite
// side available at H. Staking x = S·O/H on the hedge makes the cash received
// from now on identical either way: S·O − x = x·H − x… i.e. both branches end
// at S·O·(H−1)/H. That locked amount is directly comparable to a cashout
// offer — both are "money from this point", the original stake is sunk.

export interface HedgeResult {
  hedgeStake: number; // lay this on the opposite side
  lockedReturn: number; // guaranteed money from now, either outcome
  lockedProfit: number; // lockedReturn − original stake (whole-bet net)
}

export function hedgeStake(originalStake: number, originalOdds: number, hedgeOdds: number): HedgeResult | null {
  if (!(originalStake > 0) || !isOdds(originalOdds) || !isOdds(hedgeOdds)) return null;
  const payout = originalStake * originalOdds;
  const x = payout / hedgeOdds;
  const locked = payout - x; // = x·hedgeOdds − x
  return { hedgeStake: x, lockedReturn: locked, lockedProfit: locked - originalStake };
}

// ---------- Asian handicap (kap. 9) ----------
// Quarter lines (±0.25, ±0.75 …) split the stake over the two neighbouring
// half/full lines; full lines can push, half lines never do.

export type AhOutcome = "win" | "half_win" | "push" | "half_loss" | "loss";

/** Resolve one (non-quarter) line: margin is my team's goals minus the
 *  opponent's, line is my handicap (e.g. −1.5 as favourite). */
function ahSimple(line: number, margin: number): AhOutcome {
  const adj = margin + line;
  if (adj > 0) return "win";
  if (adj < 0) return "loss";
  return "push";
}

export function ahOutcome(line: number, margin: number): AhOutcome | null {
  if (!Number.isFinite(line) || !Number.isInteger(margin)) return null;
  const q = Math.round(line * 4);
  if (q !== line * 4) return null; // lines move in 0.25 steps
  if (q % 2 === 0) return ahSimple(line, margin); // full or half line
  const a = ahSimple(line - 0.25, margin);
  const b = ahSimple(line + 0.25, margin);
  if (a === b) return a;
  // Halves can only straddle adjacent results: win/push → half win etc.
  if (a === "win" || b === "win") return "half_win";
  return "half_loss";
}

/** Net profit for a settled AH bet (stake back excluded, like profitUnits). */
export function ahProfit(stake: number, odds: number, outcome: AhOutcome): number {
  if (!(stake > 0) || !isOdds(odds)) return 0;
  switch (outcome) {
    case "win":
      return stake * (odds - 1);
    case "half_win":
      return (stake / 2) * (odds - 1);
    case "push":
      return 0;
    case "half_loss":
      return -stake / 2;
    case "loss":
      return -stake;
  }
}

// ---------- Bonus value (kap. 3) ----------
// Clearing a wagering requirement means feeding the bookie's margin once per
// krona turned over. With a proportionally shared margin g the EV per staked
// krona is 1/(1+g) − 1 = −g/(1+g) — independent of the odds you pick (odds
// only change the variance), so minimum-odds rules don't affect the expected
// cost, just the bumpiness of the ride.

export interface BonusValue {
  turnover: number; // total amount that must be staked
  expectedCost: number; // turnover × g/(1+g)
  netValue: number; // bonus − expectedCost
  retained: number; // netValue / bonus (share of the bonus you keep)
}

export function bonusValue(bonus: number, wagerTimes: number, marginPct: number): BonusValue | null {
  if (!(bonus > 0) || !(wagerTimes >= 0) || !Number.isFinite(marginPct) || marginPct < 0) return null;
  const g = marginPct / 100;
  const turnover = bonus * wagerTimes;
  const expectedCost = turnover * (g / (1 + g));
  const netValue = bonus - expectedCost;
  return { turnover, expectedCost, netValue, retained: netValue / bonus };
}
