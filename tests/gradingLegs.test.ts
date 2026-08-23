import { describe, it, expect } from "vitest";
import {
  gradeAccumulator,
  gradeLeg,
  legOutcomeFromLabel,
  parseLegs,
  fixtureMatchesLeg,
  type LegFixture,
  type RawLeg,
} from "../lib/gradingLegs";

const fixture = (home: string, away: string, hs: number, as: number): LegFixture => ({
  homeTeam: home,
  awayTeam: away,
  score: { homeScore: hs, awayScore: as },
});

describe("parseLegs", () => {
  it("reads a leg array", () => {
    expect(parseLegs('[{"selection":"Arsenal","odds":1.8}]')).toHaveLength(1);
  });

  it("shrugs off anything that is not one", () => {
    expect(parseLegs(null)).toEqual([]);
    expect(parseLegs("not json")).toEqual([]);
    expect(parseLegs('{"selection":"Arsenal"}')).toEqual([]);
  });
});

describe("legOutcomeFromLabel", () => {
  it("reads bet365's Swedish verdicts", () => {
    expect(legOutcomeFromLabel("Vunnet")).toBe("win");
    expect(legOutcomeFromLabel("Förlorat")).toBe("loss");
    expect(legOutcomeFromLabel("Annullerat")).toBe("void");
  });

  // An unfinished or unrecognised leg must fall through to real grading rather
  // than defaulting to a loss.
  it("returns null for anything it does not recognise", () => {
    expect(legOutcomeFromLabel("Pågående")).toBeNull();
    expect(legOutcomeFromLabel("Halv vinst")).toBeNull();
    expect(legOutcomeFromLabel("")).toBeNull();
    expect(legOutcomeFromLabel("???")).toBeNull();
  });
});

describe("fixtureMatchesLeg", () => {
  it("matches either orientation", () => {
    const leg: RawLeg = { event: "Arsenal vs Chelsea" };
    expect(fixtureMatchesLeg(leg, fixture("Arsenal", "Chelsea", 1, 0))).toBe(true);
    expect(fixtureMatchesLeg(leg, fixture("Chelsea", "Arsenal", 0, 1))).toBe(true);
  });

  it("does not match a different fixture", () => {
    expect(fixtureMatchesLeg({ event: "Arsenal vs Chelsea" }, fixture("Leeds", "Everton", 1, 1))).toBe(
      false
    );
  });
});

describe("gradeLeg", () => {
  it("trusts the book's own verdict without needing a fixture", () => {
    expect(gradeLeg({ selection: "Arsenal", outcome: "Vunnet", odds: 1.8 }, 0, []).outcome).toBe("win");
  });

  it("grades a hand-logged leg from the score", () => {
    const leg: RawLeg = { selection: "Over 2.5", event: "Arsenal vs Chelsea", odds: 1.9 };
    expect(gradeLeg(leg, 0, [fixture("Arsenal", "Chelsea", 2, 1)]).outcome).toBe("win");
    expect(gradeLeg(leg, 0, [fixture("Arsenal", "Chelsea", 1, 1)]).outcome).toBe("loss");
  });

  it("reports which leg it could not place", () => {
    const r = gradeLeg({ selection: "Over 2.5", event: "Leeds vs Everton" }, 2, [
      fixture("Arsenal", "Chelsea", 2, 1),
    ]);
    expect(r.outcome).toBeNull();
    expect(r.reason).toContain("Leeds vs Everton");
  });

  it("refuses an unreadable selection rather than guessing", () => {
    const r = gradeLeg({ selection: "Salah 2+ skott", event: "Arsenal vs Chelsea" }, 1, [
      fixture("Arsenal", "Chelsea", 2, 1),
    ]);
    expect(r.outcome).toBeNull();
    expect(r.reason).toContain("Salah");
  });
});

describe("gradeAccumulator", () => {
  const won = (odds: number): RawLeg => ({ selection: "x", outcome: "Vunnet", odds });
  const lost = (odds: number): RawLeg => ({ selection: "x", outcome: "Förlorat", odds });
  const voided = (odds: number): RawLeg => ({ selection: "x", outcome: "Annullerat", odds });

  it("wins when every leg wins, at the product of the odds", () => {
    const g = gradeAccumulator([won(1.5), won(2)], 1);
    expect(g.outcome).toBe("win");
    expect(g.effectiveOdds).toBeCloseTo(3, 6);
    expect(g.profitUnits).toBeCloseTo(2, 6);
  });

  it("loses on a single lost leg", () => {
    const g = gradeAccumulator([won(1.5), lost(2), won(3)], 2);
    expect(g.outcome).toBe("loss");
    expect(g.profitUnits).toBe(-2);
  });

  // A lost leg settles the coupon whatever else is unknown — blocking there
  // would leave a certain loss sitting pending forever.
  it("still settles a loss when another leg is unresolvable", () => {
    const g = gradeAccumulator([lost(2), { selection: "???", event: "Okänd match" }], 1);
    expect(g.outcome).toBe("loss");
  });

  it("drops void legs and re-multiplies the rest", () => {
    const g = gradeAccumulator([won(1.5), voided(2), won(2)], 1);
    expect(g.outcome).toBe("win");
    expect(g.effectiveOdds).toBeCloseTo(3, 6);
    expect(g.profitUnits).toBeCloseTo(2, 6);
  });

  it("returns the stake when every leg is void", () => {
    const g = gradeAccumulator([voided(1.5), voided(2)], 3);
    expect(g.outcome).toBe("void");
    expect(g.profitUnits).toBe(0);
  });

  it("blocks with the offending leg named", () => {
    const g = gradeAccumulator([won(1.5), { selection: "Salah 2+ skott", event: "Arsenal vs Chelsea" }], 1);
    expect(g.outcome).toBeNull();
    expect(g.blockedReason).toContain("Ben 2");
    expect(g.profitUnits).toBeNull();
  });

  it("blocks on an empty leg list", () => {
    expect(gradeAccumulator([], 1).blockedReason).toContain("saknar sparade ben");
  });

  it("blocks when a winning leg has no odds to re-multiply", () => {
    const g = gradeAccumulator([won(1.5), { selection: "x", outcome: "Vunnet" }], 1);
    expect(g.outcome).toBeNull();
    expect(g.blockedReason).toContain("saknar odds");
  });

  it("grades a hand-logged coupon end to end", () => {
    const legs: RawLeg[] = [
      { selection: "Arsenal", event: "Arsenal vs Chelsea", odds: 1.8 },
      { selection: "Over 1.5", event: "Leeds vs Everton", odds: 1.5 },
    ];
    const g = gradeAccumulator(legs, 1, [
      fixture("Arsenal", "Chelsea", 2, 0),
      fixture("Leeds", "Everton", 1, 1),
    ]);
    expect(g.outcome).toBe("win");
    expect(g.effectiveOdds).toBeCloseTo(2.7, 6);
  });
});
