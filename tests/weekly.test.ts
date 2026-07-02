import { describe, it, expect } from "vitest";
import { weeklyReport, monthlyReport, type WeeklyBetInput } from "../lib/weekly";

const NOW = new Date("2026-06-12T12:00:00Z"); // Friday, week 24 (8–14 jun)

function bet(day: string, overrides: Partial<WeeklyBetInput> = {}): WeeklyBetInput {
  return {
    eventAt: day + "T12:00:00Z",
    outcome: "win",
    odds: 2,
    stakeUnits: 1,
    event: "A v B",
    selection: "Över 4.5 skott",
    sport: "Football",
    market: "totals",
    betType: "single",
    ...overrides,
  };
}

describe("weeklyReport", () => {
  it("splits bets into current and previous Swedish week", () => {
    const bets = [
      bet("2026-06-08"), // Monday this week
      bet("2026-06-12", { outcome: "loss" }), // today
      bet("2026-06-07"), // Sunday last week
      bet("2026-06-01"), // Monday last week
      bet("2026-05-31"), // two weeks ago — excluded
    ];
    const r = weeklyReport(bets, NOW);
    expect(r.current.start).toBe("2026-06-08");
    expect(r.current.end).toBe("2026-06-14");
    expect(r.current.weekNo).toBe(24);
    expect(r.current.bets).toBe(2);
    expect(r.previous.bets).toBe(2);
  });

  it("aggregates profit, win rate and pending", () => {
    const bets = [
      bet("2026-06-09", { outcome: "win", odds: 2, stakeUnits: 2 }), // +2
      bet("2026-06-10", { outcome: "loss", stakeUnits: 1 }), // -1
      bet("2026-06-11", { outcome: "pending" }),
    ];
    const r = weeklyReport(bets, NOW);
    expect(r.current.settled).toBe(2);
    expect(r.current.pending).toBe(1);
    expect(r.current.profitUnits).toBe(1);
    expect(r.current.stakedUnits).toBe(3);
    expect(r.current.winRatePct).toBe(50);
  });

  it("tracks the week's best and worst bet", () => {
    const bets = [
      bet("2026-06-09", { outcome: "win", odds: 3, stakeUnits: 2, event: "Big win" }), // +4
      bet("2026-06-10", { outcome: "win", odds: 1.5, stakeUnits: 1, event: "Small win" }),
      bet("2026-06-11", { outcome: "loss", stakeUnits: 3, event: "Big loss" }),
    ];
    const r = weeklyReport(bets, NOW);
    expect(r.current.best?.event).toBe("Big win");
    expect(r.current.best?.profitUnits).toBe(4);
    expect(r.current.worst?.event).toBe("Big loss");
    expect(r.current.worst?.profitUnits).toBe(-3);
  });

  it("grades discipline by stake share without leak warnings", () => {
    const bets = [
      // Clean: edge category at sane odds, single, sane stake.
      bet("2026-06-09", { selection: "Över 4.5 skott", odds: 1.8, stakeUnits: 3 }),
      // Leak: accumulator.
      bet("2026-06-10", { betType: "accumulator", odds: 8, stakeUnits: 1 }),
    ];
    const r = weeklyReport(bets, NOW);
    expect(r.current.disciplinePct).toBeCloseTo(75, 5);
  });

  it("handles an empty week", () => {
    const r = weeklyReport([], NOW);
    expect(r.current.bets).toBe(0);
    expect(r.current.disciplinePct).toBeNull();
    expect(r.current.best).toBeNull();
  });
});

describe("monthlyReport", () => {
  it("splits bets into current and previous calendar month", () => {
    const bets = [
      bet("2026-06-01"), // first day this month
      bet("2026-06-12", { outcome: "loss" }),
      bet("2026-05-31"), // last day previous month
      bet("2026-05-01"),
      bet("2026-04-30"), // two months ago — excluded
    ];
    const r = monthlyReport(bets, NOW);
    expect(r.current.month).toBe("2026-06");
    expect(r.current.start).toBe("2026-06-01");
    expect(r.current.end).toBe("2026-06-30");
    expect(r.current.bets).toBe(2);
    expect(r.previous.month).toBe("2026-05");
    expect(r.previous.bets).toBe(2);
  });

  it("aggregates like the weekly report (same engine)", () => {
    const bets = [
      bet("2026-06-09", { outcome: "win", odds: 2, stakeUnits: 2 }), // +2
      bet("2026-06-20", { outcome: "loss", stakeUnits: 1 }), // -1
      bet("2026-06-25", { outcome: "pending" }),
    ];
    const r = monthlyReport(bets, NOW);
    expect(r.current.settled).toBe(2);
    expect(r.current.pending).toBe(1);
    expect(r.current.profitUnits).toBe(1);
    expect(r.current.winRatePct).toBe(50);
  });

  it("handles a January current month (previous = December last year)", () => {
    const r = monthlyReport([bet("2025-12-15")], new Date("2026-01-10T12:00:00Z"));
    expect(r.current.month).toBe("2026-01");
    expect(r.previous.month).toBe("2025-12");
    expect(r.previous.bets).toBe(1);
  });
});
