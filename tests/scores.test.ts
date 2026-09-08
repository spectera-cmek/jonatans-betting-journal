import { describe, it, expect, vi, afterEach } from "vitest";
import { espnPath, teamMatches, fetchFinalScore } from "../lib/scores";

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

describe("fetchFinalScore scoreboard cache", () => {
  const finished = {
    events: [
      {
        id: "401",
        status: { type: { completed: true, name: "STATUS_FINAL", detail: "Final" } },
        competitions: [
          {
            competitors: [
              { homeAway: "home", score: "2", team: { displayName: "Arsenal" } },
              { homeAway: "away", score: "1", team: { displayName: "Chelsea" } },
            ],
          },
        ],
      },
    ],
  };
  const kickoff = new Date("2026-03-14T19:00:00Z");

  function stubFetch(payload: unknown) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => payload } as unknown as Response;
    });
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("reads the score off the event day", async () => {
    const calls = stubFetch(finished);
    expect(await fetchFinalScore("soccer/eng.1", kickoff, "Arsenal", "Chelsea")).toEqual({
      homeScore: 2,
      awayScore: 1,
      wentToExtraTime: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("serves a repeat lookup of the same league-day from the cache", async () => {
    const calls = stubFetch(finished);
    const cache = new Map();
    await fetchFinalScore("soccer/eng.1", kickoff, "Arsenal", "Chelsea", null, cache);
    await fetchFinalScore("soccer/eng.1", kickoff, "Arsenal", "Chelsea", null, cache);
    expect(calls).toHaveLength(1);
  });

  it("re-fetches when no cache is passed", async () => {
    const calls = stubFetch(finished);
    await fetchFinalScore("soccer/eng.1", kickoff, "Arsenal", "Chelsea");
    await fetchFinalScore("soccer/eng.1", kickoff, "Arsenal", "Chelsea");
    expect(calls).toHaveLength(2);
  });

  it("caches misses too, so an unmatched bet costs three fetches once", async () => {
    const calls = stubFetch({ events: [] });
    const cache = new Map();
    expect(await fetchFinalScore("soccer/eng.1", kickoff, "Arsenal", "Chelsea", null, cache)).toBeNull();
    expect(calls).toHaveLength(3); // event day, day after, day before
    await fetchFinalScore("soccer/eng.1", kickoff, "Arsenal", "Chelsea", null, cache);
    expect(calls).toHaveLength(3);
  });
});
