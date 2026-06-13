import { describe, it, expect } from "vitest";
import {
  kellyFraction,
  expectedValuePerUnit,
  kellyAdvice,
  impliedProb,
  survivableLossStreak,
} from "../lib/staking";

describe("kellyFraction", () => {
  it("computes the textbook fraction at +EV", () => {
    // odds 2.0, p 0.6 → b=1, q=0.4 → (1*0.6-0.4)/1 = 0.2
    expect(kellyFraction(2.0, 0.6)).toBeCloseTo(0.2, 10);
  });

  it("returns 0 when there is no edge", () => {
    expect(kellyFraction(2.0, 0.5)).toBe(0); // break-even
    expect(kellyFraction(2.0, 0.4)).toBe(0); // -EV
  });

  it("guards invalid inputs", () => {
    expect(kellyFraction(1.0, 0.6)).toBe(0);
    expect(kellyFraction(2.0, 0)).toBe(0);
    expect(kellyFraction(2.0, 1)).toBe(0);
  });
});

describe("expectedValuePerUnit", () => {
  it("is positive only with an edge", () => {
    expect(expectedValuePerUnit(2.0, 0.6)).toBeCloseTo(0.2, 10);
    expect(expectedValuePerUnit(2.0, 0.5)).toBeCloseTo(0, 10);
    expect(expectedValuePerUnit(2.0, 0.4)).toBeCloseTo(-0.2, 10);
  });
});

describe("kellyAdvice", () => {
  it("scales fractions to units against the bankroll", () => {
    const a = kellyAdvice(2.0, 0.6, 100);
    expect(a.hasEdge).toBe(true);
    expect(a.full).toBeCloseTo(0.2, 10);
    expect(a.fullUnits).toBe(20);
    expect(a.halfUnits).toBe(10);
    expect(a.quarterUnits).toBe(5);
  });

  it("recommends nothing without an edge", () => {
    const a = kellyAdvice(2.0, 0.45, 100);
    expect(a.hasEdge).toBe(false);
    expect(a.fullUnits).toBe(0);
  });
});

describe("impliedProb", () => {
  it("is 1/odds", () => {
    expect(impliedProb(2.0)).toBeCloseTo(0.5, 10);
    expect(impliedProb(4.0)).toBeCloseTo(0.25, 10);
    expect(impliedProb(1.0)).toBeNull();
  });
});

describe("survivableLossStreak", () => {
  it("is bankroll / stake, floored", () => {
    expect(survivableLossStreak(100, 2)).toBe(50);
    expect(survivableLossStreak(10, 3)).toBe(3);
  });
  it("handles edge cases", () => {
    expect(survivableLossStreak(100, 0)).toBe(Infinity);
    expect(survivableLossStreak(0, 2)).toBe(0);
  });
});
