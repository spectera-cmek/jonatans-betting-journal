import { describe, it, expect } from "vitest";
import {
  profitUnits,
  computeMetrics,
  clvPct,
  bankrollSeries,
  breakdownBy,
  accaOdds,
  topBetsByProfit,
  singleRoiPct,
  openRisk,
  maxDrawdown,
  type BankrollPoint,
  type BetLike,
} from "../lib/betting";

describe("profitUnits", () => {
  it("win = stake * (odds - 1)", () => {
    expect(profitUnits("win", 2.5, 1)).toBeCloseTo(1.5);
    expect(profitUnits("win", 1.85, 2)).toBeCloseTo(1.7);
  });
  it("loss = -stake", () => {
    expect(profitUnits("loss", 2.5, 1)).toBe(-1);
    expect(profitUnits("loss", 10, 3)).toBe(-3);
  });
  it("push and void return 0", () => {
    expect(profitUnits("push", 2.5, 1)).toBe(0);
    expect(profitUnits("void", 2.5, 1)).toBe(0);
  });
  it("half_win = half of a win", () => {
    expect(profitUnits("half_win", 2.0, 2)).toBeCloseTo(1.0); // full win = 2, half = 1
  });
  it("half_loss = -stake/2", () => {
    expect(profitUnits("half_loss", 2.0, 2)).toBeCloseTo(-1.0);
  });
  it("pending returns 0", () => {
    expect(profitUnits("pending", 2.5, 1)).toBe(0);
  });
});

describe("clvPct", () => {
  it("positive when you beat the close", () => {
    expect(clvPct(2.1, 2.0)).toBeCloseTo(5);
  });
  it("negative when the line moved against you", () => {
    expect(clvPct(1.9, 2.0)).toBeCloseTo(-5);
  });
});

describe("computeMetrics", () => {
  const bets: BetLike[] = [
    { odds: 2.0, stakeUnits: 1, outcome: "win", closingOdds: 1.9 }, // +1.0, beat close
    { odds: 1.5, stakeUnits: 2, outcome: "loss", closingOdds: 1.6 }, // -2.0, worse than close
    { odds: 3.0, stakeUnits: 1, outcome: "push" }, // 0
    { odds: 2.5, stakeUnits: 1, outcome: "pending" }, // excluded
  ];

  it("excludes pending from settled counts", () => {
    const m = computeMetrics(bets);
    expect(m.totalBets).toBe(4);
    expect(m.settledBets).toBe(3);
    expect(m.pendingBets).toBe(1);
  });

  it("computes profit and ROI in units", () => {
    const m = computeMetrics(bets);
    expect(m.profitUnits).toBeCloseTo(-1.0); // +1 -2 +0
    expect(m.stakedUnits).toBeCloseTo(4.0); // 1 + 2 + 1 (push staked too)
    expect(m.roiPct!).toBeCloseTo((-1 / 4) * 100);
  });

  it("excludes push/void from win rate denominator", () => {
    const m = computeMetrics(bets);
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(1);
    expect(m.winRatePct!).toBeCloseTo(50); // 1 / (1+1)
  });

  it("averages CLV only over bets that have closingOdds", () => {
    const m = computeMetrics(bets);
    expect(m.clvSampleSize).toBe(2);
    expect(m.clvBeatCount).toBe(1);
    const expected = (clvPct(2.0, 1.9) + clvPct(1.5, 1.6)) / 2;
    expect(m.clvPct!).toBeCloseTo(expected);
  });

  it("returns null metrics for an empty set", () => {
    const m = computeMetrics([]);
    expect(m.roiPct).toBeNull();
    expect(m.winRatePct).toBeNull();
    expect(m.avgOdds).toBeNull();
    expect(m.clvPct).toBeNull();
  });
});

describe("bankrollSeries", () => {
  it("starts at baseline and accumulates settled profit in order", () => {
    const bets: BetLike[] = [
      { odds: 2.0, stakeUnits: 1, outcome: "win", eventAt: "2026-01-02" }, // +1
      { odds: 2.0, stakeUnits: 1, outcome: "loss", eventAt: "2026-01-01" }, // -1 (earlier)
      { odds: 2.0, stakeUnits: 1, outcome: "pending", eventAt: "2026-01-03" }, // ignored
    ];
    const pts = bankrollSeries(bets, 100);
    // seed + 2 settled
    expect(pts.length).toBe(3);
    expect(pts[0].bankrollUnits).toBe(100);
    // earliest event first: the loss
    expect(pts[1].bankrollUnits).toBeCloseTo(99);
    expect(pts[2].bankrollUnits).toBeCloseTo(100);
  });
});

describe("breakdownBy", () => {
  it("groups and computes per-group metrics", () => {
    const bets: BetLike[] = [
      { odds: 2.0, stakeUnits: 1, outcome: "win" },
      { odds: 2.0, stakeUnits: 1, outcome: "loss" },
    ];
    const rows = breakdownBy(bets, () => "Football");
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe("Football");
    expect(rows[0].bets).toBe(2);
    expect(rows[0].profitUnits).toBeCloseTo(0);
  });
});

describe("accaOdds", () => {
  it("multiplies leg odds", () => {
    expect(accaOdds([2, 1.5, 3])).toBeCloseTo(9);
    expect(accaOdds([])).toBe(1);
  });
});

describe("topBetsByProfit", () => {
  // id lets us assert ordering unambiguously.
  const bets: (BetLike & { id: string })[] = [
    { id: "win-small", odds: 2.0, stakeUnits: 1, outcome: "win" }, // +1.0
    { id: "win-big", odds: 6.0, stakeUnits: 2, outcome: "win" }, // +10.0
    { id: "win-mid", odds: 3.0, stakeUnits: 1, outcome: "win" }, // +2.0
    { id: "loss-big", odds: 2.0, stakeUnits: 5, outcome: "loss" }, // -5.0
    { id: "loss-small", odds: 2.0, stakeUnits: 1, outcome: "loss" }, // -1.0
    { id: "push", odds: 2.0, stakeUnits: 3, outcome: "push" }, // 0 — never qualifies
    { id: "pending", odds: 2.0, stakeUnits: 9, outcome: "pending" }, // excluded
  ];

  it("ranks wins by profit descending", () => {
    const top = topBetsByProfit(bets, "win");
    expect(top.map((b) => b.id)).toEqual(["win-big", "win-mid", "win-small"]);
  });

  it("ranks losses by most-negative profit first", () => {
    const top = topBetsByProfit(bets, "loss");
    expect(top.map((b) => b.id)).toEqual(["loss-big", "loss-small"]);
  });

  it("excludes pending, push and void (profit 0 never qualifies)", () => {
    const ids = [...topBetsByProfit(bets, "win"), ...topBetsByProfit(bets, "loss")].map((b) => b.id);
    expect(ids).not.toContain("pending");
    expect(ids).not.toContain("push");
  });

  it("respects the n limit", () => {
    expect(topBetsByProfit(bets, "win", 2).map((b) => b.id)).toEqual(["win-big", "win-mid"]);
  });

  it("honors an authoritative stored profitUnits over the odds formula", () => {
    const real: (BetLike & { id: string })[] = [
      { id: "cashout", odds: 4.0, stakeUnits: 1, outcome: "win", profitUnits: 0.5 }, // real payout < formula
      { id: "clean", odds: 2.0, stakeUnits: 1, outcome: "win" }, // +1.0
    ];
    expect(topBetsByProfit(real, "win").map((b) => b.id)).toEqual(["clean", "cashout"]);
  });
});

describe("singleRoiPct", () => {
  it("is profit / stake * 100", () => {
    expect(singleRoiPct({ odds: 3.0, stakeUnits: 1, outcome: "win" })!).toBeCloseTo(200); // +2 / 1
    expect(singleRoiPct({ odds: 2.0, stakeUnits: 4, outcome: "loss" })!).toBeCloseTo(-100); // -4 / 4
  });

  it("returns null when stake is zero", () => {
    expect(singleRoiPct({ odds: 2.0, stakeUnits: 0, outcome: "win" })).toBeNull();
  });
});

describe("openRisk", () => {
  it("sums stake and best-case return across pending bets only", () => {
    const bets: BetLike[] = [
      { odds: 2.0, stakeUnits: 1, outcome: "pending" },
      { odds: 1.5, stakeUnits: 2, outcome: "pending" },
      { odds: 3.0, stakeUnits: 5, outcome: "win" }, // settled — ignored
    ];
    const r = openRisk(bets);
    expect(r.bets).toBe(2);
    expect(r.stakeUnits).toBeCloseTo(3);
    expect(r.potentialReturnUnits).toBeCloseTo(2 * 1 + 1.5 * 2); // 5
  });

  it("is all zeroes with no pending bets", () => {
    expect(openRisk([{ odds: 2, stakeUnits: 1, outcome: "loss" }])).toEqual({
      bets: 0,
      stakeUnits: 0,
      potentialReturnUnits: 0,
    });
  });
});

describe("maxDrawdown", () => {
  const pt = (bankrollUnits: number): BankrollPoint => ({
    date: "2026-01-01",
    bankrollUnits,
    profitUnits: 0,
    label: "",
  });

  it("finds the largest peak-to-trough drop", () => {
    // 100 -> 120 -> 90 (dd 30) -> 110 -> 60 (dd 60 from 120)
    const dd = maxDrawdown([pt(100), pt(120), pt(90), pt(110), pt(60)]);
    expect(dd.maxUnits).toBeCloseTo(60);
    expect(dd.pctOfPeak!).toBeCloseTo(50);
  });

  it("is zero for a monotonically rising bankroll", () => {
    const dd = maxDrawdown([pt(100), pt(110), pt(150)]);
    expect(dd.maxUnits).toBe(0);
    expect(dd.pctOfPeak).toBeNull();
  });

  it("handles an empty series", () => {
    expect(maxDrawdown([]).maxUnits).toBe(0);
  });
});

describe("CLV against the fair line", () => {
  const bet = (odds: number, closing: number, fair: number, stake = 1) => ({
    odds,
    stakeUnits: stake,
    outcome: "win" as const,
    closingOdds: closing,
    closingFairOdds: fair,
  });

  // The point of the whole exercise: a raw book price carries their margin and
  // is shorter than fair, so CLV measured against it OVERSTATES the edge.
  it("reports a lower CLV against fair than against the raw close", () => {
    const m = computeMetrics([bet(2.05, 1.9, 2.0)]);
    expect(m.clvPct).toBeCloseTo(7.89, 1);
    expect(m.clvFairPct).toBeCloseTo(2.5, 1);
    expect(m.clvFairPct!).toBeLessThan(m.clvPct!);
  });

  it("counts fair beats separately from raw beats", () => {
    // Beats the vigged close, loses to the fair line — the case that matters.
    const m = computeMetrics([bet(1.95, 1.9, 2.0)]);
    expect(m.clvBeatCount).toBe(1);
    expect(m.clvFairBeatCount).toBe(0);
    expect(m.clvFairSampleSize).toBe(1);
  });

  it("puts expected value in units, so it lines up with real P/L", () => {
    // 2 units at 2.10 against a fair 2.00 = 2 × (2.10/2.00 − 1) = +0.10 U.
    const m = computeMetrics([bet(2.1, 2.0, 2.0, 2)]);
    expect(m.clvUnits).toBeCloseTo(0.1, 6);
  });

  it("ignores bets with no fair line rather than treating them as zero", () => {
    const m = computeMetrics([
      { odds: 2.05, stakeUnits: 1, outcome: "win", closingOdds: 1.9, closingFairOdds: null },
    ]);
    expect(m.clvSampleSize).toBe(1);
    expect(m.clvFairSampleSize).toBe(0);
    expect(m.clvFairPct).toBeNull();
    expect(m.clvUnits).toBeNull();
  });

  it("leaves the raw CLV number unchanged", () => {
    expect(clvPct(2.0, 1.8)).toBeCloseTo(11.11, 2);
  });
});
