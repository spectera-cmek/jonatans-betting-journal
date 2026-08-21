import { describe, expect, it } from "vitest";
import { scanValuePlays } from "../lib/valueScanner";
import type { OddsEvent } from "../lib/oddsApi";

const event: OddsEvent = {
  id: "fixture-1",
  sport_key: "soccer_epl",
  sport_title: "Premier League",
  commence_time: "2026-08-20T14:00:00Z",
  home_team: "Arsenal",
  away_team: "Chelsea",
  bookmakers: [
    {
      key: "book-a",
      title: "Book A",
      last_update: "2026-08-19T10:00:00Z",
      markets: [{ key: "h2h", outcomes: [{ name: "Arsenal", price: 2 }, { name: "Chelsea", price: 2 }] }],
    },
    {
      key: "book-b",
      title: "Book B",
      last_update: "2026-08-19T10:00:00Z",
      markets: [{ key: "h2h", outcomes: [{ name: "Arsenal", price: 2.1 }, { name: "Chelsea", price: 1.9 }] }],
    },
    {
      key: "book-c",
      title: "Book C",
      last_update: "2026-08-19T10:00:00Z",
      markets: [{ key: "h2h", outcomes: [{ name: "Arsenal", price: 2.2 }, { name: "Chelsea", price: 1.8 }] }],
    },
  ],
};

describe("scanValuePlays", () => {
  it("ranks the best price against the median de-vigged consensus", () => {
    const result = scanValuePlays([event]);
    const arsenal = result.rows.find((row) => row.selection === "Arsenal")!;

    // De-vigged Arsenal probabilities: 0.50, 0.475 and 0.45 → median 0.475.
    expect(arsenal.bookmaker).toBe("Book C");
    expect(arsenal.bestOdds).toBe(2.2);
    expect(arsenal.fairProbability).toBeCloseTo(0.475, 8);
    expect(arsenal.fairOdds).toBeCloseTo(1 / 0.475, 8);
    expect(arsenal.edge).toBeCloseTo(0.045, 8);
    expect(result.rows[0].edge).toBeGreaterThanOrEqual(result.rows[1].edge);
  });

  it("does not blend two-way and three-way price sets", () => {
    const mixed: OddsEvent = {
      ...event,
      bookmakers: [
        ...event.bookmakers,
        {
          key: "book-d",
          title: "Book D",
          last_update: "2026-08-19T10:00:00Z",
          markets: [{ key: "h2h", outcomes: [{ name: "Arsenal", price: 2.4 }, { name: "Draw", price: 3.3 }, { name: "Chelsea", price: 3.1 }] }],
        },
      ],
    };
    const result = scanValuePlays([mixed]);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.some((row) => row.bookmaker === "Book D")).toBe(false);
  });

  it("requires the requested number of independent bookmakers", () => {
    expect(scanValuePlays([{ ...event, bookmakers: event.bookmakers.slice(0, 2) }]).rows).toEqual([]);
    expect(scanValuePlays([{ ...event, bookmakers: event.bookmakers.slice(0, 2) }], 2).rows).toHaveLength(2);
  });
});
