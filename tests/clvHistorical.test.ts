import { describe, it, expect } from "vitest";
import {
  betOutcomeSide,
  booksForMarket,
  expectedOutcomes,
  fairClosingFor,
} from "../lib/clvHistorical";
import type { OddsEvent } from "../lib/oddsApi";
import { extractOddsApiPrices } from "../lib/oddsApiMap";
import type { BookMarket } from "../lib/marketOdds";

/** Build an Odds API event the way a /historical snapshot returns one. */
function event(bookmakers: OddsEvent["bookmakers"]): OddsEvent {
  return {
    id: "ev1",
    sport_key: "soccer_epl",
    sport_title: "EPL",
    commence_time: "2026-03-01T15:00:00Z",
    home_team: "Arsenal",
    away_team: "Chelsea",
    bookmakers,
  };
}

const h2h = (key: string, home: number, draw: number | null, away: number) => ({
  key,
  title: key,
  last_update: "2026-03-01T14:58:00Z",
  markets: [
    {
      key: "h2h",
      outcomes: [
        { name: "Arsenal", price: home },
        ...(draw == null ? [] : [{ name: "Draw", price: draw }]),
        { name: "Chelsea", price: away },
      ],
    },
  ],
});

const totals = (key: string, line: number, over: number, under: number) => ({
  key,
  title: key,
  last_update: "2026-03-01T14:58:00Z",
  markets: [
    {
      key: "totals",
      outcomes: [
        { name: "Over", price: over, point: line },
        { name: "Under", price: under, point: line },
      ],
    },
  ],
});

describe("betOutcomeSide", () => {
  const ev = event([h2h("pinnacle", 2.0, 3.6, 4.0)]);

  it("maps a structured home bet", () => {
    const side = betOutcomeSide(
      { market: "h2h", selection: "Arsenal", selectionSide: "home", line: null, homeTeam: "Arsenal", awayTeam: "Chelsea", event: "Arsenal vs Chelsea" },
      ev
    );
    expect(side).toMatchObject({ market: "h2h", outcome: "home", outcomeName: "Arsenal" });
  });

  it("maps a Swedish draw selection without a structured side", () => {
    const side = betOutcomeSide(
      { market: "h2h", selection: "Oavgjort", selectionSide: null, line: null, homeTeam: "Arsenal", awayTeam: "Chelsea", event: "Arsenal vs Chelsea" },
      ev
    );
    expect(side?.outcome).toBe("draw");
  });

  it("maps an over bet with its line", () => {
    const side = betOutcomeSide(
      { market: "totals", selection: "Över 2.5", selectionSide: "over", line: 2.5, homeTeam: "Arsenal", awayTeam: "Chelsea", event: "Arsenal vs Chelsea" },
      ev
    );
    expect(side).toMatchObject({ market: "totals", outcome: "over", point: 2.5 });
  });

  it("returns null for a market it cannot place", () => {
    expect(
      betOutcomeSide(
        { market: "other", selection: "Båda lagen gör mål", selectionSide: null, line: null, homeTeam: "Arsenal", awayTeam: "Chelsea", event: "Arsenal vs Chelsea" },
        ev
      )
    ).toBeNull();
  });
});

describe("expectedOutcomes", () => {
  const withDraw: BookMarket[] = [
    { bookmaker: "pinnacle", outcomes: [{ outcome: "home", odds: 2 }, { outcome: "draw", odds: 3.6 }, { outcome: "away", odds: 4 }] },
  ];
  const twoWay: BookMarket[] = [
    { bookmaker: "pinnacle", outcomes: [{ outcome: "home", odds: 1.9 }, { outcome: "away", odds: 2.0 }] },
  ];

  it("reads three-way off the data", () => {
    expect(expectedOutcomes(withDraw, "1x2")).toEqual(["home", "draw", "away"]);
  });

  // Hardcoding a draw would make every NHL/tennis moneyline unpriceable.
  it("reads two-way off the data", () => {
    expect(expectedOutcomes(twoWay, "1x2")).toEqual(["home", "away"]);
  });

  it("is fixed for totals", () => {
    expect(expectedOutcomes([], "totals")).toEqual(["over", "under"]);
  });
});

describe("booksForMarket", () => {
  const ev = event([totals("pinnacle", 2.5, 1.9, 1.95), totals("bet365", 3.5, 3.2, 1.35)]);
  const { rows } = extractOddsApiPrices(ev);

  it("keeps only the requested line", () => {
    const books = booksForMarket(rows, "totals", 2.5);
    expect(books.map((b) => b.bookmaker)).toEqual(["pinnacle"]);
  });

  it("returns nothing for a line no book quoted", () => {
    expect(booksForMarket(rows, "totals", 4.5)).toEqual([]);
  });
});

describe("fairClosingFor", () => {
  it("de-vigs a three-way market off Pinnacle", () => {
    const ev = event([h2h("pinnacle", 2.0, 3.6, 4.0)]);
    const fair = fairClosingFor(ev, "h2h", "home", null)!;
    expect(fair.reference.source).toBe("pinnacle");
    // Removing the vig always LENGTHENS the price — that is the whole point,
    // and it is why measuring CLV against the raw 2.00 flatters the bettor.
    expect(fair.fairOdds).toBeGreaterThan(2.0);
  });

  it("prefers the exchange when it is present and tight", () => {
    const exch = {
      key: "betfair_ex_eu",
      title: "Betfair",
      last_update: "2026-03-01T14:58:00Z",
      markets: [
        { key: "h2h", outcomes: [{ name: "Arsenal", price: 2.08 }, { name: "Draw", price: 3.7 }, { name: "Chelsea", price: 4.2 }] },
        { key: "h2h_lay", outcomes: [{ name: "Arsenal", price: 2.1 }, { name: "Draw", price: 3.75 }, { name: "Chelsea", price: 4.25 }] },
      ],
    };
    const fair = fairClosingFor(event([h2h("pinnacle", 2.0, 3.6, 4.0), exch]), "h2h", "home", null)!;
    expect(fair.reference.source).toBe("exchange");
  });

  it("falls back to a book consensus when no sharp source quoted the market", () => {
    const ev = event([
      h2h("unibet_se", 2.0, 3.6, 4.0),
      h2h("betsson", 2.02, 3.55, 4.05),
      h2h("leovegas_se", 1.98, 3.65, 3.95),
    ]);
    const fair = fairClosingFor(ev, "h2h", "home", null)!;
    expect(fair.reference.source).toBe("consensus");
    expect(fair.fairOdds).toBeGreaterThan(2.0);
  });

  it("is null when too few books priced the market", () => {
    expect(fairClosingFor(event([h2h("unibet_se", 2.0, 3.6, 4.0)]), "h2h", "home", null)).toBeNull();
  });

  it("prices a totals line", () => {
    const ev = event([totals("pinnacle", 2.5, 1.9, 1.95)]);
    const fair = fairClosingFor(ev, "totals", "over", 2.5)!;
    expect(fair.fairOdds).toBeGreaterThan(1.9);
    expect(fair.reference.overround).toBeGreaterThan(0);
  });

  // Books disagree about the sign of an Asian handicap line and only five are
  // mapped, so a "fair" AH price would be confidently wrong. Raw only.
  it("refuses to price Asian handicap", () => {
    const ev = event([
      {
        key: "pinnacle",
        title: "Pinnacle",
        last_update: "2026-03-01T14:58:00Z",
        markets: [
          { key: "spreads", outcomes: [{ name: "Arsenal", price: 1.9, point: -0.5 }, { name: "Chelsea", price: 1.95, point: 0.5 }] },
        ],
      },
    ]);
    expect(fairClosingFor(ev, "spreads", "home", -0.5)).toBeNull();
  });
});
