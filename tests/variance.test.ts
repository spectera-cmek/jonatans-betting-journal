import { describe, it, expect } from "vitest";
import { erf, normalCdf, noEdgeVariance, varianceByKey } from "../lib/variance";
import type { BetLike } from "../lib/betting";

function bet(outcome: BetLike["outcome"], odds = 2, stakeUnits = 1, profitUnits?: number): BetLike {
  return { outcome, odds, stakeUnits, profitUnits: profitUnits ?? null };
}

describe("normalCdf / erf", () => {
  it("matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(erf(0)).toBeCloseTo(0, 8);
  });
});

describe("noEdgeVariance", () => {
  it("a single even-odds bet has sigma = stake", () => {
    // p = 0.5: Var = 1²·(0.5·1² + 0.5) = 1.
    const v = noEdgeVariance([bet("win", 2, 1)]);
    expect(v.n).toBe(1);
    expect(v.sigmaUnits).toBeCloseTo(1, 9);
    expect(v.actualUnits).toBe(1);
    expect(v.z).toBeCloseTo(1, 9);
  });

  it("a balanced win/loss pair at evens nets z = 0", () => {
    const v = noEdgeVariance([bet("win", 2, 1), bet("loss", 2, 1)]);
    expect(v.actualUnits).toBe(0);
    expect(v.z).toBeCloseTo(0, 9);
    expect(v.percentile).toBeCloseTo(50, 6);
  });

  it("skips pending, push, void and bad odds", () => {
    const v = noEdgeVariance([bet("pending"), bet("push"), bet("void"), bet("win", 1), bet("win", 2, 0)]);
    expect(v.n).toBe(0);
    expect(v.z).toBeNull();
    expect(v.percentile).toBeNull();
  });

  it("prefers authoritative profitUnits for the actual total", () => {
    const v = noEdgeVariance([bet("win", 2, 1, 0.85)]); // cashed out below full payout
    expect(v.actualUnits).toBe(0.85);
  });
});

describe("varianceByKey", () => {
  it("groups by key and drops small samples", () => {
    const skott = Array.from({ length: 30 }, (_, i) => ({
      ...bet(i % 2 ? "win" : "loss"),
      market: "Skott",
    }));
    const tiny = [{ ...bet("win"), market: "Hörnor" }];
    const rows = varianceByKey([...skott, ...tiny], (b) => (b as { market?: string }).market, 30);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe("Skott");
    expect(rows[0].n).toBe(30);
  });

  it("sorts best z first", () => {
    const good = Array.from({ length: 30 }, () => ({ ...bet("win"), market: "A" }));
    const bad = Array.from({ length: 30 }, () => ({ ...bet("loss"), market: "B" }));
    const rows = varianceByKey([...good, ...bad], (b) => (b as { market?: string }).market, 30);
    expect(rows[0].key).toBe("A");
    expect(rows[1].key).toBe("B");
    expect(rows[0].z!).toBeGreaterThan(rows[1].z!);
  });
});
