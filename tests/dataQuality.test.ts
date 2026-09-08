import { describe, it, expect } from "vitest";
import {
  clvCoverage,
  dataQualitySummary,
  findSuspectedDuplicates,
  flagsFor,
  missingClosing,
  type QualityBet,
} from "../lib/dataQuality";

const NOW = Date.parse("2026-09-08T12:00:00Z");

function bet(over: Partial<QualityBet> = {}): QualityBet {
  return {
    id: "b1",
    event: "Arsenal vs Chelsea",
    selection: "Över 9.5 hörnor",
    league: "Premier League",
    marketCategory: "Hörnor",
    odds: 1.9,
    stakeUnits: 1,
    outcome: "win",
    closingOdds: 1.8,
    boosted: false,
    eventAt: "2026-09-01T18:00:00Z",
    ...over,
  };
}

describe("flagsFor", () => {
  it("returns nothing for a clean, settled bet", () => {
    expect(flagsFor(bet(), new Set(), NOW)).toEqual([]);
  });

  it("flags placeholder odds, missing league and missing category", () => {
    const flags = flagsFor(bet({ odds: 1.01, league: null, marketCategory: null }), new Set(), NOW);
    expect(flags).toContain("placeholder");
    expect(flags).toContain("no-league");
    expect(flags).toContain("no-category");
  });

  it("flags a pending bet whose match finished more than two days ago", () => {
    expect(flagsFor(bet({ outcome: "pending" }), new Set(), NOW)).toContain("stale-pending");
    // Yesterday's match is not stale yet — results take a while to land.
    expect(
      flagsFor(bet({ outcome: "pending", eventAt: "2026-09-08T09:00:00Z" }), new Set(), NOW)
    ).not.toContain("stale-pending");
  });

  it("does not call a settled bet stale, however old", () => {
    expect(flagsFor(bet({ eventAt: "2023-01-01T18:00:00Z" }), new Set(), NOW)).not.toContain(
      "stale-pending"
    );
  });
});

describe("findSuspectedDuplicates", () => {
  it("catches identical bets logged within a day of each other", () => {
    const dupes = findSuspectedDuplicates([
      bet({ id: "a", eventAt: "2026-09-01T18:00:00Z" }),
      bet({ id: "b", eventAt: "2026-09-01T18:00:00Z" }),
      bet({ id: "c", event: "Spurs vs Everton" }),
    ]);
    expect([...dupes].sort()).toEqual(["a", "b"]);
  });

  it("ignores the same bet on a different day, stake or price", () => {
    const dupes = findSuspectedDuplicates([
      bet({ id: "a", eventAt: "2026-09-01T18:00:00Z" }),
      bet({ id: "b", eventAt: "2026-09-05T18:00:00Z" }), // same match, four days later
      bet({ id: "c", stakeUnits: 2 }),
      bet({ id: "d", odds: 2.1 }),
    ]);
    expect(dupes.size).toBe(0);
  });

  it("treats sloppy match spelling as the same match", () => {
    const dupes = findSuspectedDuplicates([
      bet({ id: "a", event: "Arsenal vs Chelsea" }),
      bet({ id: "b", event: "arsenal  VS chelsea " }),
    ]);
    expect(dupes.size).toBe(2);
  });
});

describe("dataQualitySummary", () => {
  it("counts each flag and the bets carrying at least one", () => {
    const s = dataQualitySummary(
      [
        bet({ id: "a", event: "Arsenal vs Chelsea" }),
        bet({ id: "b", event: "Spurs vs Everton", odds: 1.01, league: null }), // two flags, one bet
        bet({ id: "c", event: "Leeds vs Brentford", outcome: "pending" }),
      ],
      NOW
    );
    expect(s.total).toBe(3);
    expect(s.placeholder).toBe(1);
    expect(s["no-league"]).toBe(1);
    expect(s["stale-pending"]).toBe(1);
    expect(s.dupe).toBe(0);
    expect(s.flagged).toBe(2);
  });

  it("flags every member of a duplicate pair, settled or not", () => {
    // Which of the two is the real one is not something the data can say.
    const s = dataQualitySummary([bet({ id: "a" }), bet({ id: "b", outcome: "pending" })], NOW);
    expect(s.dupe).toBe(2);
    expect(s.flagged).toBe(2);
  });
});

describe("clvCoverage", () => {
  it("measures coverage over bets a closing price could exist for", () => {
    const cov = clvCoverage([
      bet({ id: "a", closingOdds: 1.8 }),
      bet({ id: "b", closingOdds: null }),
      bet({ id: "c", boosted: true, closingOdds: null }),
      bet({ id: "d", odds: 1.01, closingOdds: null }),
    ]);
    expect(cov.eligible).toBe(2);
    expect(cov.withClosing).toBe(1);
    expect(cov.pct).toBe(50);
    expect(cov.boosted).toBe(1);
    expect(cov.placeholder).toBe(1);
  });

  it("never counts a boosted bet as missing a closing price", () => {
    expect(missingClosing(bet({ boosted: true, closingOdds: null }))).toBe(false);
    expect(missingClosing(bet({ closingOdds: null }))).toBe(true);
    expect(missingClosing(bet({ closingOdds: 1.8 }))).toBe(false);
  });
});
