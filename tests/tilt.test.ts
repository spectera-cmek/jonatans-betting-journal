import { describe, it, expect } from "vitest";
import { tiltStatus, currentLossStreak, isChasing } from "../lib/tilt";
import type { BetLike } from "../lib/betting";

// All times sent as midday UTC so the Swedish day equals the date written.
function bet(placedAt: string, stakeUnits: number, outcome: BetLike["outcome"] = "pending"): BetLike {
  return { placedAt: placedAt + "T12:00:00Z", eventAt: placedAt + "T12:00:00Z", odds: 2, stakeUnits, outcome };
}

const NOW = new Date("2026-06-12T12:00:00Z"); // Friday

describe("currentLossStreak", () => {
  it("counts trailing losses only", () => {
    const bets = [bet("2026-06-01", 1, "win"), bet("2026-06-02", 1, "loss"), bet("2026-06-03", 1, "loss")];
    expect(currentLossStreak(bets)).toBe(2);
  });

  it("is zero after a win", () => {
    expect(currentLossStreak([bet("2026-06-01", 1, "loss"), bet("2026-06-02", 1, "win")])).toBe(0);
  });
});

describe("isChasing", () => {
  it("flags escalating stakes during a loss streak", () => {
    const history = Array.from({ length: 20 }, (_, i) => bet(`2026-05-${String(i + 1).padStart(2, "0")}`, 1, "loss"));
    const recent = [bet("2026-06-10", 2, "loss"), bet("2026-06-11", 2, "loss"), bet("2026-06-12", 2.5)];
    expect(isChasing([...history, ...recent], 5)).toBe(true);
  });

  it("does not flag steady stakes", () => {
    const history = Array.from({ length: 20 }, (_, i) => bet(`2026-05-${String(i + 1).padStart(2, "0")}`, 1, "loss"));
    const recent = [bet("2026-06-10", 1, "loss"), bet("2026-06-11", 1, "loss"), bet("2026-06-12", 1)];
    expect(isChasing([...history, ...recent], 5)).toBe(false);
  });

  it("requires a minimum loss streak", () => {
    const history = Array.from({ length: 20 }, (_, i) => bet(`2026-05-${String(i + 1).padStart(2, "0")}`, 1, "win"));
    const recent = [bet("2026-06-12", 5)];
    expect(isChasing([...history, ...recent], 0)).toBe(false);
  });
});

describe("tiltStatus", () => {
  it("sums today's and this week's staked units by Swedish day", () => {
    const bets = [
      bet("2026-06-12", 2), // today (Friday)
      bet("2026-06-12", 1.5),
      bet("2026-06-08", 3), // Monday, same week
      bet("2026-06-07", 4), // Sunday, previous week
    ];
    const s = tiltStatus(bets, { dailyBudgetUnits: null, weeklyBudgetUnits: null }, NOW);
    expect(s.stakedTodayUnits).toBe(3.5);
    expect(s.betsToday).toBe(2);
    expect(s.stakedWeekUnits).toBe(6.5);
    expect(s.betsWeek).toBe(3);
    expect(s.level).toBe("ok");
  });

  it("goes danger when the daily budget is reached", () => {
    const bets = [bet("2026-06-12", 6), bet("2026-06-12", 4)];
    const s = tiltStatus(bets, { dailyBudgetUnits: 10, weeklyBudgetUnits: null }, NOW);
    expect(s.level).toBe("danger");
    expect(s.notes.some((n) => n.includes("Dagsbudgeten"))).toBe(true);
  });

  it("warns at 75% of the daily budget", () => {
    const bets = [bet("2026-06-12", 8)];
    const s = tiltStatus(bets, { dailyBudgetUnits: 10, weeklyBudgetUnits: null }, NOW);
    expect(s.level).toBe("warn");
  });

  it("treats 0 budget as off", () => {
    const bets = [bet("2026-06-12", 8)];
    const s = tiltStatus(bets, { dailyBudgetUnits: 0, weeklyBudgetUnits: 0 }, NOW);
    expect(s.level).toBe("ok");
    expect(s.dailyBudgetUnits).toBeNull();
  });

  it("warns on a chasing pattern without budgets", () => {
    const history = Array.from({ length: 20 }, (_, i) => bet(`2026-05-${String(i + 1).padStart(2, "0")}`, 1, i < 18 ? "win" : "loss"));
    const recent = [bet("2026-06-10", 2, "loss"), bet("2026-06-11", 2, "loss"), bet("2026-06-12", 2.5)];
    const s = tiltStatus([...history, ...recent], { dailyBudgetUnits: null, weeklyBudgetUnits: null }, NOW);
    expect(s.lossStreak).toBe(4);
    expect(s.chasing).toBe(true);
    expect(s.level).toBe("warn");
  });
});
