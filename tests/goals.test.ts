import { describe, it, expect } from "vitest";
import { goalProgress, monthElapsedFraction, yearElapsedFraction } from "../lib/goals";

describe("goalProgress", () => {
  it("is on track when the pace projects to the goal", () => {
    const g = goalProgress(50, 25, 0.5);
    expect(g.pct).toBe(50);
    expect(g.projectedUnits).toBeCloseTo(50, 10);
    expect(g.onTrack).toBe(true);
    expect(g.remainingUnits).toBe(25);
  });

  it("is behind when the pace falls short", () => {
    const g = goalProgress(50, 10, 0.5);
    expect(g.projectedUnits).toBeCloseTo(20, 10);
    expect(g.onTrack).toBe(false);
    expect(g.remainingUnits).toBe(40);
  });

  it("clamps elapsedFraction and avoids divide-by-zero", () => {
    const g = goalProgress(50, 10, 0);
    expect(g.projectedUnits).toBe(10); // no extrapolation at 0 elapsed
    const c = goalProgress(50, 60, 2);
    expect(c.elapsedFraction).toBe(1);
    expect(c.remainingUnits).toBe(0); // goal already beaten
  });

  it("handles a zero goal without NaN", () => {
    const g = goalProgress(0, 10, 0.5);
    expect(g.pct).toBe(0);
    expect(Number.isNaN(g.projectedUnits)).toBe(false);
  });
});

describe("monthElapsedFraction", () => {
  it("treats the day-of-month as the elapsed share", () => {
    // June 2026 has 30 days; the 15th → 15/30 = 0.5
    expect(monthElapsedFraction(new Date(2026, 5, 15))).toBeCloseTo(0.5, 10);
    expect(monthElapsedFraction(new Date(2026, 5, 30))).toBeCloseTo(1, 10);
  });
});

describe("yearElapsedFraction", () => {
  it("is ~0 at the very start and ~1 at the end", () => {
    expect(yearElapsedFraction(new Date(2026, 0, 1, 0, 0, 0))).toBeCloseTo(0, 4);
    expect(yearElapsedFraction(new Date(2026, 11, 31, 12, 0, 0))).toBeGreaterThan(0.99);
  });
});
