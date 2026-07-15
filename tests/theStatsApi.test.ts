import { describe, it, expect } from "vitest";
import {
  parseOddsValue,
  pickBookmakerOdds,
  isStatsApiMatchRef,
  statsApiSportKey,
  statsApiBookmakerName,
} from "../lib/theStatsApi";

describe("isStatsApiMatchRef", () => {
  it("detects mt_ prefix", () => {
    expect(isStatsApiMatchRef("mt_838955483")).toBe(true);
    expect(isStatsApiMatchRef("ev-abc")).toBe(false);
    expect(isStatsApiMatchRef(null)).toBe(false);
  });
});

describe("statsApiSportKey", () => {
  it("prefixes competition id", () => {
    expect(statsApiSportKey("comp_3039")).toBe("tsa:comp_3039");
  });
});

describe("parseOddsValue", () => {
  it("parses last_seen closing odds", () => {
    expect(parseOddsValue({ opening: "1.50", last_seen: "1.72" })).toBe(1.72);
  });
  it("returns null for invalid values", () => {
    expect(parseOddsValue(undefined)).toBeNull();
    expect(parseOddsValue({ opening: null, last_seen: "0.95" })).toBeNull();
  });
});

describe("statsApiBookmakerName", () => {
  it("maps common bookmakers", () => {
    expect(statsApiBookmakerName("Bet365")).toBe("Bet365");
    expect(statsApiBookmakerName("Pinnacle")).toBe("Pinnacle");
    expect(statsApiBookmakerName("Betsson")).toBe("Kambi");
  });
});

describe("pickBookmakerOdds", () => {
  const bookmakers = [
    {
      bookmaker: "Bet365",
      markets: {
        match_odds: {
          home: { opening: "2.00", last_seen: "1.90" },
        },
      },
    },
    {
      bookmaker: "Pinnacle",
      markets: {
        match_odds: {
          home: { opening: "2.10", last_seen: "1.85" },
        },
      },
    },
  ];

  it("prefers bet bookmaker", () => {
    expect(pickBookmakerOdds(bookmakers, "Bet365")?.bookmaker).toBe("Bet365");
  });
  it("falls back to Pinnacle then Bet365", () => {
    expect(pickBookmakerOdds(bookmakers, "Unibet")?.bookmaker).toBe("Pinnacle");
  });
});
