import { describe, it, expect } from "vitest";
import { evaluateBet, betCategory } from "../lib/discipline";
import {
  deriveDisciplineRules,
  matchRules,
  ruleNote,
  stakeBandKey,
  betTypeKey,
  EMPTY_RULE_SET,
  type DisciplineRuleSet,
  type RuleBetInput,
} from "../lib/disciplineRules";
import type { Outcome } from "../lib/betting";

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

describe("band keys", () => {
  it("buckets stakes on the upper bound", () => {
    expect(stakeBandKey(0.5)).toBe("Insats ≤ 0,5 u");
    expect(stakeBandKey(1)).toBe("Insats 0,51–1 u");
    expect(stakeBandKey(2)).toBe("Insats 1,01–2 u");
    expect(stakeBandKey(2.5)).toBe("Insats > 2 u");
  });
  it("treats anything that is not a single as an accumulator", () => {
    expect(betTypeKey("single")).toBe("Singel");
    expect(betTypeKey("accumulator")).toBe("Ackumulator");
    expect(betTypeKey("betbuilder")).toBe("Ackumulator");
    expect(betTypeKey(null)).toBe("Singel");
  });
});

/**
 * Build `n` settled bets in one segment with a chosen win rate, so a test can
 * dial a segment's ROI up or down on purpose.
 */
function segment(opts: {
  n: number;
  wins: number;
  odds: number;
  stakeUnits?: number;
  selection?: string;
  marketCategory?: string;
  sport?: string;
  betType?: string;
  daysAgo?: number;
}): RuleBetInput[] {
  const stake = opts.stakeUnits ?? 1;
  const at = new Date(Date.now() - (opts.daysAgo ?? 30) * 864e5);
  return Array.from({ length: opts.n }, (_, i) => ({
    odds: opts.odds,
    stakeUnits: stake,
    outcome: (i < opts.wins ? "win" : "loss") as Outcome,
    profitUnits: i < opts.wins ? stake * (opts.odds - 1) : -stake,
    eventAt: at,
    placedAt: at,
    createdAt: at,
    selection: opts.selection ?? "Arsenal",
    market: "h2h",
    marketCategory: opts.marketCategory ?? "Matchvinnare",
    sport: opts.sport ?? "Football",
    betType: opts.betType ?? "single",
  }));
}

describe("deriveDisciplineRules", () => {
  it("ignores segments below the sample-size floor", () => {
    // 20 bets is well under the default floor of 60, however bad the ROI.
    const rules = deriveDisciplineRules(segment({ n: 20, wins: 0, odds: 6 }));
    expect(rules.rules).toHaveLength(0);
    expect(rules.settledInWindow).toBe(20);
  });

  it("ignores segments whose ROI is inside the noise threshold", () => {
    // 100 bets at odds 2.0 with exactly half winning = 0 % ROI.
    const rules = deriveDisciplineRules(segment({ n: 100, wins: 50, odds: 2 }));
    expect(rules.rules.filter((r) => r.dim === "Marknad")).toHaveLength(0);
  });

  it("flags a losing segment as a leak and a winning one as an edge", () => {
    const bets = [
      // 100 longshots, 10 winners at 6.0 => ROI -40 %
      ...segment({ n: 100, wins: 10, odds: 6, marketCategory: "Vinstmetod", selection: "vinstmetod" }),
      // 100 shot bets, 60 winners at 2.0 => ROI +20 %
      ...segment({ n: 100, wins: 60, odds: 2, marketCategory: "Skott", selection: "Saka över 1.5 skott" }),
      // Neutral filler, so neither segment above trips the dominance cap.
      ...segment({ n: 400, wins: 200, odds: 2, marketCategory: "Matchvinnare" }),
    ];
    const { rules } = deriveDisciplineRules(bets);
    const leak = rules.find((r) => r.dim === "Marknad" && r.key === "Vinstmetod");
    const edge = rules.find((r) => r.dim === "Marknad" && r.key === "Skott");
    expect(leak?.tone).toBe("neg");
    expect(leak?.roiPct).toBeCloseTo(-40, 0);
    expect(edge?.tone).toBe("pos");
    expect(edge?.roiPct).toBeCloseTo(20, 0);
  });

  it("only looks at the rolling window", () => {
    // A minority losing segment plus a neutral majority, so the segment under
    // test is neither filtered for dominance nor for noise.
    const old = [
      ...segment({ n: 100, wins: 0, odds: 6, marketCategory: "Hörnor", daysAgo: 900 }),
      ...segment({ n: 300, wins: 150, odds: 2, marketCategory: "Matchvinnare", daysAgo: 900 }),
    ];
    const rules = deriveDisciplineRules(old, { windowMonths: 18 });
    expect(rules.rules).toHaveLength(0);
    expect(rules.settledInWindow).toBe(0);
    // The same bets do qualify with the window turned off.
    const all = deriveDisciplineRules(old, { windowMonths: null });
    expect(all.rules.some((r) => r.dim === "Marknad" && r.key === "Hörnor")).toBe(true);
  });

  it("excludes pending bets — rules describe realised performance", () => {
    const pending = segment({ n: 100, wins: 0, odds: 6 }).map((b) => ({
      ...b,
      outcome: "pending" as Outcome,
      profitUnits: null,
    }));
    expect(deriveDisciplineRules(pending).settledInWindow).toBe(0);
  });

  it("keeps 1.01 import placeholders out of the odds dimension", () => {
    // Placeholder-priced losses would otherwise create a fake "1.02–1.49" leak.
    const placeholders = segment({ n: 100, wins: 0, odds: 1.01 });
    const { rules } = deriveDisciplineRules(placeholders);
    expect(rules.some((r) => r.dim === "Odds")).toBe(false);
  });
});

describe("evaluateBet", () => {
  const ruleSet: DisciplineRuleSet = {
    ...EMPTY_RULE_SET,
    rules: [
      { dim: "Odds", key: "5.00+", tone: "neg", settled: 1611, profitUnits: -187.4, roiPct: -20.5 },
      { dim: "Marknad", key: "Skott", tone: "pos", settled: 1383, profitUnits: 156.5, roiPct: 7.6 },
      { dim: "Insats", key: "Insats > 2 u", tone: "pos", settled: 776, profitUnits: 509.3, roiPct: 19.8 },
    ],
  };

  it("says nothing without a rule set — advice needs data behind it", () => {
    const v = evaluateBet({ odds: 12, stakeUnits: 0.25, selection: "Över 9.5 hörnor" });
    expect(v.level).toBe("none");
    expect(v.notes).toHaveLength(0);
  });

  it("warns on a segment the data says leaks", () => {
    const v = evaluateBet({ odds: 6.5 }, ruleSet);
    expect(v.level).toBe("warn");
    expect(v.notes[0].tone).toBe("neg");
    expect(v.notes[0].text).toContain("5.00+");
  });

  it("reports an edge on a segment the data says pays", () => {
    const v = evaluateBet({ selection: "Saka över 1.5 skott", odds: 2.1 }, ruleSet);
    expect(v.level).toBe("edge");
    expect(v.notes.some((n) => n.text.includes("Skott"))).toBe(true);
  });

  it("returns mixed when a bet trips a leak and an edge at once", () => {
    const v = evaluateBet({ selection: "Saka över 1.5 skott", odds: 7, stakeUnits: 3 }, ruleSet);
    expect(v.level).toBe("mixed");
    expect(v.notes.some((n) => n.tone === "neg")).toBe(true);
    expect(v.notes.some((n) => n.tone === "pos")).toBe(true);
  });

  it("leads with the strongest signal", () => {
    // Odds 5+ (-20,5 %) outranks the stake edge (+19,8 %) on absolute ROI.
    const v = evaluateBet({ odds: 7, stakeUnits: 3 }, ruleSet);
    expect(v.notes[0].text).toContain("5.00+");
  });

  it("matches an explicit marketCategory over the free-text guess", () => {
    const v = evaluateBet({ selection: "Arsenal vinner", marketCategory: "Skott", odds: 2 }, ruleSet);
    expect(v.notes.some((n) => n.text.includes("Skott"))).toBe(true);
  });
});

describe("matchRules / ruleNote", () => {
  it("matches nothing for a bet outside every segment", () => {
    const set: DisciplineRuleSet = {
      ...EMPTY_RULE_SET,
      rules: [{ dim: "Sport", key: "Tennis", tone: "neg", settled: 278, profitUnits: -7.6, roiPct: -5.1 }],
    };
    expect(matchRules({ sport: "Football", odds: 2 }, set)).toHaveLength(0);
    expect(matchRules({ sport: "Tennis", odds: 2 }, set)).toHaveLength(1);
  });

  it("renders a note as Swedish numbers rather than prose", () => {
    const note = ruleNote({
      dim: "Odds",
      key: "5.00+",
      tone: "neg",
      settled: 1611,
      profitUnits: -187.4,
      roiPct: -20.5,
    });
    // sv-SE groups thousands with a non-breaking space (U+00A0).
    expect(note).toBe("5.00+: \u2212" + "20,5 % ROI över 1\u00a0611 spel (\u2212187,4u)");
  });
});

describe("deriveDisciplineRules — segments that describe nothing", () => {
  it("drops a segment that covers most of the window", () => {
    // 400 singles at +20 % ROI and 80 accumulators. "Singel" covers 83 % of the
    // window, so it restates overall ROI rather than isolating a behaviour.
    const bets = [
      ...segment({ n: 400, wins: 240, odds: 2, marketCategory: "Matchvinnare" }),
      ...segment({ n: 80, wins: 10, odds: 2, betType: "accumulator", marketCategory: "Kombination" }),
    ];
    const { rules } = deriveDisciplineRules(bets);
    expect(rules.some((r) => r.dim === "Typ" && r.key === "Singel")).toBe(false);
    // The minority side is still small enough to say something.
    expect(rules.some((r) => r.dim === "Typ" && r.key === "Ackumulator")).toBe(true);
  });

  it("never makes a rule out of the unclassifiable market bucket", () => {
    const bets = [
      ...segment({ n: 100, wins: 70, odds: 2, marketCategory: "Övrigt", selection: "?" }),
      ...segment({ n: 200, wins: 100, odds: 2, marketCategory: "Matchvinnare" }),
    ];
    const { rules } = deriveDisciplineRules(bets);
    expect(rules.some((r) => r.dim === "Marknad" && r.key === "Övrigt")).toBe(false);
  });
});
