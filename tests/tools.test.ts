import { describe, it, expect } from "vitest";
import {
  ahOutcome,
  ahProfit,
  arbStakes,
  bonusValue,
  cashoutAdvice,
  hedgeStake,
} from "../lib/tools";

describe("cashoutAdvice", () => {
  it("reproduces bettingskolans example (250 kr payout, live odds 1.15 → ~217 kr)", () => {
    const a = cashoutAdvice(250, 1 / 1.15, 200)!;
    expect(a.fairCashout).toBeCloseTo(217.39, 2);
    expect(a.shave).toBeCloseTo(1 - 200 / 217.391, 4);
    expect(a.evDiff).toBeCloseTo(17.39, 2);
    expect(a.breakEvenProb).toBeCloseTo(0.8, 10);
  });

  it("flags a generous offer as +EV to take", () => {
    const a = cashoutAdvice(250, 0.5, 140)!; // fair 125, offered 140
    expect(a.evDiff).toBeLessThan(0);
    expect(a.shave).toBeLessThan(0);
  });

  it("guards invalid inputs", () => {
    expect(cashoutAdvice(0, 0.5, 100)).toBeNull();
    expect(cashoutAdvice(250, 0, 100)).toBeNull();
    expect(cashoutAdvice(250, 1, 100)).toBeNull();
    expect(cashoutAdvice(250, 0.5, -1)).toBeNull();
  });
});

describe("arbStakes", () => {
  it("finds the 2.10/2.10 surebet from bettingskolan (95.2% → ~5% arb)", () => {
    const r = arbStakes([2.1, 2.1], 1000)!;
    expect(r.impliedSum).toBeCloseTo(0.9524, 4);
    expect(r.isArb).toBe(true);
    expect(r.arbPct).toBeCloseTo(0.05, 10);
    expect(r.stakes[0]).toBeCloseTo(500, 8);
  });

  it("splits 1.40/8.50 with 1000 kr like the article (≈858/142)", () => {
    const r = arbStakes([1.4, 8.5], 1000)!;
    expect(r.stakes[0]).toBeCloseTo(858.59, 2);
    expect(r.stakes[1]).toBeCloseTo(141.41, 2);
    expect(r.stakes[0] + r.stakes[1]).toBeCloseTo(1000, 8);
    expect(r.payout).toBeCloseTo(1202.02, 2);
    expect(r.profit).toBeCloseTo(202.02, 2);
    // equal payout on every outcome
    expect(r.stakes[0] * 1.4).toBeCloseTo(r.payout, 8);
    expect(r.stakes[1] * 8.5).toBeCloseTo(r.payout, 8);
  });

  it("handles three-way markets", () => {
    const r = arbStakes([3.1, 3.3, 3.4], 900)!;
    expect(r.impliedSum).toBeLessThan(1);
    expect(r.isArb).toBe(true);
    for (let i = 0; i < 3; i++) expect(r.stakes[i] * [3.1, 3.3, 3.4][i]).toBeCloseTo(r.payout, 8);
  });

  it("reports a normal vigged market as no-arb", () => {
    const r = arbStakes([1.9, 1.9], 1000)!;
    expect(r.isArb).toBe(false);
    expect(r.arbPct).toBeLessThan(0);
  });

  it("guards invalid inputs", () => {
    expect(arbStakes([2.0], 1000)).toBeNull();
    expect(arbStakes([2.0, 1.0], 1000)).toBeNull();
    expect(arbStakes([2.0, 2.0], 0)).toBeNull();
  });
});

describe("hedgeStake", () => {
  it("locks the same amount on both branches", () => {
    const h = hedgeStake(100, 2.5, 1.6)!;
    expect(h.hedgeStake).toBeCloseTo(156.25, 10);
    // original wins: payout 250 − 156.25; hedge wins: 156.25 × 1.6 − 156.25
    expect(250 - h.hedgeStake).toBeCloseTo(h.lockedReturn, 10);
    expect(h.hedgeStake * 1.6 - h.hedgeStake).toBeCloseTo(h.lockedReturn, 10);
    expect(h.lockedProfit).toBeCloseTo(-6.25, 10);
  });

  it("locks a profit when the position has moved your way", () => {
    const h = hedgeStake(100, 2.5, 5.0)!;
    expect(h.hedgeStake).toBeCloseTo(50, 10);
    expect(h.lockedReturn).toBeCloseTo(200, 10);
    expect(h.lockedProfit).toBeCloseTo(100, 10);
  });

  it("guards invalid inputs", () => {
    expect(hedgeStake(0, 2.5, 1.6)).toBeNull();
    expect(hedgeStake(100, 1.0, 1.6)).toBeNull();
    expect(hedgeStake(100, 2.5, 1.0)).toBeNull();
  });
});

describe("ahOutcome", () => {
  it("matches bettingskolans table for full and half lines", () => {
    // line 0: vinst / pengarna tillbaka / förlust
    expect(ahOutcome(0, 1)).toBe("win");
    expect(ahOutcome(0, 0)).toBe("push");
    expect(ahOutcome(0, -1)).toBe("loss");
    // line −0.5: vinst / förlust / förlust
    expect(ahOutcome(-0.5, 1)).toBe("win");
    expect(ahOutcome(-0.5, 0)).toBe("loss");
    // line −1.0: vinst vid 2+, pengarna tillbaka vid exakt 1
    expect(ahOutcome(-1, 2)).toBe("win");
    expect(ahOutcome(-1, 1)).toBe("push");
    expect(ahOutcome(-1, 0)).toBe("loss");
    // line +1.0: pengarna tillbaka vid 1-målsförlust
    expect(ahOutcome(1, -1)).toBe("push");
    expect(ahOutcome(1, 0)).toBe("win");
    expect(ahOutcome(1, -2)).toBe("loss");
  });

  it("splits quarter lines into half results", () => {
    // −0.25: oavgjort → halva insatsen tillbaka
    expect(ahOutcome(-0.25, 0)).toBe("half_loss");
    expect(ahOutcome(-0.25, 1)).toBe("win");
    // −0.75: vinst med exakt 1 mål → halv vinst
    expect(ahOutcome(-0.75, 1)).toBe("half_win");
    expect(ahOutcome(-0.75, 2)).toBe("win");
    expect(ahOutcome(-0.75, 0)).toBe("loss");
    // +0.25: oavgjort → halv vinst
    expect(ahOutcome(0.25, 0)).toBe("half_win");
    expect(ahOutcome(0.25, -1)).toBe("loss");
  });

  it("guards lines off the 0.25 grid and non-integer margins", () => {
    expect(ahOutcome(0.3, 1)).toBeNull();
    expect(ahOutcome(-0.5, 0.5)).toBeNull();
  });
});

describe("ahProfit", () => {
  it("pays half stakes on half results", () => {
    expect(ahProfit(100, 1.95, "win")).toBeCloseTo(95, 10);
    expect(ahProfit(100, 1.95, "half_win")).toBeCloseTo(47.5, 10);
    expect(ahProfit(100, 1.95, "push")).toBe(0);
    expect(ahProfit(100, 1.95, "half_loss")).toBeCloseTo(-50, 10);
    expect(ahProfit(100, 1.95, "loss")).toBeCloseTo(-100, 10);
  });
});

describe("bonusValue", () => {
  it("prices a 500 kr bonus with 10× wagering at 6% margin", () => {
    const b = bonusValue(500, 10, 6)!;
    expect(b.turnover).toBe(5000);
    expect(b.expectedCost).toBeCloseTo(5000 * (0.06 / 1.06), 6); // ≈ 283 kr
    expect(b.netValue).toBeCloseTo(500 - 283.02, 1);
    expect(b.retained).toBeCloseTo(0.434, 3);
  });

  it("is the full bonus without wagering or margin", () => {
    expect(bonusValue(500, 0, 6)!.netValue).toBe(500);
    expect(bonusValue(500, 10, 0)!.netValue).toBe(500);
  });

  it("can go negative on brutal terms", () => {
    expect(bonusValue(500, 40, 8)!.netValue).toBeLessThan(0);
  });

  it("guards invalid inputs", () => {
    expect(bonusValue(0, 10, 6)).toBeNull();
    expect(bonusValue(500, -1, 6)).toBeNull();
    expect(bonusValue(500, 10, NaN)).toBeNull();
  });
});
