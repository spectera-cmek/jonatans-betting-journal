import { describe, it, expect } from "vitest";
import {
  ANALYSIS_PERIODS,
  CHART_PERIODS,
  computePeriodMetrics,
  filterByPeriod,
  lastCalendarMonths,
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

describe("lastCalendarMonths", () => {
  const row = (month: string, profitUnits: number) => ({
    month, bets: 1, profitUnits, roiPct: null, stakedUnits: 1, winRatePct: null,
  });

  it("ends at the current month and drops futures keyed on next season", () => {
    const rows = [row("2026-08", 5), row("2026-09", 2), row("2027-01", 0), row("2027-05", 0)];
    const out = lastCalendarMonths(rows, 12, new Date(NOW));
    expect(out).toHaveLength(12);
    expect(out[0].month).toBe("2025-10");
    expect(out[11]).toEqual(row("2026-09", 2));
    expect(out.some((r) => r.month.startsWith("2027"))).toBe(false);
  });

  it("fills months without bets with zero rows", () => {
    const out = lastCalendarMonths([row("2026-07", 3)], 3, new Date(NOW));
    expect(out.map((r) => [r.month, r.profitUnits])).toEqual([
      ["2026-07", 3],
      ["2026-08", 0],
      ["2026-09", 0],
    ]);
  });

  it("crosses a year boundary", () => {
    const out = lastCalendarMonths([], 3, new Date("2026-02-10T12:00:00Z"));
    expect(out.map((r) => r.month)).toEqual(["2025-12", "2026-01", "2026-02"]);
  });
});

describe("computePeriodMetrics", () => {
  const b = (eventAt: string, odds: number, outcome: "win" | "loss"): BetLike => ({
    odds, stakeUnits: 1, outcome, eventAt, placedAt: eventAt,
  });
  const bets = [
    b("2026-09-05T18:00:00Z", 2, "win"), //  +1, inside 7 d
    b("2026-08-20T18:00:00Z", 3, "loss"), // −1, inside 30 d
    b("2025-01-01T18:00:00Z", 1.01, "loss"), // placeholder, only in "all"
  ];

  it("keys every chart period and moves every figure with it", () => {
    const out = computePeriodMetrics(bets, 100, NOW);
    expect(Object.keys(out)).toEqual(CHART_PERIODS.map((p) => p.key));
    expect(out["7d"].settledBets).toBe(1);
    expect(out["7d"].profitUnits).toBe(1);
    expect(out["30d"].settledBets).toBe(2);
    expect(out["30d"].roiPct).toBe(0);
    expect(out.all.settledBets).toBe(3);
  });

  it("keeps 1.01 placeholders out of the odds figures but not out of P/L", () => {
    const all = computePeriodMetrics(bets, 100, NOW).all;
    expect(all.medianOdds).toBe(2.5);
    expect(all.avgOdds).toBe(2.5);
    expect(all.profitUnits).toBe(-1);
  });

  it("measures drawdown inside the window only", () => {
    const out = computePeriodMetrics(bets, 100, NOW);
    expect(out["7d"].drawdown.maxUnits).toBe(0);
    expect(out.all.drawdown.maxUnits).toBe(2);
  });
});
