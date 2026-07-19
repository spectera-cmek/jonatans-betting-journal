import { describe, it, expect } from "vitest";
import {
  inferSportKey,
  parseHomeAway,
  teamNameMatches,
  matchOddsEvent,
} from "../lib/eventLink";
import type { OddsEvent } from "../lib/oddsApi";

describe("inferSportKey", () => {
  it("maps known leagues", () => {
    expect(inferSportKey("Football", "Premier League")).toBe("soccer_epl");
    expect(inferSportKey("Baseball", "MLB")).toBe("baseball_mlb");
    expect(inferSportKey("Ice Hockey", "NHL")).toBe("icehockey_nhl");
  });
  it("falls back to sport-only keys", () => {
    expect(inferSportKey("Basketball", null)).toBe("basketball_nba");
  });
  it("maps MMA and tennis", () => {
    expect(inferSportKey("MMA", "UFC")).toBe("mma_mixed_martial_arts");
    expect(inferSportKey("Tennis", "ATP")).toBe("tennis_atp");
    expect(inferSportKey("Tennis", "WTA")).toBe("tennis_wta");
  });
  it("returns null for unknown sports", () => {
    expect(inferSportKey("Darts", null)).toBeNull();
  });
});

describe("parseHomeAway", () => {
  it("parses @ as away @ home", () => {
    expect(parseHomeAway("PHI Phillies @ CIN Reds")).toEqual({
      home: "CIN Reds",
      away: "PHI Phillies",
    });
  });
  it("parses vs as home vs away", () => {
    expect(parseHomeAway("Arsenal vs Chelsea")).toEqual({
      home: "Arsenal",
      away: "Chelsea",
    });
  });
});

describe("teamNameMatches", () => {
  it("matches nicknames", () => {
    expect(teamNameMatches("SA Spurs", "San Antonio Spurs")).toBe(true);
    expect(teamNameMatches("Lakers", "Los Angeles Lakers")).toBe(true);
  });
  it("rejects unrelated teams", () => {
    expect(teamNameMatches("Arsenal", "Chelsea")).toBe(false);
  });
});

describe("matchOddsEvent", () => {
  const events: OddsEvent[] = [
    {
      id: "ev1",
      sport_key: "baseball_mlb",
      sport_title: "MLB",
      commence_time: "2026-07-14T23:10:00Z",
      home_team: "Cincinnati Reds",
      away_team: "Philadelphia Phillies",
      bookmakers: [],
    },
  ];

  it("matches by team names and date", () => {
    const bet = {
      event: "CIN Reds vs PHI Phillies",
      homeTeam: "CIN Reds",
      awayTeam: "PHI Phillies",
      eventAt: new Date("2026-07-14T20:00:00Z"),
    };
    expect(matchOddsEvent(bet, events)?.id).toBe("ev1");
  });

  it("returns null when teams do not match", () => {
    const bet = {
      event: "Arsenal vs Chelsea",
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      eventAt: new Date("2026-07-14T20:00:00Z"),
    };
    expect(matchOddsEvent(bet, events)).toBeNull();
  });
});
