import { describe, it, expect } from "vitest";
import { matchPlayer, matchTeam, matchTeams, skipReason } from "../lib/cs2/propsMatch";

const TEAMS = [
  { id: 4608, name: "Natus Vincere" },
  { id: 6667, name: "FaZe" },
];

describe("lag ur bokens skärmdump", () => {
  it("klarar Team-/Esports-prefix, alias och stavning", () => {
    expect(matchTeam("Team Vitality", [{ id: 1, name: "Vitality" }])).toBe(1);
    expect(matchTeam("Falcons", [{ id: 2, name: "Team Falcons" }])).toBe(2);
    expect(matchTeam("NAVI", TEAMS)).toBe(4608);
    expect(matchTeam("FaZe Clan", TEAMS)).toBe(6667);
    expect(matchTeam("G2 Esports", [{ id: 5995, name: "G2" }])).toBe(5995);
    expect(matchTeam("Astralis", TEAMS)).toBeNull();
  });

  it("det okända namnet blir motståndaren när det andra känns igen", () => {
    const m = matchTeams(["Spirit", "BetBoom Team", "Spirit"], [
      { id: 7020, name: "Spirit" },
      { id: 12345, name: "BETBOOM" },
    ]);
    expect(m.get("Spirit")).toBe(7020);
    expect(m.get("BetBoom Team")).toBe(12345);
    // Två okända namn gissas inte.
    expect(matchTeams(["A", "B"], TEAMS).size).toBe(0);
  });

  it("spelare matchas på nick", () => {
    const players = [
      { id: 11893, nickname: "ZywOo" },
      { id: 7998, nickname: "ropz" },
    ];
    expect(matchPlayer("zywoo", players)).toBe(11893);
    expect(matchPlayer("Vitality.ZywOo", players)).toBe(11893);
    expect(matchPlayer("s1mple", players)).toBeNull();
  });
});

describe("vilka rader som sparas", () => {
  const base = { playerId: null, teamId: null, line: null, overOdds: 1.9, underOdds: 1.9 };
  it("spelar- och lagmarknader kräver spelare respektive lag", () => {
    expect(skipReason({ ...base, market: "kills", line: 34.5 })).toBe("spelaren hittades inte i trupperna");
    expect(skipReason({ ...base, market: "kills", line: 34.5, playerId: 1 })).toBeNull();
    expect(skipReason({ ...base, market: "match_winner" })).toBe("laget kändes inte igen");
    expect(skipReason({ ...base, market: "match_winner", teamId: 1 })).toBeNull();
  });
  it("totaler och handikapp kräver linje, allt kräver odds", () => {
    expect(skipReason({ ...base, market: "rounds" })).toBe("linje saknas");
    expect(skipReason({ ...base, market: "total_maps", line: 2.5 })).toBeNull();
    expect(skipReason({ ...base, market: "map_handicap", teamId: 1 })).toBe("linje saknas");
    expect(skipReason({ ...base, market: "rounds", line: 21.5, overOdds: null, underOdds: null })).toBe("odds saknas");
    expect(skipReason({ ...base, market: "other" })).toBe("marknaden finns inte i modellen");
  });
});
