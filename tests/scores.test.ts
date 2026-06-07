import { describe, it, expect } from "vitest";
import { espnPath, teamMatches } from "../lib/scores";

describe("espnPath", () => {
  it("maps sport+league", () => {
    expect(espnPath("Basketball", "NBA")).toBe("basketball/nba");
    expect(espnPath("Ice Hockey", "NHL")).toBe("hockey/nhl");
    expect(espnPath("Football", "Premier League")).toBe("soccer/eng.1");
  });
  it("falls back to sport-only for single-league US sports", () => {
    expect(espnPath("Baseball", null)).toBe("baseball/mlb");
    expect(espnPath("American Football", "")).toBe("football/nfl");
  });
  it("returns null for unmappable sports", () => {
    expect(espnPath("Esports", null)).toBeNull();
    expect(espnPath("Football", "Some Obscure League")).toBeNull();
    expect(espnPath(null, null)).toBeNull();
  });
});

describe("teamMatches", () => {
  it("matches abbreviated bet365 names to ESPN full names via nickname", () => {
    expect(teamMatches("SA Spurs", { displayName: "San Antonio Spurs" })).toBe(true);
    expect(teamMatches("NY Knicks", { displayName: "New York Knicks" })).toBe(true);
  });
  it("matches exact and contained names", () => {
    expect(teamMatches("Arsenal", { displayName: "Arsenal" })).toBe(true);
    expect(teamMatches("Arsenal FC", { displayName: "Arsenal", shortDisplayName: "Arsenal" })).toBe(true);
  });
  it("rejects different teams", () => {
    expect(teamMatches("LA Lakers", { displayName: "Boston Celtics" })).toBe(false);
    expect(teamMatches("", { displayName: "Arsenal" })).toBe(false);
    expect(teamMatches("Arsenal", undefined)).toBe(false);
  });
});
