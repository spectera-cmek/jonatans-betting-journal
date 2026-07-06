import { describe, it, expect } from "vitest";
import {
  DEFAULT_ONE_SIDED_MARGIN_PCT,
  combineLegs,
  devigCombinedOver,
  devigOneSided,
  devigPlayerOverJoint,
  devigPoissonGoals,
  devigProportional,
  jointProb,
  lambdaFromOverProb,
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

  it("clamps the margin to 0–50%", () => {
    expect(devigOneSided(2, 40)!.p).toBeCloseTo(0.5 / 1.4, 10); // goalscorer books get this high
    expect(devigOneSided(2, 60)!.p).toBeCloseTo(0.5 / 1.5, 10);
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

  it("defaults to all-legs mode", () => {
    const def = combineLegs([leg(0.5), leg(0.25)], 0)!;
    const all = combineLegs([leg(0.5), leg(0.25)], 0, "all")!;
    expect(def.pAdjusted).toBeCloseTo(all.pAdjusted, 12);
  });
});

describe("combineLegs — minst ett ben (any)", () => {
  const leg = (p: number, matchKey?: string) => ({ p, overround: 0.2, matchKey });

  it("computes the union of independent legs", () => {
    const r = combineLegs([leg(0.5), leg(0.25)], 0.5, "any")!;
    expect(r.pAdjusted).toBeCloseTo(1 - 0.5 * 0.75, 10); // 0.625; rho ignored without groups
    expect(r.fairOdds).toBeCloseTo(1.6, 8);
    expect(r.correlatedGroups).toEqual([]);
  });

  it("treats a shared matchKey at rho 0 as independent", () => {
    const r = combineLegs([leg(0.5, "m"), leg(0.5, "m")], 0, "any")!;
    expect(r.pAdjusted).toBeCloseTo(0.75, 10);
  });

  it("shrinks the union under positive correlation", () => {
    const r = combineLegs([leg(0.5, "m"), leg(0.5, "m")], 0.5, "any")!;
    // P(ingen träff) = jointProb(0.5, 0.5, 0.5) = 0.375 → union 0.625
    expect(r.pAdjusted).toBeCloseTo(0.625, 10);
    expect(r.pAdjusted).toBeLessThan(r.pIndependent);
    expect(r.fairOdds).toBeGreaterThan(r.fairOddsIndependent);
    expect(r.correlatedGroups).toEqual([[0, 1]]);
  });

  it("chains complements for 3+ legs in one match", () => {
    const r = combineLegs([leg(0.4, "m"), leg(0.3, "m"), leg(0.2, "m")], 0.2, "any")!;
    const miss = jointProb(jointProb(0.6, 0.7, 0.2), 0.8, 0.2);
    expect(r.pAdjusted).toBeCloseTo(1 - miss, 10);
  });

  it("prices the Haaland/Kane-boosten (första målet, eller)", () => {
    // FGS 4.50 & 5.00 de-viggade @ 20% målskyttmarginal, olika matcher.
    const a = devigOneSided(4.5, 20)!;
    const b = devigOneSided(5.0, 20)!;
    const r = combineLegs(
      [
        { p: a.p, overround: a.overround },
        { p: b.p, overround: b.overround },
      ],
      0,
      "any"
    )!;
    expect(r.pAdjusted).toBeCloseTo(0.32099, 5);
    expect(r.fairOdds).toBeCloseTo(3.12, 2);
    expect(priceEdge(2.5, r.pAdjusted)).toBeCloseTo(-0.1975, 3);
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

describe("lambdaFromOverProb", () => {
  it("round-trips the over probability", () => {
    const L = lambdaFromOverProb(2, 0.72917)!;
    expect(poissonAtLeast(2, L)).toBeCloseTo(0.72917, 8);
  });

  it("matches the closed form at k=1", () => {
    // P(N ≥ 1) = 1 − e^(−λ) → λ = 1 när p = 1 − e^(−1)
    expect(lambdaFromOverProb(1, 1 - Math.exp(-1))!).toBeCloseTo(1, 6);
  });

  it("guards invalid input", () => {
    expect(lambdaFromOverProb(0, 0.5)).toBeNull();
    expect(lambdaFromOverProb(1.5, 0.5)).toBeNull();
    expect(lambdaFromOverProb(1, NaN)).toBeNull();
  });
});

describe("devigPlayerOverJoint (gamblingcabin: betingade sannolikheter)", () => {
  it("collapses to the de-vigged player probability at Ö0.5", () => {
    const r = devigPlayerOverJoint(3.0, 1.3, 3.5, 1, 8)!;
    expect(r.p).toBeCloseTo(1 / 3.0 / 1.08, 8);
  });

  it("prices Bellingham-typen: mål/assist + Ö1.5 ligger mellan oberoende och Fréchet", () => {
    const r = devigPlayerOverJoint(3.0, 1.3, 3.5, 2, 8)!;
    const pInv = 1 / 3.0 / 1.08;
    const pOver = devigProportional(1.3, [3.5])!.p;
    expect(r.p).toBeGreaterThan(pInv * pOver); // positiv samvariation
    expect(r.p).toBeLessThan(Math.min(pInv, pOver)); // giltig joint
    // Sluten form ur grensumman Σ P(N=n)·P(involverad|n)
    const L = r.lambda!;
    const mu = L * (1 - r.q!);
    expect(r.p).toBeCloseTo(poissonAtLeast(2, L) - Math.exp(-L * r.q!) * poissonAtLeast(2, mu), 10);
    // λ reproducerar Ö/U-marknaden och λ_spelare spelarpriset
    expect(poissonAtLeast(2, L)).toBeCloseTo(pOver, 8);
    expect(1 - Math.exp(-r.lambdaPlayer!)).toBeCloseTo(pInv, 8);
  });

  it("caps q at 1 when the player price is inconsistent with the O/U market", () => {
    const r = devigPlayerOverJoint(1.2, 3.0, 1.36, 2, 0)!;
    expect(r.q).toBe(1);
    expect(r.p).toBeCloseTo(poissonAtLeast(2, r.lambda!), 10);
  });

  it("guards invalid inputs", () => {
    expect(devigPlayerOverJoint(1.0, 1.3, 3.5, 2, 6)).toBeNull();
    expect(devigPlayerOverJoint(3.0, 1.0, 3.5, 2, 6)).toBeNull();
    expect(devigPlayerOverJoint(3.0, 1.3, 1.0, 2, 6)).toBeNull();
    expect(devigPlayerOverJoint(3.0, 1.3, 3.5, 0, 6)).toBeNull();
    expect(devigPlayerOverJoint(3.0, 1.3, null, 2, NaN)).toBeNull();
  });
});

describe("devigCombinedOver (gamblingcabin: oddsmarknaden räknar på specialare)", () => {
  it("reproducerar Rangers–FCK-exemplet: 2+ mål tillsammans", () => {
    // Artikeln: Rangers Ö1.5 @3.22, FCK Ö1.5 @2.85 (råa priser, marginal 0),
    // grensumma 0,695 → fair 1,44; Poisson-slutna formen landar strax intill.
    const r = devigCombinedOver(
      [
        { overOdds: 3.22, underOdds: null, line: 2 },
        { overOdds: 2.85, underOdds: null, line: 2 },
      ],
      2,
      0
    )!;
    expect(r.p).toBeGreaterThan(0.66);
    expect(r.p).toBeLessThan(0.71);
    // Sluten form: λ per källa ur dess Ö/U-pris, totalen Poisson(Σλ)
    const LA = lambdaFromOverProb(2, 1 / 3.22)!;
    const LB = lambdaFromOverProb(2, 1 / 2.85)!;
    expect(r.lambda).toBeCloseTo(LA + LB, 10);
    expect(r.p).toBeCloseTo(poissonAtLeast(2, LA + LB), 10);
    // Erbjudna 1.80 var "kanon" i artikeln → tydligt plus-EV även här
    expect(priceEdge(1.8, r.p)).toBeGreaterThan(0.15);
  });

  it("round-trips a single source at its own line", () => {
    const r = devigCombinedOver([{ overOdds: 1.9, underOdds: 1.9, line: 2 }], 2, 0)!;
    expect(r.p).toBeCloseTo(0.5, 6);
  });

  it("transposes a line: fair Ö2.5 out of the Ö1.5 market lowers p", () => {
    const base = devigCombinedOver([{ overOdds: 1.5, underOdds: 2.6, line: 2 }], 2, 0)!;
    const up = devigCombinedOver([{ overOdds: 1.5, underOdds: 2.6, line: 2 }], 3, 0)!;
    expect(up.p).toBeLessThan(base.p);
    expect(up.lambda).toBeCloseTo(base.lambda!, 10);
  });

  it("guards invalid inputs", () => {
    expect(devigCombinedOver([], 2, 0)).toBeNull();
    expect(devigCombinedOver([{ overOdds: 1.0, underOdds: null, line: 2 }], 2, 6)).toBeNull();
    expect(devigCombinedOver([{ overOdds: 2.0, underOdds: null, line: 0 }], 2, 6)).toBeNull();
    expect(devigCombinedOver([{ overOdds: 2.0, underOdds: null, line: 2 }], 0, 6)).toBeNull();
    expect(devigCombinedOver([{ overOdds: 2.0, underOdds: 1.0, line: 2 }], 2, 6)).toBeNull();
  });
});
