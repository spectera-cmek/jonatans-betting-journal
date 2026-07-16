import { describe, it, expect } from "vitest";
import {
  closingOddsFromMatchOdds,
  closingOddsFromPlayerProps,
  extractClosingOdds,
  isAfterKickoff,
  isFootballBet,
  matchStatsEvent,
  type ClvBet,
} from "../lib/clvCapture";
import type { StatsMatch } from "../lib/theStatsApi";

const baseBet: ClvBet = {
  id: "1",
  event: "Arsenal vs Chelsea",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  market: "h2h",
  selection: "Arsenal",
  selectionSide: "home",
  odds: 2.1,
  bookmaker: "Bet365",
};

describe("isFootballBet", () => {
  it("accepts football sport", () => {
    expect(isFootballBet({ sport: "Football", league: null })).toBe(true);
  });
  it("rejects tennis", () => {
    expect(isFootballBet({ sport: "Tennis", league: null })).toBe(false);
  });
  it("rejects empty league when sport is missing (bug: '' matched every key)", () => {
    expect(isFootballBet({ sport: null, league: null })).toBe(false);
    expect(isFootballBet({ sport: "", league: "" })).toBe(false);
  });
  it("accepts known football league without sport", () => {
    expect(isFootballBet({ sport: null, league: "Premier League" })).toBe(true);
  });
});

describe("isAfterKickoff", () => {
  it("is false before kickoff", () => {
    const future = new Date(Date.now() + 60_000);
    expect(isAfterKickoff(future)).toBe(false);
  });
  it("is true after kickoff", () => {
    const past = new Date(Date.now() - 10 * 60_000);
    expect(isAfterKickoff(past)).toBe(true);
  });
});

describe("matchStatsEvent", () => {
  const matches: StatsMatch[] = [
    {
      id: "mt_1",
      competition_id: "comp_3039",
      status: "finished",
      utc_date: "2026-07-10T15:00:00.000Z",
      home_team: { id: "tm_1", name: "Arsenal" },
      away_team: { id: "tm_2", name: "Chelsea" },
    },
  ];

  it("matches Swedish team aliases", () => {
    const bet = {
      event: "Arsenal vs Chelsea",
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      eventAt: new Date("2026-07-10T16:00:00Z"),
    };
    expect(matchStatsEvent(bet, matches)?.id).toBe("mt_1");
  });
});

describe("closingOddsFromMatchOdds", () => {
  const odds = {
    match_id: "mt_1",
    bookmakers: [
      {
        bookmaker: "Pinnacle",
        markets: {
          match_odds: {
            home: { opening: "2.00", last_seen: "1.85" },
            draw: { opening: "3.40", last_seen: "3.50" },
            away: { opening: "3.80", last_seen: "4.00" },
          },
          btts: {
            yes: { opening: "1.70", last_seen: "1.75" },
            no: { opening: "2.10", last_seen: "2.05" },
          },
          total_goals: {
            "2.5": {
              over: { opening: "1.90", last_seen: "1.95" },
              under: { opening: "1.95", last_seen: "1.88" },
            },
          },
          match_corners: {
            "9.5": {
              over: { opening: "1.85", last_seen: "1.80" },
              under: { opening: "1.95", last_seen: "2.00" },
            },
          },
          asian_handicap: {
            home: { "-0.5": { opening: "2.10", last_seen: "2.05" } },
            away: { "+0.5": { opening: "1.80", last_seen: "1.75" } },
          },
        },
      },
    ],
  };

  it("extracts 1X2 home closing", () => {
    expect(closingOddsFromMatchOdds(baseBet, odds, "Arsenal", "Chelsea")).toBe(1.85);
  });

  it("extracts BTTS yes", () => {
    const bet: ClvBet = {
      ...baseBet,
      market: "other",
      marketCategory: "BTTS",
      selection: "Ja",
      selectionSide: "over",
    };
    expect(closingOddsFromMatchOdds(bet, odds, "Arsenal", "Chelsea")).toBe(1.75);
  });

  it("extracts totals over 2.5", () => {
    const bet: ClvBet = {
      ...baseBet,
      market: "totals",
      marketCategory: "Totalt",
      selection: "Över 2.5",
      selectionSide: "over",
      line: 2.5,
    };
    expect(closingOddsFromMatchOdds(bet, odds, "Arsenal", "Chelsea")).toBe(1.95);
  });

  it("extracts corners under", () => {
    const bet: ClvBet = {
      ...baseBet,
      market: "other",
      marketCategory: "Hörnor",
      selection: "Under 9.5 hörnor",
      selectionSide: "under",
      line: 9.5,
    };
    expect(closingOddsFromMatchOdds(bet, odds, "Arsenal", "Chelsea")).toBe(2.0);
  });

  it("extracts asian handicap", () => {
    const bet: ClvBet = {
      ...baseBet,
      market: "spreads",
      marketCategory: "Handikapp",
      selection: "Arsenal -0.5",
      selectionSide: "home",
      line: -0.5,
    };
    expect(closingOddsFromMatchOdds(bet, odds, "Arsenal", "Chelsea")).toBe(2.05);
  });
});

describe("closingOddsFromPlayerProps", () => {
  const props = {
    match_id: "mt_1",
    home_team: { id: "tm_1", name: "Arsenal" },
    away_team: { id: "tm_2", name: "Chelsea" },
    kickoff_at: "2026-07-10T15:00:00.000Z",
    bookmaker: "bet365",
    markets: [
      {
        name: "player_shots" as const,
        players: [
          {
            id: "pl_1",
            name: "Bukayo Saka",
            line: 1.5,
            market_type: "Over" as const,
            odd: 1.72,
          },
        ],
      },
      {
        name: "anytime_goalscorer" as const,
        players: [
          {
            id: "pl_2",
            name: "Mohamed Salah",
            line: 0.5,
            market_type: "Over" as const,
            odd: 2.5,
          },
        ],
      },
    ],
  };

  it("matches player shots over", () => {
    const bet: ClvBet = {
      ...baseBet,
      market: "other",
      marketScope: "player",
      marketCategory: "Skott",
      selection: "Bukayo Saka Över 1.5 skott",
      selectionSide: "over",
      line: 1.5,
    };
    expect(closingOddsFromPlayerProps(bet, props)).toBe(1.72);
  });

  it("matches anytime goalscorer", () => {
    const bet: ClvBet = {
      ...baseBet,
      market: "other",
      marketScope: "player",
      marketCategory: "Mål",
      selection: "Mohamed Salah målgörare",
      selectionSide: null,
    };
    expect(closingOddsFromPlayerProps(bet, props)).toBe(2.5);
  });
});

describe("extractClosingOdds", () => {
  it("delegates to bookmaker markets", () => {
    const bk = {
      bookmaker: "Bet365",
      markets: {
        match_odds: {
          away: { opening: "3.00", last_seen: "2.80" },
        },
      },
    };
    const bet: ClvBet = { ...baseBet, selectionSide: "away", selection: "Chelsea" };
    expect(extractClosingOdds(bet, bk, "Arsenal", "Chelsea")).toBe(2.8);
  });
});
