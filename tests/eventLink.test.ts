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
  it("maps MMA", () => {
    expect(inferSportKey("MMA", "UFC")).toBe("mma_mixed_martial_arts");
  });
  // The Odds API har ingen "tennis_atp" — bara nycklar per turnering. Att hitta
  // på en gav 404 UNKNOWN_SPORT vid varje rättning och CLV-hämtning.
  it("returns null for tennis, which has no general sport key", () => {
    expect(inferSportKey("Tennis", "ATP")).toBeNull();
    expect(inferSportKey("Tennis", "WTA")).toBeNull();
    expect(inferSportKey("Tennis", null)).toBeNull();
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
  // Importerna skriver matcher så här; utan den här grenen fick de aldrig
  // hem-/bortalag och kunde alltså aldrig länkas för CLV.
  it("parses a spaced hyphen as home - away", () => {
    expect(parseHomeAway("Newcastle United - Liverpool")).toEqual({
      home: "Newcastle United",
      away: "Liverpool",
    });
  });
  it("leaves hyphenated team names intact", () => {
    expect(parseHomeAway("Saint-Étienne vs Lyon")).toEqual({
      home: "Saint-Étienne",
      away: "Lyon",
    });
    expect(parseHomeAway("Saint-Étienne")).toBeNull();
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
  // API:et skriver nordiska lagnamn utan diakriter. Tidigare föll å/ä/ö bort
  // helt och gjorde "Västerås SK" till "v ster s sk" — som aldrig matchade.
  it("folds diacritics the way the API writes them", () => {
    expect(teamNameMatches("Västerås SK", "Vasteras SK")).toBe(true);
    expect(teamNameMatches("Malmö FF", "Malmo FF")).toBe(true);
    expect(teamNameMatches("Bodø/Glimt", "Bodo Glimt")).toBe(true);
    expect(teamNameMatches("Djurgårdens IF", "Djurgardens IF")).toBe(true);
  });
  it("still rejects unrelated teams after folding", () => {
    expect(teamNameMatches("Västerås SK", "Malmo FF")).toBe(false);
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
