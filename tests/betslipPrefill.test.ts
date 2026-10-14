import { describe, it, expect } from "vitest";
import { betslipPrefill } from "../lib/betslipPrefill";
import { normalizeBookmaker } from "../lib/constants";
import type { ParsedBetWithDupe } from "../lib/betslipExtract";

// A parsed single, as the vision step returns it. Tests override one field at a
// time so a failure points at the rule under test.
const parsed = (over: Partial<ParsedBetWithDupe> = {}): ParsedBetWithDupe => ({
  event: "Arsenal vs Chelsea",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  sport: "Football",
  league: "Premier League",
  market: "h2h",
  marketCategory: "Matchvinnare",
  marketScope: "match",
  selection: "Arsenal",
  selectionSide: "home",
  line: null,
  betType: "single",
  legs: null,
  odds: 1.95,
  stakeKr: 150,
  importRef: "XP7687095241I",
  bookmaker: "Betsson",
  eventAt: "2026-08-24T20:45:00+02:00",
  placedAt: "2026-08-24T18:10:00+02:00",
  duplicate: null,
  ...over,
});

describe("betslipPrefill — bookmaker", () => {
  it("keeps the bookmaker the receipt showed", () => {
    expect(betslipPrefill(parsed(), { unitValue: 100 }).form.bookmaker).toBe("Betsson");
  });

  it("canonicalises spelling variants onto one name", () => {
    expect(betslipPrefill(parsed({ bookmaker: "bet 365" }), { unitValue: 100 }).form.bookmaker).toBe("Bet365");
    expect(betslipPrefill(parsed({ bookmaker: "unibet.se" }), { unitValue: 100 }).form.bookmaker).toBe("Unibet");
  });

  // The regression this guards: an unreadable brand used to inherit the form's
  // "Bet365" default, so the bet was logged — and CLV-priced — at the wrong book.
  it("leaves the bookmaker empty when the receipt could not be identified", () => {
    expect(betslipPrefill(parsed({ bookmaker: null }), { unitValue: 100 }).form.bookmaker).toBe("");
    expect(betslipPrefill(parsed({ bookmaker: "okänd" }), { unitValue: 100 }).form.bookmaker).toBe("");
  });
});

describe("betslipPrefill — bet type", () => {
  it("keeps a Bet Builder as its own type instead of a single", () => {
    const p = parsed({
      betType: "betbuilder",
      market: "other",
      selection: "Bet Builder: Under 3 mål + Saka 1+ skott på mål",
      legs: [
        { selection: "Under 3 mål", event: "Arsenal vs Chelsea", odds: 1.7 },
        { selection: "Saka 1+ skott på mål", event: "Arsenal vs Chelsea", odds: 1.5 },
      ],
    });
    const pre = betslipPrefill(p, { unitValue: 100 });
    expect(pre.form.betType).toBe("betbuilder");
    expect(pre.legs).toHaveLength(2);
  });

  it("carries an accumulator through", () => {
    expect(betslipPrefill(parsed({ betType: "accumulator" }), { unitValue: 100 }).form.betType).toBe("accumulator");
  });

  it("falls back to single for an unknown type", () => {
    expect(
      betslipPrefill(parsed({ betType: "system" as ParsedBetWithDupe["betType"] }), { unitValue: 100 }).form.betType
    ).toBe("single");
  });
});

describe("betslipPrefill — kickoff time", () => {
  it("keeps the full kickoff timestamp beside the date field", () => {
    const pre = betslipPrefill(parsed(), { unitValue: 100 });
    expect(pre.form.eventAt).toBe("2026-08-24");
    expect(pre.eventAtIso).toBe("2026-08-24T20:45:00+02:00");
  });

  it("dates a bet by the Swedish calendar day of the kickoff", () => {
    // 23:30 UTC on the 24th is 01:30 on the 25th in Stockholm.
    const pre = betslipPrefill(parsed({ eventAt: "2026-08-24T23:30:00Z" }), { unitValue: 100 });
    expect(pre.form.eventAt).toBe("2026-08-25");
  });

  it("has no kickoff to keep when the receipt only showed a date", () => {
    const pre = betslipPrefill(parsed({ eventAt: "2026-08-24" }), { unitValue: 100 });
    expect(pre.form.eventAt).toBe("2026-08-24");
    expect(pre.eventAtIso).toBeNull();
  });

  it("falls back to the placement day when no kickoff was shown", () => {
    expect(betslipPrefill(parsed({ eventAt: null }), { unitValue: 100 }).form.eventAt).toBe("2026-08-24");
  });
});

describe("betslipPrefill — fields the receipt did not show", () => {
  it("leaves odds and stake blank rather than inventing them", () => {
    const pre = betslipPrefill(parsed({ odds: null, stakeKr: null }), { unitValue: 100 });
    expect(pre.form.odds).toBe("");
    expect(pre.form.stakeUnits).toBe("");
  });

  it("converts the stake in kronor to units", () => {
    expect(betslipPrefill(parsed({ stakeKr: 150 }), { unitValue: 100 }).form.stakeUnits).toBe("1.5");
    expect(betslipPrefill(parsed({ stakeKr: 261 }), { unitValue: 100 }).form.stakeUnits).toBe("2.61");
  });

  it("leaves the side blank so the server can derive it", () => {
    expect(betslipPrefill(parsed({ selectionSide: null }), { unitValue: 100 }).form.selectionSide).toBe("");
  });
});

describe("betslipPrefill — event kind", () => {
  it("tags a match as a match", () => {
    expect(betslipPrefill(parsed(), { unitValue: 100 }).form.eventKind).toBe("match");
  });

  it("tags a teamless outright as an outright", () => {
    const pre = betslipPrefill(
      parsed({
        event: "Vinnare VM 2026",
        homeTeam: null,
        awayTeam: null,
        selection: "Frankrike",
        league: "VM 2026",
      }),
      { unitValue: 100 }
    );
    expect(pre.form.eventKind).toBe("outright");
  });

  it("does not mistake a fixture without parsed teams for an outright", () => {
    const pre = betslipPrefill(
      parsed({ event: "CIN Reds vs PHI Phillies", homeTeam: null, awayTeam: null }),
      { unitValue: 100 }
    );
    expect(pre.form.eventKind).toBe("match");
  });
});

describe("betslipPrefill — receipt metadata", () => {
  it("carries the reference, placement time, duplicate warning and queue position", () => {
    const dupe = { betId: "abc", event: "Arsenal vs Chelsea", selection: "Arsenal" };
    const pre = betslipPrefill(parsed({ duplicate: dupe }), { unitValue: 100, index: 1, total: 3 });
    expect(pre.importRef).toBe("XP7687095241I");
    expect(pre.placedAt).toBe("2026-08-24T18:10:00+02:00");
    expect(pre.duplicate).toEqual(dupe);
    expect(pre.queue).toEqual({ index: 1, total: 3 });
  });
});

describe("normalizeBookmaker", () => {
  it("maps casing, spacing and punctuation onto the canonical name", () => {
    expect(normalizeBookmaker("bet365")).toBe("Bet365");
    expect(normalizeBookmaker("BET 365")).toBe("Bet365");
    expect(normalizeBookmaker("Bet-365")).toBe("Bet365");
    expect(normalizeBookmaker("mr. green")).toBe("Mr Green");
    expect(normalizeBookmaker("leo vegas")).toBe("LeoVegas");
    expect(normalizeBookmaker("888 Sport")).toBe("888sport");
    expect(normalizeBookmaker("svenska spel")).toBe("Svenska Spel");
    expect(normalizeBookmaker("come on")).toBe("ComeOn");
  });

  it("strips site suffixes betslips hang on the brand", () => {
    expect(normalizeBookmaker("Betsson.se")).toBe("Betsson");
    expect(normalizeBookmaker("Bet365 Sportsbook")).toBe("Bet365");
    expect(normalizeBookmaker("Unibet Sverige")).toBe("Unibet");
    expect(normalizeBookmaker("x3000.se")).toBe("x3000");
  });

  it("keeps casino brands apart from their shorter namesakes", () => {
    expect(normalizeBookmaker("lucky casino")).toBe("LuckyCasino");
    expect(normalizeBookmaker("Lucky")).toBe("Lucky");
  });

  // Two books the log wrote under two names each; the short form is the same
  // book, so both fold onto the spelling the history already uses.
  it("folds the short forms of Happy and Vera&John", () => {
    expect(normalizeBookmaker("happy casino")).toBe("HappyCasino");
    expect(normalizeBookmaker("Happy")).toBe("HappyCasino");
    expect(normalizeBookmaker("Vera & John")).toBe("veraochjohn");
    expect(normalizeBookmaker("Vera&John")).toBe("veraochjohn");
    expect(normalizeBookmaker("veraochjohn")).toBe("veraochjohn");
  });

  it("treats an unreadable brand as no bookmaker at all", () => {
    expect(normalizeBookmaker(null)).toBeNull();
    expect(normalizeBookmaker("  ")).toBeNull();
    expect(normalizeBookmaker("okänd")).toBeNull();
    expect(normalizeBookmaker("unknown")).toBeNull();
  });

  it("canonicalises the books logged from screenshots", () => {
    expect(normalizeBookmaker("PAF")).toBe("Paf");
    expect(normalizeBookmaker("paf.se")).toBe("Paf");
    expect(normalizeBookmaker("smarkets")).toBe("Smarkets");
    expect(normalizeBookmaker("speedybet")).toBe("SpeedyBet");
    expect(normalizeBookmaker("nordic bet")).toBe("NordicBet");
    expect(normalizeBookmaker("golden bull")).toBe("GoldenBull");
  });

  it("keeps a book it has never seen instead of dropping it", () => {
    expect(normalizeBookmaker("Betano.se")).toBe("Betano.se");
    expect(normalizeBookmaker("Stake")).toBe("Stake");
  });
});
