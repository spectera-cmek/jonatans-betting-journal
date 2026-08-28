import { describe, expect, it } from "vitest";
import {
  isInKickoffClvWindow,
  oddsApiOutcomeForBet,
} from "../lib/clvOddsApi";
import { preferredPriceFor, type OddsEvent } from "../lib/oddsApi";

const event = {
  home_team: "Arsenal",
  away_team: "Chelsea",
};

describe("isInKickoffClvWindow", () => {
  const now = Date.parse("2026-07-26T15:00:00Z");

  it("is true 20 min before kickoff", () => {
    expect(
      isInKickoffClvWindow(new Date("2026-07-26T15:20:00Z"), { now })
    ).toBe(true);
  });

  it("is false more than 30 min before kickoff", () => {
    expect(
      isInKickoffClvWindow(new Date("2026-07-26T15:45:00Z"), { now })
    ).toBe(false);
  });

  it("is true a few minutes after kickoff", () => {
    expect(
      isInKickoffClvWindow(new Date("2026-07-26T14:57:00Z"), { now })
    ).toBe(true);
  });
});

describe("oddsApiOutcomeForBet", () => {
  it("maps h2h home/away/draw", () => {
    expect(
      oddsApiOutcomeForBet(
        {
          market: "h2h",
          selection: "Arsenal",
          selectionSide: "home",
          line: null,
          homeTeam: "Arsenal",
          awayTeam: "Chelsea",
          event: "Arsenal vs Chelsea",
        },
        event
      )
    ).toEqual({ market: "h2h", outcomeName: "Arsenal" });

    expect(
      oddsApiOutcomeForBet(
        {
          market: "h2h",
          selection: "Oavgjort",
          selectionSide: "draw",
          line: null,
          homeTeam: "Arsenal",
          awayTeam: "Chelsea",
          event: "Arsenal vs Chelsea",
        },
        event
      )
    ).toEqual({ market: "h2h", outcomeName: "Draw" });
  });

  // Sidan härleds vid inmatningen och blir fel när hem-/bortalag saknas. Litade
  // koden på den hämtades motståndarens closing — som ser rimlig ut.
  it("lets the selection name override a contradicting selectionSide", () => {
    expect(
      oddsApiOutcomeForBet(
        {
          market: "h2h",
          selection: "Chelsea vinst fulltid",
          selectionSide: "home",
          line: null,
          homeTeam: null,
          awayTeam: null,
          event: "Arsenal - Chelsea",
        },
        event
      )
    ).toEqual({ market: "h2h", outcomeName: "Chelsea" });

    expect(
      oddsApiOutcomeForBet(
        {
          market: "spreads",
          selection: "Chelsea -1.5",
          selectionSide: "home",
          line: -1.5,
          homeTeam: null,
          awayTeam: null,
          event: "Arsenal - Chelsea",
        },
        event
      )
    ).toEqual({ market: "spreads", outcomeName: "Chelsea", point: -1.5 });
  });

  it("still uses selectionSide when the name matches neither team", () => {
    expect(
      oddsApiOutcomeForBet(
        {
          market: "h2h",
          selection: "1",
          selectionSide: "home",
          line: null,
          homeTeam: "Arsenal",
          awayTeam: "Chelsea",
          event: "Arsenal vs Chelsea",
        },
        event
      )
    ).toEqual({ market: "h2h", outcomeName: "Arsenal" });
  });

  it("maps totals over/under with line", () => {
    expect(
      oddsApiOutcomeForBet(
        {
          market: "totals",
          selection: "Over 2.5",
          selectionSide: "over",
          line: 2.5,
          homeTeam: "Arsenal",
          awayTeam: "Chelsea",
          event: "Arsenal vs Chelsea",
        },
        event
      )
    ).toEqual({ market: "totals", outcomeName: "Over", point: 2.5 });
  });

  it("maps spreads to team + point", () => {
    expect(
      oddsApiOutcomeForBet(
        {
          market: "spreads",
          selection: "Arsenal -1.5",
          selectionSide: "home",
          line: -1.5,
          homeTeam: "Arsenal",
          awayTeam: "Chelsea",
          event: "Arsenal vs Chelsea",
        },
        event
      )
    ).toEqual({ market: "spreads", outcomeName: "Arsenal", point: -1.5 });
  });
});

describe("preferredPriceFor", () => {
  const sample: OddsEvent = {
    id: "e1",
    sport_key: "soccer_epl",
    sport_title: "EPL",
    commence_time: "2026-07-20T15:00:00Z",
    home_team: "Arsenal",
    away_team: "Chelsea",
    bookmakers: [
      {
        key: "unibet",
        title: "Unibet",
        last_update: "2026-07-20T14:50:00Z",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Arsenal", price: 2.1 },
              { name: "Chelsea", price: 3.4 },
              { name: "Draw", price: 3.2 },
            ],
          },
        ],
      },
      {
        key: "pinnacle",
        title: "Pinnacle",
        last_update: "2026-07-20T14:55:00Z",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Arsenal", price: 1.95 },
              { name: "Chelsea", price: 3.6 },
              { name: "Draw", price: 3.4 },
            ],
          },
        ],
      },
    ],
  };

  it("prefers pinnacle over softer books", () => {
    expect(preferredPriceFor(sample, "h2h", "Arsenal")).toEqual({
      price: 1.95,
      bookmaker: "pinnacle",
    });
  });
});
