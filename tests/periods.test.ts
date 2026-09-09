import { describe, it, expect } from "vitest";
import {
  ANALYSIS_PERIODS,
  CHART_PERIODS,
  filterByPeriod,
  minSettledFor,
  periodByKey,
} from "../lib/periods";
import type { BetLike } from "../lib/betting";

const NOW = Date.parse("2026-09-08T12:00:00Z");

function bet(eventAt: string | null, placedAt?: string): BetLike {
  return { odds: 2, stakeUnits: 1, outcome: "win", eventAt, placedAt: placedAt ?? null };
}

describe("filterByPeriod", () => {
  const bets = [
    bet("2026-09-01T18:00:00Z"), // a week ago
    bet("2026-05-01T18:00:00Z"), // four months ago
    bet("2025-09-01T18:00:00Z"), // a year ago
    bet("2023-01-01T18:00:00Z"), // ancient
  ];

  it("keeps everything when no window is given", () => {
    expect(filterByPeriod(bets, null, NOW)).toHaveLength(4);
  });

  it("cuts at the trailing window", () => {
    expect(filterByPeriod(bets, 91, NOW)).toHaveLength(1);
    expect(filterByPeriod(bets, 182, NOW)).toHaveLength(2);
    expect(filterByPeriod(bets, 365, NOW)).toHaveLength(2);
  });

  it("falls back to placedAt, and keeps undated rows rather than shrinking the sample", () => {
    const mixed = [bet(null, "2026-09-05T10:00:00Z"), bet(null)];
    expect(filterByPeriod(mixed, 91, NOW)).toHaveLength(2);
    // The dated one is outside the window; the undated one still survives.
    expect(filterByPeriod([bet(null, "2023-01-01T10:00:00Z"), bet(null)], 91, NOW)).toHaveLength(1);
  });
});

describe("periodByKey", () => {
  it("resolves a key and falls back to the first period", () => {
    expect(periodByKey(ANALYSIS_PERIODS, "6m").days).toBe(182);
    expect(periodByKey(CHART_PERIODS, "7d").days).toBe(7);
    expect(periodByKey(ANALYSIS_PERIODS, "nonsense").key).toBe("all");
  });
});

describe("minSettledFor", () => {
  it("lowers the sample floor for shorter windows", () => {
    expect(minSettledFor(null)).toBe(40);
    expect(minSettledFor(365)).toBe(40);
    expect(minSettledFor(182)).toBe(25);
    expect(minSettledFor(91)).toBe(15);
  });
});
