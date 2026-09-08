import { describe, it, expect } from "vitest";
import { evaluateBet, betCategory } from "../lib/discipline";
import { deriveDisciplineRules, openEventCounts, type DisciplineRuleSet } from "../lib/disciplineRules";
import type { EdgeBetInput } from "../lib/edge";

describe("betCategory", () => {
  it("reads the category from the free-text selection", () => {
    expect(betCategory({ selection: "Bridges över 13.5 skott" })).toBe("Skott");
    expect(betCategory({ selection: "Över 9.5 hörnor" })).toBe("Hörnor");
    expect(betCategory({ selection: "Jokic över 11.5 returer" })).toBe("Returer");
  });
  it("falls back to the market field", () => {
    expect(betCategory({ selection: "Arsenal", market: "spreads" })).toBe("Handikapp");
    expect(betCategory({ selection: "", market: "totals" })).toBe("Totalt");
  });
});

/** n bets of one shape, alternating win/loss to hit an exact win rate. */
function series(n: number, wins: number, bet: Partial<EdgeBetInput> & { odds: number }): EdgeBetInput[] {
  return Array.from({ length: n }, (_, i) => ({
    stakeUnits: 1,
    outcome: i < wins ? ("win" as const) : ("loss" as const),
    placedAt: new Date("2026-06-01T12:00:00Z"),
    ...bet,
  })) as EdgeBetInput[];
}

const NOW = Date.parse("2026-09-01T12:00:00Z");

describe("deriveDisciplineRules", () => {
  it("derives a leak and an edge from the journal itself", () => {
    const bets = [
      // Long odds, far below break-even (needs 20 % to break even at 5.00).
      ...series(120, 8, { odds: 5.5, selection: "Arsenal vinner", market: "h2h" }),
      // Shots at short odds, well above break-even (needs ~54 %).
      ...series(120, 84, { odds: 1.85, selection: "Över 24.5 skott", market: "other" }),
    ];
    const { rules, windowLabel } = deriveDisciplineRules(bets, { now: NOW, minSettled: 40 });

    expect(windowLabel).toBe("senaste året");
    const oddsLeak = rules.find((r) => r.dim === "Odds" && r.key.startsWith("Odds 5"));
    expect(oddsLeak?.tone).toBe("neg");
    expect(oddsLeak!.roiPct!).toBeLessThan(0);

    const shots = rules.find((r) => r.dim === "Marknad" && r.key === "Skott");
    expect(shots?.tone).toBe("pos");
  });

  it("stays silent on segments below the sample floor", () => {
    const bets = series(10, 0, { odds: 5.5, selection: "Arsenal vinner" });
    expect(deriveDisciplineRules(bets, { now: NOW, minSettled: 40 }).rules).toHaveLength(0);
  });

  it("stays silent on segments that sit inside the no-edge spread", () => {
    // 60 bets at 2.00 with exactly half won = dead on the baseline.
    const bets = series(60, 30, { odds: 2.0, selection: "Arsenal vinner", market: "h2h" });
    const oddsRule = deriveDisciplineRules(bets, { now: NOW, minSettled: 40 }).rules.find(
      (r) => r.dim === "Odds"
    );
    expect(oddsRule).toBeUndefined();
  });

  it("only looks at the trailing window", () => {
    const old = series(120, 8, { odds: 5.5, selection: "Arsenal vinner" }).map((b) => ({
      ...b,
      placedAt: new Date("2023-01-15T12:00:00Z"),
    }));
    expect(deriveDisciplineRules(old, { now: NOW, sinceDays: 365, minSettled: 40 }).rules).toHaveLength(0);
    expect(
      deriveDisciplineRules(old, { now: NOW, sinceDays: null, minSettled: 40 }).rules.length
    ).toBeGreaterThan(0);
  });
});

describe("evaluateBet", () => {
  const ruleSet: DisciplineRuleSet = {
    windowLabel: "senaste året",
    settled: 500,
    minSettled: 40,
    rules: [
      { dim: "Odds", key: "Odds 5.00+", settled: 120, profitUnits: -60, roiPct: -21, z: -2.4, tone: "neg" },
      { dim: "Marknad", key: "Skott", settled: 300, profitUnits: 40, roiPct: 6.2, z: 2.1, tone: "pos" },
      { dim: "Typ", key: "Ackumulator", settled: 90, profitUnits: -30, roiPct: -14, z: -1.8, tone: "neg" },
    ],
  };

  it("quotes the derived numbers for a matching segment", () => {
    const v = evaluateBet({ odds: 6.0, stakeUnits: 1, selection: "Arsenal vinner" }, ruleSet);
    expect(v.level).toBe("warn");
    expect(v.notes[0].text).toContain("Odds 5.00+");
    expect(v.notes[0].text).toContain("−21,0% ROI");
    expect(v.notes[0].text).toContain("senaste året");
  });

  it("reports an edge market as positive, and both together as mixed", () => {
    expect(evaluateBet({ odds: 1.85, selection: "Över 24.5 skott" }, ruleSet).level).toBe("edge");
    expect(evaluateBet({ odds: 6.0, selection: "Över 24.5 skott" }, ruleSet).level).toBe("mixed");
  });

  it("flags accumulators through the Typ dimension", () => {
    const v = evaluateBet({ betType: "accumulator", odds: 2.0 }, ruleSet);
    expect(v.notes.some((n) => n.text.includes("Ackumulator"))).toBe(true);
  });

  it("says nothing about odds or stake while those fields are empty", () => {
    const v = evaluateBet({ selection: "Arsenal vinner" }, ruleSet);
    expect(v.notes.some((n) => n.text.includes("Odds"))).toBe(false);
    expect(v.level).toBe("none");
  });

  it("says nothing at all without a rule set", () => {
    expect(evaluateBet({ odds: 6.0, stakeUnits: 1 }).notes).toHaveLength(0);
  });

  it("warns when the bet piles onto a match that already has three open bets", () => {
    const open = openEventCounts([
      { event: "Arsenal vs Chelsea", stakeUnits: 1, outcome: "pending" },
      { event: "arsenal  vs chelsea", stakeUnits: 1, outcome: "pending" },
      { event: "Arsenal vs Chelsea", stakeUnits: 0.5, outcome: "pending" },
      { event: "Arsenal vs Chelsea", stakeUnits: 9, outcome: "win" }, // settled — not counted
    ]);
    const v = evaluateBet({ event: "Arsenal vs Chelsea ", odds: 1.9 }, ruleSet, open);
    expect(v.level).toBe("warn");
    expect(v.notes.some((n) => n.text.includes("redan 3 öppna spel"))).toBe(true);
  });

  it("only notes — does not warn — on the third bet of a match", () => {
    const open = openEventCounts([
      { event: "Arsenal vs Chelsea", stakeUnits: 1, outcome: "pending" },
      { event: "Arsenal vs Chelsea", stakeUnits: 1, outcome: "pending" },
    ]);
    const v = evaluateBet({ event: "Arsenal vs Chelsea", odds: 1.9 }, ruleSet, open);
    expect(v.level).toBe("none");
    expect(v.notes.some((n) => n.tone === "info")).toBe(true);
  });
});

describe("catch-all segments", () => {
  it("keeps Singel but drops the unclassified buckets", () => {
    const bets = [
      // Uncategorised singles that happen to have run hot.
      ...series(120, 84, { odds: 1.85, selection: "???", market: "other" }),
    ];
    const { rules } = deriveDisciplineRules(bets, { now: NOW, minSettled: 40 });
    expect(rules.some((r) => r.dim === "Typ" && r.key === "Singel")).toBe(true);
    expect(rules.some((r) => r.key === "Övrigt")).toBe(false);
    expect(rules.some((r) => r.key === "Okänd sport")).toBe(false);
  });
});

describe("empty form fields", () => {
  const ruleSet: DisciplineRuleSet = {
    windowLabel: "senaste året",
    settled: 500,
    minSettled: 40,
    rules: [
      { dim: "Marknad", key: "Skott", settled: 300, profitUnits: 40, roiPct: 6.2, z: 2.1, tone: "pos" },
    ],
  };

  it("reads the category from the selection when the category dropdown is untouched", () => {
    // The add-bet form sends "" for an unset dropdown, not null.
    const v = evaluateBet({ selection: "Över 24.5 skott", marketCategory: "", odds: 1.9 }, ruleSet);
    expect(v.notes.some((n) => n.text.includes("Skott"))).toBe(true);
  });
});
