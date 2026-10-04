import { describe, it, expect } from "vitest";
import { calibrationBuckets, runBacktest, type BacktestMap } from "../lib/cs2/backtest";
import { overResult, projectionActual, summarizeFacit, type FacitRow } from "../lib/cs2/settle";
import type { RoundOutcome } from "../lib/cs2/types";

// ---- avräkning ----

const hist = (team1WinsPistol: boolean): RoundOutcome[] => [
  { n: 1, winner: team1WinsPistol ? "team1" : "team2", side: "ct", reason: "elimination" },
  { n: 2, winner: "team1", side: "ct", reason: "elimination" },
];

const MATCH = {
  status: "finished",
  team1Id: 10,
  team2Id: 20,
  winnerId: 10,
  maps: [
    {
      mapNumber: 1,
      team1Id: 10,
      team1Rounds: 13,
      team2Rounds: 9,
      winnerId: 10,
      roundHistory: hist(true),
      stats: [
        { playerId: 1, side: "all", kills: 20, headshots: 9 },
        { playerId: 1, side: "ct", kills: 11, headshots: 5 },
      ],
      firstKillTeam: 20,
      firstKillPlayer: 2,
    },
    {
      // Kartans team1 är matchens team2 — sidorna får inte blandas ihop.
      mapNumber: 2,
      team1Id: 20,
      team1Rounds: 13,
      team2Rounds: 11,
      winnerId: 20,
      roundHistory: hist(false),
      stats: [{ playerId: 1, side: "all", kills: 17, headshots: null }],
    },
    {
      mapNumber: 3,
      team1Id: 10,
      team1Rounds: 13,
      team2Rounds: 4,
      winnerId: 10,
      roundHistory: [],
      stats: [{ playerId: 1, side: "all", kills: 15, headshots: 8 }],
    },
  ],
};

const proj = (market: string, scope: string, extra: Partial<{ playerId: number; teamId: number; line: number }> = {}) => ({
  market,
  scope,
  playerId: extra.playerId ?? null,
  teamId: extra.teamId ?? null,
  line: extra.line ?? null,
});

describe("projectionActual", () => {
  it("väntar tills matchen är spelad", () => {
    expect(projectionActual(proj("kills", "map1", { playerId: 1 }), { ...MATCH, status: "live" })).toBeUndefined();
  });

  it("summerar kills över karta 1–2 ur HLTV:s all-rad", () => {
    expect(projectionActual(proj("kills", "map1", { playerId: 1 }), MATCH)).toBe(20);
    expect(projectionActual(proj("kills", "maps12", { playerId: 1 }), MATCH)).toBe(37);
  });

  it("lämnar headshots oavgjorda när HLTV saknar siffran", () => {
    expect(projectionActual(proj("headshots", "map1", { playerId: 1 }), MATCH)).toBe(9);
    expect(projectionActual(proj("headshots", "maps12", { playerId: 1 }), MATCH)).toBeUndefined();
  });

  it("karta 3 som aldrig spelades är void", () => {
    const twoMaps = { ...MATCH, maps: MATCH.maps.slice(0, 2) };
    expect(projectionActual(proj("rounds", "map3"), twoMaps)).toBeNull();
    expect(projectionActual(proj("total_maps", "match"), twoMaps)).toBe(2);
  });

  it("rundor, handikapp och vinnare räknas från rätt lag", () => {
    expect(projectionActual(proj("rounds", "map2"), MATCH)).toBe(24);
    // Lag 10 på karta 2 (där det är kartans team2): 11–13 med +1,5 → +0,5.
    expect(projectionActual(proj("map_handicap", "map2", { teamId: 10, line: 1.5 }), MATCH)).toBe(-2 + 1.5);
    expect(projectionActual(proj("map_winner", "map2", { teamId: 10 }), MATCH)).toBe(0);
    expect(projectionActual(proj("map_winner", "map2", { teamId: 20 }), MATCH)).toBe(1);
    expect(projectionActual(proj("match_winner", "match"), MATCH)).toBe(1);
    expect(projectionActual(proj("match_handicap", "match", { teamId: 10, line: -1.5 }), MATCH)).toBe(1 - 1.5);
  });

  it("pistol och första kill", () => {
    expect(projectionActual(proj("pistol", "map1", { teamId: 10 }), MATCH)).toBe(1);
    // Karta 2: kartans team2 (= lag 10) vann pistolen.
    expect(projectionActual(proj("pistol", "map2", { teamId: 10 }), MATCH)).toBe(1);
    expect(projectionActual(proj("first_kill", "map1", { teamId: 10 }), MATCH)).toBe(0);
    expect(projectionActual(proj("player_first_kill", "map1", { playerId: 2 }), MATCH)).toBe(1);
    expect(projectionActual(proj("first_kill", "map2", { teamId: 10 }), MATCH)).toBeUndefined();
  });
});

describe("overResult", () => {
  it("totaler mot linjen, med push", () => {
    expect(overResult("kills", 19.5, 20)).toBe(1);
    expect(overResult("kills", 20, 20)).toBe(0.5);
    expect(overResult("rounds", 21.5, 21)).toBe(0);
  });
  it("handikapp mot noll, binära marknader som de är", () => {
    expect(overResult("map_handicap", -1.5, 0.5)).toBe(1);
    expect(overResult("match_handicap", 0, 0)).toBe(0.5);
    expect(overResult("match_winner", null, 0)).toBe(0);
    expect(overResult("pistol", null, 1)).toBe(1);
  });
});

describe("summarizeFacit", () => {
  const row = (r: Partial<FacitRow>): FacitRow => ({
    market: "kills",
    line: 19.5,
    actual: 20,
    pModel: 0.6,
    pMarket: 0.5,
    pFinal: 0.55,
    bestSide: "over",
    bestOdds: 2.0,
    edgePct: 5,
    ...r,
  });

  it("plattspel räknar vinst, förlust och push", () => {
    const s = summarizeFacit([
      row({}), // över vinner: +1
      row({ actual: 18 }), // över förlorar: −1
      row({ line: 20, actual: 20 }), // push: 0
      row({ bestSide: "under", actual: 18, bestOdds: 1.8 }), // under vinner: +0,8
      row({ edgePct: -2 }), // inget spel
    ]);
    expect(s.settled).toBe(5);
    expect(s.flat.bets).toBe(4);
    expect(s.flat.units).toBeCloseTo(0.8, 10);
    expect(s.flat.hitRate).toBeCloseTo(2 / 4, 10);
    expect(s.byMarket).toEqual([{ market: "kills", n: 5, flatBets: 4, units: expect.closeTo(0.8, 10) }]);
  });

  it("log-loss mot boken hoppar över push och linjer utan bokpris", () => {
    const s = summarizeFacit([
      row({ pModel: 0.8, pMarket: 0.5 }), // y = 1
      row({ actual: 18, pModel: 0.3, pMarket: 0.5 }), // y = 0
      row({ line: 20, actual: 20 }), // push — räknas inte
      row({ pMarket: null }), // ingen bok — räknas inte
    ]);
    expect(s.vsMarket!.n).toBe(2);
    expect(s.vsMarket!.model).toBeCloseTo((-Math.log(0.8) - Math.log(0.7)) / 2, 10);
    expect(s.vsMarket!.market).toBeCloseTo(Math.log(2), 10);
  });

  it("inga linjer ger tomt facit", () => {
    const s = summarizeFacit([]);
    expect(s.vsMarket).toBeNull();
    expect(s.flat.roi).toBeNull();
  });
});

// ---- backtest ----

describe("calibrationBuckets", () => {
  it("lägger p = 1 i sista hinken och hoppar över tomma", () => {
    const b = calibrationBuckets([
      { p: 0.05, y: 0 },
      { p: 0.07, y: 1 },
      { p: 0.95, y: 1 },
      { p: 1, y: 1 },
    ]);
    expect(b.map((x) => x.n)).toEqual([2, 2]);
    expect(b[0].predicted).toBeCloseTo(0.06, 10);
    expect(b[0].observed).toBe(0.5);
    expect(b[1].to).toBe(1);
  });
});

/** Liten deterministisk liga: sex lag med känd styrka, rundvis simulerade kartor. */
function simulateLeague(nMaps: number): BacktestMap[] {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const strength: Record<number, number> = { 1: 0.5, 2: 0.3, 3: 0.1, 4: -0.1, 5: -0.3, 6: -0.5 };
  const start = Date.UTC(2026, 0, 1);
  const maps: BacktestMap[] = [];
  for (let i = 0; i < nMaps; i++) {
    const t1 = 1 + Math.floor(rnd() * 6);
    let t2 = 1 + Math.floor(rnd() * 5);
    if (t2 >= t1) t2++;
    const t1StartsCt = rnd() < 0.5;
    let r1 = 0,
      r2 = 0,
      target = 13;
    const side = { t1Ct: 0, t1T: 0, t2Ct: 0, t2T: 0 };
    const roundHistory: RoundOutcome[] = [];
    const kills = new Map<number, number>();
    for (let n = 1; ; n++) {
      const t1Ct = n <= 12 ? t1StartsCt : n <= 24 ? !t1StartsCt : n % 2 === 0;
      const p1 = sig(strength[t1] - strength[t2] + (t1Ct ? 0.1 : -0.1));
      const t1Won = rnd() < p1;
      if (t1Won) r1++;
      else r2++;
      if (n <= 24) {
        if (t1Won) side[t1Ct ? "t1Ct" : "t1T"]++;
        else side[t1Ct ? "t2T" : "t2Ct"]++;
      }
      roundHistory.push({ n, winner: t1Won ? "team1" : "team2", side: t1Won === t1Ct ? "ct" : "t", reason: "elimination" });
      for (let k = 0; k < 10; k++) {
        const onT1 = k < 5;
        const pid = (onT1 ? t1 : t2) * 10 + (k % 5);
        if (rnd() < (onT1 === t1Won ? 0.75 : 0.4)) kills.set(pid, (kills.get(pid) ?? 0) + 1);
      }
      if (r1 === target - 1 && r2 === target - 1) target += 3;
      if (r1 >= target || r2 >= target) break;
    }
    maps.push({
      id: i + 1,
      mapName: "mirage",
      playedAt: new Date(start + i * 6 * 3_600_000),
      team1Id: t1,
      team2Id: t2,
      team1Rounds: r1,
      team2Rounds: r2,
      team1CtRounds: side.t1Ct,
      team1TRounds: side.t1T,
      team2CtRounds: side.t2Ct,
      team2TRounds: side.t2T,
      roundHistory,
      players: [t1, t2].flatMap((team) =>
        Array.from({ length: 5 }, (_, k) => ({ playerId: team * 10 + k, teamId: team, kills: kills.get(team * 10 + k) ?? 0, headshots: null }))
      ),
    });
  }
  return maps;
}

describe("runBacktest", () => {
  const maps = simulateLeague(360);
  const s = runBacktest(maps, { warmupMaps: 120 });

  it("mäter bara kartor efter uppvärmningen", () => {
    expect(s.maps).toBe(240);
    expect(s.mapWinner.n).toBe(240);
    expect(s.from).toBe(maps[120].playedAt.toISOString());
    expect(s.mapWinner.calibration.reduce((a, b) => a + b.n, 0)).toBe(240);
    // Tio spelare per karta, alla med historik efter uppvärmningen.
    expect(s.kills.n).toBe(2400);
  });

  it("slår myntkast när lagen har verklig styrkeskillnad", () => {
    expect(s.mapWinner.logLoss).toBeLessThan(s.mapWinner.baselineLogLoss);
    expect(s.mapWinner.accuracy).toBeGreaterThan(0.6);
    expect(s.notes.some((n) => n.includes("myntkast"))).toBe(false);
  });

  it("ger rimliga fel för rundor och kills", () => {
    expect(Math.abs(s.rounds.meanError)).toBeLessThan(2);
    expect(Math.abs(s.kills.meanError)).toBeLessThan(2);
    expect(s.kills.overRate).toBeGreaterThan(0.3);
    expect(s.kills.overRate).toBeLessThan(0.7);
  });

  it("varnar för litet underlag", () => {
    const small = runBacktest(maps.slice(0, 140), { warmupMaps: 120 });
    expect(small.notes.some((n) => n.includes("för lite"))).toBe(true);
  });
});
