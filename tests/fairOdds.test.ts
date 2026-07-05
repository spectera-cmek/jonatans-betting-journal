import { describe, it, expect } from "vitest";
import {
  DEFAULT_ONE_SIDED_MARGIN_PCT,
  combineLegs,
  devigOneSided,
  devigPoissonGoals,
  devigProportional,
  jointProb,
  lambdaFromScoreProb,
  matchKeyOf,
  poissonAtLeast,
  priceEdge,
} from "../lib/fairOdds";
import { expectedValuePerUnit } from "../lib/staking";

describe("devigProportional", () => {
  it("splits a symmetric two-way market 50/50", () => {
    const r = devigProportional(1.9, [1.9])!;
    expect(r.p).toBeCloseTo(0.5, 10);
    expect(r.overround).toBeCloseTo(2 / 1.9 - 1, 10); // ≈ 5.26%
  });

  it("handles an asymmetric two-way market", () => {
    // 1/1.5 + 1/2.5 = 16/15 → margin 1/15; p = (2/3)/(16/15) = 0.625
    const r = devigProportional(1.5, [2.5])!;
    expect(r.p).toBeCloseTo(0.625, 10);
    expect(r.overround).toBeCloseTo(1 / 15, 10);
  });

  it("handles a three-outcome (1X2) market", () => {
    const r = devigProportional(2.1, [3.4, 3.6])!;
    const book = 1 / 2.1 + 1 / 3.4 + 1 / 3.6;
    expect(r.p).toBeCloseTo(1 / 2.1 / book, 10); // ≈ 0.4543
    expect(r.overround).toBeCloseTo(book - 1, 10);
  });

  it("rejects invalid inputs", () => {
    expect(devigProportional(1.0, [1.9])).toBeNull();
    expect(devigProportional(0, [1.9])).toBeNull();
    expect(devigProportional(NaN, [1.9])).toBeNull();
    expect(devigProportional(1.9, [])).toBeNull();
    expect(devigProportional(1.9, [1.9, 1.0])).toBeNull();
  });
});

describe("devigOneSided", () => {
  it("shares the assumed margin proportionally", () => {
    const r = devigOneSided(1.85, 6)!;
    expect(r.p).toBeCloseTo(1 / 1.85 / 1.06, 10); // ≈ 0.5099
    expect(r.overround).toBeCloseTo(0.06, 10);
  });

  it("equals the raw implied probability at 0% margin", () => {
    expect(devigOneSided(1.85, 0)!.p).toBeCloseTo(1 / 1.85, 10);
  });

  it("clamps the margin to 0–25%", () => {
    expect(devigOneSided(2, 40)!.p).toBeCloseTo(0.5 / 1.25, 10);
    expect(devigOneSided(2, -5)!.p).toBeCloseTo(0.5, 10);
  });

  it("defaults to the standard prop margin", () => {
    expect(devigOneSided(2)!.p).toBeCloseTo(0.5 / (1 + DEFAULT_ONE_SIDED_MARGIN_PCT / 100), 10);
  });

  it("rejects invalid odds", () => {
    expect(devigOneSided(1.0, 6)).toBeNull();
    expect(devigOneSided(NaN, 6)).toBeNull();
  });
});

describe("lambdaFromScoreProb", () => {
  it("inverts the anytime probability", () => {
    const lam = lambdaFromScoreProb(0.4348);
    expect(1 - Math.exp(-lam)).toBeCloseTo(0.4348, 10);
  });
});

describe("poissonAtLeast", () => {
  it("k=1 is the anytime probability", () => {
    expect(poissonAtLeast(1, 0.5705)).toBeCloseTo(1 - Math.exp(-0.5705), 10);
  });

  it("sums the tail for k=2", () => {
    const L = 1.2;
    expect(poissonAtLeast(2, L)).toBeCloseTo(1 - Math.exp(-L) - L * Math.exp(-L), 10);
  });

  it("handles edge cases", () => {
    expect(poissonAtLeast(0, 1)).toBe(1);
    expect(poissonAtLeast(2, 0)).toBe(0);
  });
});

describe("devigPoissonGoals", () => {
  it("one player over 0.5 equals the de-vigged anytime probability", () => {
    const r = devigPoissonGoals([2.3], 1, 6, 0)!;
    expect(r.p).toBeCloseTo(1 / 2.3 / 1.06, 10);
  });

  it("prices two players combined over 1.5 (Haaland/Vinícius-exemplet)", () => {
    const r = devigPoissonGoals([2.3, 2.3], 2, 6, 0)!;
    const p1 = 1 / 2.3 / 1.06;
    const L = 2 * -Math.log(1 - p1);
    expect(r.p).toBeCloseTo(1 - Math.exp(-L) * (1 + L), 10);
    expect(1 / r.p).toBeCloseTo(3.51, 2);
    expect(r.lambda).toBeCloseTo(L, 10);
    expect(r.overround).toBeCloseTo(0.06, 10);
  });

  it("applies the extra-time boost", () => {
    const r0 = devigPoissonGoals([2.3, 2.3], 2, 6, 0)!;
    const r7 = devigPoissonGoals([2.3, 2.3], 2, 6, 7)!;
    expect(r7.p).toBeGreaterThan(r0.p);
    expect(1 / r7.p).toBeCloseTo(3.21, 2);
  });

  it("lowers the probability for a higher line", () => {
    const o15 = devigPoissonGoals([2.3, 2.3], 2, 6, 0)!;
    const o25 = devigPoissonGoals([2.3, 2.3], 3, 6, 0)!;
    expect(o25.p).toBeLessThan(o15.p);
  });

  it("guards invalid inputs", () => {
    expect(devigPoissonGoals([], 2, 6, 0)).toBeNull();
    expect(devigPoissonGoals([1.0], 2, 6, 0)).toBeNull();
    expect(devigPoissonGoals([2.3, NaN], 2, 6, 0)).toBeNull();
    expect(devigPoissonGoals([2.3], 0, 6, 0)).toBeNull();
    expect(devigPoissonGoals([2.3], 1.5, 6, 0)).toBeNull();
    expect(devigPoissonGoals([2.3], 2, NaN, 0)).toBeNull();
  });
});

describe("jointProb", () => {
  it("equals the product at rho 0", () => {
    expect(jointProb(0.5, 0.4, 0)).toBeCloseTo(0.2, 10);
  });

  it("raises the pair probability at positive rho", () => {
    // 0.25 + 0.3·√(0.25·0.25) = 0.325
    expect(jointProb(0.5, 0.5, 0.3)).toBeCloseTo(0.325, 10);
  });

  it("clamps to the Fréchet lower bound", () => {
    // raw 0.81 − 0.2·0.09 = 0.792 < max(0, 0.8) → 0.8
    expect(jointProb(0.9, 0.9, -0.2)).toBeCloseTo(0.8, 10);
  });

  it("clamps to the Fréchet upper bound", () => {
    // raw 0.18 + 0.9·√0.0504 ≈ 0.382 > min(0.3, 0.6) → 0.3
    expect(jointProb(0.3, 0.6, 0.9)).toBeCloseTo(0.3, 10);
  });
});

describe("matchKeyOf", () => {
  it("normalizes case and whitespace", () => {
    expect(matchKeyOf("  Arsenal –  Chelsea ")).toBe("arsenal – chelsea");
    expect(matchKeyOf("ARSENAL – CHELSEA")).toBe(matchKeyOf("arsenal – chelsea"));
    expect(matchKeyOf("   ")).toBe("");
  });
});

describe("combineLegs", () => {
  const leg = (p: number, matchKey?: string) => ({ p, overround: 0.05, matchKey });

  it("multiplies independent legs and prices the combo", () => {
    const r = combineLegs([leg(0.5), leg(0.25), leg(0.8)], 0.5)!;
    expect(r.pIndependent).toBeCloseTo(0.1, 10);
    expect(r.pAdjusted).toBeCloseTo(0.1, 10); // rho ignored without shared matchKey
    expect(r.fairOdds).toBeCloseTo(10, 8);
    expect(r.correlatedGroups).toEqual([]);
    expect(r.avgOverround).toBeCloseTo(0.05, 10);
  });

  it("treats a shared matchKey at rho 0 as independent", () => {
    const r = combineLegs([leg(0.5, "a–b"), leg(0.4, "a–b")], 0)!;
    expect(r.pAdjusted).toBeCloseTo(r.pIndependent, 10);
    expect(r.correlatedGroups).toEqual([[0, 1]]);
  });

  it("raises the combo probability for a correlated pair", () => {
    const r = combineLegs([leg(0.5, "a–b"), leg(0.4, "a–b"), leg(0.5)], 0.3)!;
    const pair = jointProb(0.5, 0.4, 0.3);
    expect(r.pAdjusted).toBeCloseTo(pair * 0.5, 10);
    expect(r.pAdjusted).toBeGreaterThan(r.pIndependent);
    expect(r.fairOdds).toBeLessThan(r.fairOddsIndependent);
  });

  it("chains pairwise for 3+ legs in one match", () => {
    const r = combineLegs([leg(0.5, "m"), leg(0.4, "m"), leg(0.6, "m")], 0.2)!;
    expect(r.pAdjusted).toBeCloseTo(jointProb(jointProb(0.5, 0.4, 0.2), 0.6, 0.2), 10);
    expect(r.correlatedGroups).toEqual([[0, 1, 2]]);
  });

  it("guards empty and out-of-range inputs", () => {
    expect(combineLegs([], 0)).toBeNull();
    expect(combineLegs([leg(0)], 0)).toBeNull();
    expect(combineLegs([leg(1)], 0)).toBeNull();
  });
});

describe("priceEdge", () => {
  it("is the offered/fair price ratio minus one", () => {
    expect(priceEdge(12, 0.1)).toBeCloseTo(0.2, 10); // fair odds 10, offered 12
  });

  it("matches the existing EV-per-unit definition", () => {
    expect(priceEdge(12, 0.1)).toBeCloseTo(expectedValuePerUnit(12, 0.1), 10);
    expect(priceEdge(2.5, 0.38)).toBeCloseTo(expectedValuePerUnit(2.5, 0.38), 10);
  });

  it("guards invalid inputs", () => {
    expect(priceEdge(1.0, 0.5)).toBe(0);
    expect(priceEdge(2.0, 0)).toBe(0);
  });
});

describe("end-to-end special", () => {
  it("prices a two-leg special and finds the edge", () => {
    // Leg 1: O/U 1.90/1.90 → p 0.5. Leg 2: one-sided 7.00 @ 6% → p ≈ 0.1348.
    const l1 = devigProportional(1.9, [1.9])!;
    const l2 = devigOneSided(7.0, 6)!;
    const combo = combineLegs([
      { p: l1.p, overround: l1.overround },
      { p: l2.p, overround: l2.overround },
    ])!;
    expect(combo.pAdjusted).toBeCloseTo(0.067386, 5);
    expect(combo.fairOdds).toBeCloseTo(14.84, 2);
    expect(priceEdge(16.0, combo.pAdjusted)).toBeCloseTo(0.0782, 3);
  });
});
