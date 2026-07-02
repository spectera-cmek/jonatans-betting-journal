import { describe, it, expect } from "vitest";
import { computeEdgeSegments, type EdgeBetInput } from "../lib/edge";

function bets(n: number, overrides: Partial<EdgeBetInput> = {}): EdgeBetInput[] {
  return Array.from({ length: n }, () => ({
    odds: 1.8,
    stakeUnits: 1,
    outcome: "loss" as const,
    selection: "Över 4.5 skott",
    market: "totals",
    marketCategory: null,
    betType: "single",
    ...overrides,
  }));
}

describe("computeEdgeSegments", () => {
  it("finds leaks and edges above the sample floor, sorted by impact", () => {
    const history = [
      // Edge: 50 shot bets, all winning at 1.8 → +40u.
      ...bets(50, { outcome: "win", marketCategory: "Skott" }),
      // Leak: 50 accumulators, all losing → -50u.
      ...bets(50, { outcome: "loss", betType: "accumulator", marketCategory: "Kort & fouls" }),
    ];
    const r = computeEdgeSegments(history, 40);

    const leakKeys = r.leaks.map((s) => `${s.dim}:${s.key}`);
    const edgeKeys = r.edges.map((s) => `${s.dim}:${s.key}`);
    expect(leakKeys).toContain("Typ:Ackumulator");
    expect(leakKeys).toContain("Marknad:Kort & fouls");
    expect(edgeKeys).toContain("Marknad:Skott");
    // Most negative first.
    expect(r.leaks[0].profitUnits).toBeLessThanOrEqual(r.leaks[r.leaks.length - 1].profitUnits);
    expect(r.leakUnits).toBeLessThan(0);
    expect(r.edgeUnits).toBeGreaterThan(0);
  });

  it("ignores segments below the sample floor", () => {
    const r = computeEdgeSegments(bets(10, { outcome: "loss", marketCategory: "Tennis" }), 40);
    expect(r.leaks).toHaveLength(0);
    expect(r.edges).toHaveLength(0);
  });

  it("excludes 1.01 placeholder odds from the odds dimension but not the others", () => {
    const history = bets(60, { outcome: "loss", odds: 1.01, marketCategory: "Spelarpoäng" });
    const r = computeEdgeSegments(history, 40);
    expect(r.leaks.some((s) => s.dim === "Odds")).toBe(false);
    expect(r.leaks.some((s) => s.dim === "Marknad" && s.key === "Spelarpoäng")).toBe(true);
  });

  it("only counts settled bets toward the floor", () => {
    const history = [
      ...bets(30, { outcome: "pending", marketCategory: "Hörnor" }),
      ...bets(30, { outcome: "win", marketCategory: "Hörnor" }),
    ];
    // 60 bets but only 30 settled — below a floor of 40.
    expect(computeEdgeSegments(history, 40).edges).toHaveLength(0);
    // With a floor of 30 the segment qualifies.
    expect(computeEdgeSegments(history, 30).edges.some((s) => s.key === "Hörnor")).toBe(true);
  });

  it("falls back to betCategory when marketCategory is missing", () => {
    const history = bets(45, { outcome: "win", marketCategory: null, selection: "Över 8.5 hörnor" });
    const r = computeEdgeSegments(history, 40);
    expect(r.edges.some((s) => s.dim === "Marknad" && s.key === "Hörnor")).toBe(true);
  });
});
