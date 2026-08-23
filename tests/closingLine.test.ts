import { describe, it, expect } from "vitest";
import { SOURCE_PRIORITY, type ClosingSource } from "../lib/closingLine";

/**
 * The priority table is the guard that stops an hourly scrape from overwriting
 * a true closing line, so its ORDER is the contract worth pinning — not the
 * particular numbers, which are free to move.
 */
describe("SOURCE_PRIORITY", () => {
  const rank = (s: ClosingSource) => SOURCE_PRIORITY[s];

  it("puts a hand-typed value above every automated source", () => {
    for (const s of ["odds_api_historical", "thestatsapi", "oddsportal", "odds_api_live"] as const) {
      expect(rank("manual")).toBeGreaterThan(rank(s));
    }
  });

  // The historical snapshot IS the close; the others reconstruct or predict it.
  it("ranks the historical snapshot above every reconstruction", () => {
    for (const s of ["thestatsapi", "oddsportal", "odds_api_live"] as const) {
      expect(rank("odds_api_historical")).toBeGreaterThan(rank(s));
    }
  });

  // A price taken 30 minutes early is a guess at the close and must never win.
  it("ranks the near-kickoff live price last", () => {
    const others = Object.entries(SOURCE_PRIORITY).filter(([k]) => k !== "odds_api_live");
    for (const [, v] of others) expect(rank("odds_api_live")).toBeLessThan(v);
  });

  it("covers every source exactly once, with distinct ranks", () => {
    const values = Object.values(SOURCE_PRIORITY);
    expect(new Set(values).size).toBe(values.length);
    expect(Object.keys(SOURCE_PRIORITY).sort()).toEqual(
      ["manual", "odds_api_historical", "odds_api_live", "oddsportal", "thestatsapi"].sort()
    );
  });
});
