import { describe, it, expect } from "vitest";
import {
  applyWindow,
  playerMapProfiles,
  sumFacts,
  teamMapPool,
  toTeamMapRow,
  topCounts,
  type MapRowInput,
  type PlayerStatInput,
} from "../lib/cs2/profiles";
import { buildGameplan, SECTION_KEYS, type GameplanInput } from "../lib/cs2/gameplan";
import { normalizeRaw } from "../lib/cs2/demo/parseDemo";
import { analyzeDemo } from "../lib/cs2/demo/analyze";
import { addToGrid, placeAt } from "../lib/cs2/demo/places";
import type { RoundOutcome } from "../lib/cs2/types";
import { buildRaw } from "./helpers/cs2Synthetic";

const d = (day: number) => new Date(Date.UTC(2026, 8, day));

function mapRow(o: Partial<MapRowInput> & { id: number }): MapRowInput {
  return {
    matchId: 1,
    mapName: "mirage",
    playedAt: d(20),
    pickedById: null,
    team1Id: 10,
    team2Id: 20,
    team1Rounds: 13,
    team2Rounds: 9,
    team1StartSide: "ct",
    team1CtRounds: 8,
    team1TRounds: 5,
    team2CtRounds: 7,
    team2TRounds: 4,
    otRounds: 0,
    winnerId: 10,
    roundHistory: null,
    ...o,
  };
}

describe("lagets perspektiv på en karta", () => {
  it("speglar resultat, sidor och pick för team2", () => {
    const hist: RoundOutcome[] = [
      { n: 1, winner: "team2", side: "t", reason: "bomb_exploded" },
      { n: 2, winner: "team1", side: "ct", reason: "elimination" },
      { n: 13, winner: "team1", side: "t", reason: "elimination" },
    ];
    const r = toTeamMapRow(mapRow({ id: 1, pickedById: 20, roundHistory: hist }), 20)!;
    expect(r).toMatchObject({
      opponentId: 10,
      roundsFor: 9,
      roundsAgainst: 13,
      won: false,
      ctWon: 7,
      tWon: 4,
      ctLost: 5, // team1 vann 5 på T när team2 var CT
      tLost: 8,
      startSide: "t",
      pick: "own",
      pistolsWon: 1,
      pistolsPlayed: 2,
    });
    expect(r.rounds![0]).toEqual({ n: 1, won: true, side: "t" });
    expect(r.rounds![1]).toEqual({ n: 2, won: false, side: "t" });
    expect(toTeamMapRow(mapRow({ id: 1 }), 99)).toBeNull();
  });

  it("väljer senaste N kartor inom M månader", () => {
    const now = d(30);
    const rows = [{ playedAt: d(29) }, { playedAt: d(1) }, { playedAt: d(25) }, { playedAt: new Date(Date.UTC(2025, 0, 1)) }];
    expect(applyWindow(rows, { maps: 2, months: 6 }, now)).toEqual([{ playedAt: d(29) }, { playedAt: d(25) }]);
  });
});

describe("kartpool", () => {
  it("räknar vinst, sidor, OT, pistol och vetobeteende", () => {
    const rows = [
      toTeamMapRow(mapRow({ id: 1, matchId: 1, pickedById: 10 }), 10)!,
      toTeamMapRow(mapRow({ id: 2, matchId: 2, winnerId: 20, team1Rounds: 15, team2Rounds: 13, otRounds: 4 }), 10)!,
      toTeamMapRow(mapRow({ id: 3, matchId: 3, mapName: "nuke" }), 10)!,
    ];
    const vetoes = [
      { matchId: 1, step: 1, teamId: 10, action: "ban", mapName: "anubis", at: d(20) },
      { matchId: 2, step: 2, teamId: 10, action: "ban", mapName: "anubis", at: d(20) },
      { matchId: 2, step: 3, teamId: 10, action: "pick", mapName: "mirage", at: d(20) },
      { matchId: 2, step: 1, teamId: 20, action: "ban", mapName: "nuke", at: d(20) },
    ];
    const pool = teamMapPool(rows, vetoes, 10, 6, d(30));
    const mirage = pool.find((p) => p.mapName === "mirage")!;
    expect(mirage).toMatchObject({ played: 2, wins: 1, winRate: 0.5, otRate: 0.5, picks: 1, bans: 0 });
    expect(mirage.ctRoundRate).toBeCloseTo(16 / (16 + 8));
    expect(mirage.avgRounds).toBe(25);
    const anubis = pool.find((p) => p.mapName === "anubis")!;
    expect(anubis).toMatchObject({ played: 0, bans: 2, firstBans: 2, firstBanRate: 1, winRate: null });
  });
});

describe("spelarprofiler", () => {
  const row = (mapName: string, side: string, kills: number, rounds: number, hs: number | null = null): PlayerStatInput => ({
    mapId: 1,
    mapName,
    playedAt: d(20),
    teamId: 10,
    opponentId: 20,
    side,
    kills,
    deaths: 15,
    headshots: hs,
    adr: 80,
    rating: 1.1,
    kast: 70,
    rounds,
  });
  it("räknar KPR totalt och per sida, och HS-andel", () => {
    const p = playerMapProfiles([row("mirage", "all", 20, 22, 10), row("mirage", "ct", 12, 12), row("mirage", "t", 8, 10), row("nuke", "all", 15, 25, 5)]);
    const mirage = p.find((x) => x.mapName === "mirage")!;
    expect(mirage.kpr).toBeCloseTo(20 / 22);
    expect(mirage.ctKpr).toBeCloseTo(1);
    expect(mirage.tKpr).toBeCloseTo(0.8);
    expect(mirage.hsPct).toBeCloseTo(0.5);
    const all = p.find((x) => x.mapName === "all")!;
    expect(all.maps).toBe(2);
    expect(all.kpr).toBeCloseTo(35 / 47);
    expect(p[0].mapName).toBe("all");
  });

  it("summerar demofakta fält för fält", () => {
    const s = sumFacts([
      { v: 1, kills: 3, multi: [1, 0, 0, 0], rk: [1, 2], places: { A: 2 } },
      { v: 1, kills: 4, multi: [0, 1, 0, 0], rk: [3], places: { A: 1, B: 4 } },
    ]);
    expect(s).toEqual({ v: 1, kills: 7, multi: [1, 1, 0, 0], rk: [1, 2, 3], places: { A: 3, B: 4 } });
    expect(sumFacts([])).toBeNull();
    expect(topCounts({ A: 1, B: 3, C: 2 }, 2)).toEqual([
      { key: "B", count: 3, share: 0.5 },
      { key: "C", count: 2, share: 1 / 3 },
    ]);
  });
});

describe("gameplan-rapporten", () => {
  const demo = normalizeRaw(buildRaw());
  const grid = addToGrid({}, demo.gridSamples);
  const a = analyzeDemo(demo, (x, y, z) => placeAt(grid, x, y, z));
  const players = ["a1", "a2", "a3", "a4", "a5"].map((id) => ({
    playerId: null,
    steamIds: [id],
    nickname: id.toUpperCase(),
    role: id === "a1" ? "awper" : null,
    facts: a.players.find((p) => p.steamId === id && p.side === "ct")!.facts,
  }));
  const input: GameplanInput = {
    teamId: 10,
    teamName: "Team A",
    mapName: "mirage",
    side: "ct",
    months: 6,
    maps: [toTeamMapRow(mapRow({ id: 1 }), 10)!],
    rounds: a.teams.A.ct.rounds.map((r) => ({ ...r, mapId: 1 })),
    players,
    nick: (id) => (id ? id.toUpperCase() : "?"),
    teamNames: new Map([[20, "Team B"]]),
  };
  const report = buildGameplan(input);

  it("har docens alla sektioner i docens ordning", () => {
    expect(report.sections.map((s) => s.key)).toEqual([...SECTION_KEYS]);
    expect(report.sections[0].title).toBe("POSITIONS");
    expect(report.sections.find((s) => s.key === "lowbuys")!.title).toBe("LOWBUYS (when losing pistol)");
    expect(report.sample).toMatchObject({ maps: 1, demoMaps: 1, rounds: 12 });
  });

  it("fyller POSITIONS med AWP och spots", () => {
    const pos = report.sections.find((s) => s.key === "positions")!;
    expect(pos.items[0].label).toBe("AWP");
    expect(pos.items[0].value).toContain("A1");
    expect(pos.items[0].value).toContain("A-site");
    expect(pos.items.map((i) => i.label)).toEqual(["AWP", "SPOT 1", "SPOT 2", "SPOT 3", "SPOT 4"]);
  });

  it("fyller LOWBUYS, ANTIECO och % SETUPS ur rundorna", () => {
    const low = report.sections.find((s) => s.key === "lowbuys")!;
    expect(low.items.find((i) => i.label === "Köp")!.value).toBe("eco 100 %");
    expect(low.items.find((i) => i.label === "Vann rundan")!.value).toBe("100 % (1/1)");
    const setups = report.sections.find((s) => s.key === "setups")!;
    expect(setups.items[0]).toMatchObject({ label: "A2-M1-B2", value: "100 %" });
    const focus = report.sections.find((s) => s.key === "focus")!;
    expect(focus.items).toHaveLength(5);
    expect(focus.items[0].detail!.length).toBeGreaterThanOrEqual(5);
  });

  it("visar senaste kartan och SAMPLE SIZE", () => {
    const last = report.sections.find((s) => s.key === "last")!;
    expect(last.items[0].label).toContain("vs Team B");
    expect(last.items[0].value).toContain("13–9 vinst");
    const sample = report.sections.find((s) => s.key === "sample")!;
    expect(sample.items[0].value).toBe("1 (varav 1 med tolkad demo)");
  });

  it("tom indata ger förklaringar i stället för fel", () => {
    const empty = buildGameplan({ ...input, rounds: [], players: [], maps: [] });
    expect(empty.sections.find((s) => s.key === "positions")!.empty).toBeTruthy();
    expect(empty.sections.find((s) => s.key === "last")!.empty).toBeTruthy();
    expect(empty.sample.maps).toBe(0);
  });
});
