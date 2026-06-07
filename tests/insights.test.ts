import { describe, it, expect } from "vitest";
import {
  streaks,
  bestWorstDay,
  avgStakeUnits,
  monthOverMonth,
  byWeekday,
  type Insights,
} from "../lib/insights";
import { computeInsights } from "../lib/insights";
import type { BetLike } from "../lib/betting";

// Helper: build a settled bet on a given date. profit is taken from the
// odds-based formula unless an explicit profitUnits is supplied.
function bet(
  date: string,
  outcome: BetLike["outcome"],
  stakeUnits = 1,
  odds = 2,
  profitUnits?: number
): BetLike {
  return { eventAt: date, outcome, stakeUnits, odds, profitUnits: profitUnits ?? null };
}

describe("streaks", () => {
  it("tracks longest win and loss runs in event order", () => {
    const bets = [
      bet("2025-01-01", "win"),
      bet("2025-01-02", "win"),
      bet("2025-01-03", "win"),
      bet("2025-01-04", "loss"),
      bet("2025-01-05", "loss"),
      bet("2025-01-06", "win"),
    ];
    const s = streaks(bets);
    expect(s.longestWin).toBe(3);
    expect(s.longestLoss).toBe(2);
    expect(s.current).toBe(1);
    expect(s.currentType).toBe("win");
  });

  it("ignores push/void and pending (they don't break a streak)", () => {
    const bets = [
      bet("2025-01-01", "win"),
      bet("2025-01-02", "push"),
      bet("2025-01-03", "void"),
      bet("2025-01-04", "win"),
      bet("2025-01-05", "pending"),
    ];
    const s = streaks(bets);
    expect(s.longestWin).toBe(2);
    expect(s.current).toBe(2);
    expect(s.currentType).toBe("win");
  });

  it("counts half_win as a win and half_loss as a loss", () => {
    const s = streaks([bet("2025-01-01", "half_win"), bet("2025-01-02", "half_loss")]);
    expect(s.longestWin).toBe(1);
    expect(s.longestLoss).toBe(1);
    expect(s.currentType).toBe("loss");
  });

  it("returns a none-type streak with no settled bets", () => {
    expect(streaks([bet("2025-01-01", "pending")]).currentType).toBe("none");
  });
});

describe("bestWorstDay", () => {
  it("aggregates profit per day and finds extremes", () => {
    const bets = [
      bet("2025-01-01", "win", 1, 3), // +2
      bet("2025-01-01", "loss", 1, 2), // -1 -> day net +1
      bet("2025-01-02", "loss", 5, 2), // -5
      bet("2025-01-03", "win", 2, 4), // +6
    ];
    const { best, worst } = bestWorstDay(bets);
    expect(best?.date).toBe("2025-01-03");
    expect(best?.profitUnits).toBeCloseTo(6);
    expect(worst?.date).toBe("2025-01-02");
    expect(worst?.profitUnits).toBeCloseTo(-5);
  });

  it("prefers authoritative profitUnits when present", () => {
    const { best } = bestWorstDay([bet("2025-01-01", "win", 1, 2, 9.5)]);
    expect(best?.profitUnits).toBeCloseTo(9.5);
  });
});

describe("avgStakeUnits", () => {
  it("averages stake across settled bets only", () => {
    const bets = [bet("2025-01-01", "win", 2), bet("2025-01-02", "loss", 4), bet("2025-01-03", "pending", 100)];
    expect(avgStakeUnits(bets)).toBeCloseTo(3);
  });
  it("returns null with no settled bets", () => {
    expect(avgStakeUnits([bet("2025-01-01", "pending")])).toBeNull();
  });
});

describe("monthOverMonth", () => {
  it("returns the latest and previous month with settled bets", () => {
    const bets = [
      bet("2025-04-10", "win", 1, 3), // Apr +2
      bet("2025-05-10", "loss", 1, 2), // May -1
      bet("2025-05-20", "win", 1, 2), // May +1 -> May net 0
    ];
    const { current, previous } = monthOverMonth(bets);
    expect(current?.month).toBe("2025-05");
    expect(current?.profitUnits).toBeCloseTo(0);
    expect(previous?.month).toBe("2025-04");
    expect(previous?.profitUnits).toBeCloseTo(2);
  });
});

describe("byWeekday", () => {
  it("buckets profit Monday-first", () => {
    // 2025-01-06 is a Monday.
    const rows = byWeekday([bet("2025-01-06", "win", 1, 3)]);
    expect(rows).toHaveLength(7);
    expect(rows[0].weekday).toBe(0);
    expect(rows[0].profitUnits).toBeCloseTo(2);
    expect(rows[0].bets).toBe(1);
  });
});

describe("computeInsights", () => {
  it("bundles every sub-metric", () => {
    const ins: Insights = computeInsights([bet("2025-01-06", "win", 1, 3)]);
    expect(ins.streaks.longestWin).toBe(1);
    expect(ins.best?.profitUnits).toBeCloseTo(2);
    expect(ins.avgStakeUnits).toBeCloseTo(1);
    expect(ins.monthCurrent?.month).toBe("2025-01");
    expect(ins.byWeekday).toHaveLength(7);
  });
});
