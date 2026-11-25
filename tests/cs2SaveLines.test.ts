import { describe, it, expect } from "vitest";
import { saveLines, type Cs2Writer } from "../lib/cs2/lineStore";
import type { ValidLine } from "../lib/cs2/lineInput";
import { mapDistribution, type MapInputs } from "../lib/cs2/mapModel";
import { knownVeto, seriesProbs } from "../lib/cs2/veto";
import { killRates, DEFAULT_LEAGUE_PRIOR } from "../lib/cs2/killModel";
import { openingRates } from "../lib/cs2/openingModel";
import type { MatchupContext } from "../lib/cs2/matchup";

// En match utan databas, samma uppbyggnad som i cs2Models.test.ts.
function testCtx(): MatchupContext {
  const even: MapInputs = { pCtA: 0.53, pCtB: 0.53, pistolCtA: 0.5, pistolCtB: 0.5, conv2: 0.8, conv3: 0.7, pAStartsCt: 0.5, sigma: 0.3 };
  const pool = ["nuke", "mirage", "inferno"];
  const dists = Object.fromEntries(pool.map((m) => [m, mapDistribution({ ...even, pCtA: 0.58, pCtB: 0.48 })]));
  const veto = knownVeto(pool, pool);
  const rates = killRates({ demo: {}, hltv: {} }, DEFAULT_LEAGUE_PRIOR, pool);
  const neutral = openingRates([], []);
  return {
    match: { id: 1, startAt: new Date("2026-11-25T06:00:00Z"), status: "scheduled", eventName: "Test", lan: true },
    team1: { id: 10, name: "Alpha", rank: 1, tracked: true },
    team2: { id: 20, name: "Beta", rank: 9, tracked: true },
    format: "bo3",
    pool,
    veto,
    vetoKnown: true,
    vetoManual: false,
    dists,
    series: seriesProbs("bo3", veto, (m) => dists[m].pAWin),
    pistolCt1: 0.55,
    pistolCt2: 0.5,
    opening: { team1: neutral, team2: neutral },
    players: [10, 20].flatMap((teamId, ti) =>
      [1, 2, 3, 4, 5].map((n) => ({
        playerId: teamId * 10 + n,
        nickname: `p${teamId * 10 + n}`,
        teamId,
        side: (ti === 0 ? 1 : 2) as 1 | 2,
        role: null,
        rates,
        kprByMap: {},
        kprAll: 0.7,
        mapsAll: 20,
        mapsForTeam: 20,
        demoMaps: 0,
        awpRounds: 0,
        awpEarlyKills: 0,
        openingShare: null,
        openingRounds: 0,
        boardMaps: [],
      }))
    ),
    spread: 0.8,
    lineupChanges: [],
    lineupKnown: false,
    fives: {},
    global: {
      ratings: { mapBias: {}, ct: {}, t: {}, pistolBias: 0, pistol: {}, team1Bias: 0, conv2: 0.8, conv3: 0.7, rounds: {} },
      concession: {},
      league: DEFAULT_LEAGUE_PRIOR,
      leagueRounds: 21.5,
      trainedMaps: 100,
      key: "x",
      at: 0,
    },
    teamAngles: [],
    oppTeams: {},
    warnings: [],
  };
}

// Låtsasdatabas som räknar anropen. Varje anrop mot Neon tar ~100 ms från
// datorn, och hela sparandet ligger i en transaktion med 30 s gräns.
function fakeWriter(opts: { reverse?: boolean } = {}) {
  const calls = { line: 0, projection: 0 };
  const lines: Array<Record<string, unknown> & { id: number }> = [];
  const projections: Array<Record<string, unknown>> = [];
  const db = {
    cs2Line: {
      async create({ data }: { data: Record<string, unknown> }) {
        calls.line++;
        const row = { ...data, id: 100 + lines.length, createdAt: new Date() };
        lines.push(row);
        return row;
      },
      async createManyAndReturn({ data }: { data: Array<Record<string, unknown>> }) {
        calls.line++;
        const out = data.map((d, i) => ({ ...d, id: 100 + lines.length + i, createdAt: new Date() }));
        lines.push(...out);
        return opts.reverse ? [...out].reverse() : out;
      },
    },
    cs2Projection: {
      async create({ data }: { data: Record<string, unknown> }) {
        calls.projection++;
        projections.push(data);
        return data;
      },
      async createMany({ data }: { data: Array<Record<string, unknown>> }) {
        calls.projection++;
        projections.push(...data);
        return { count: data.length };
      },
    },
  };
  return { db: db as unknown as Cs2Writer, calls, lines, projections };
}

/** Unibets kills-stege: fem linjer per spelare, tio spelare, karta 1 och 2 — 100 linjer. */
function ladder(): ValidLine[] {
  const out: ValidLine[] = [];
  for (const scope of ["map1", "map2"] as const)
    for (const playerId of [101, 102, 103, 104, 105, 201, 202, 203, 204, 205])
      for (const line of [11.5, 12.5, 13.5, 14.5, 15.5])
        out.push({
          matchId: 1, market: "kills", scope, playerId, player2Id: null, teamId: null,
          line, overOdds: 1.85, underOdds: 1.9, includesOt: true, bookmaker: "Unibet", source: "kambi",
        });
  return out;
}

describe("sparande av linjer", () => {
  it("många linjer sparas med två anrop, inte två per linje", async () => {
    const { db, calls, lines, projections } = fakeWriter();
    const input = [...ladder(), ...ladder()];
    const out = await saveLines(db, testCtx(), input, "auto");
    expect(lines).toHaveLength(200);
    expect(calls).toEqual({ line: 1, projection: 1 });
    expect(projections).toHaveLength(out.filter((p) => p.price).length);
    expect(projections.length).toBeGreaterThan(0);
  });

  it("varje modellpris hamnar på sin egen linje", async () => {
    const { db, lines, projections } = fakeWriter();
    const out = await saveLines(db, testCtx(), ladder(), "auto");
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const p of projections) {
      const l = byId.get(p.lineId as number)!;
      expect([p.playerId, p.scope, p.line]).toEqual([l.playerId, l.scope, l.line]);
    }
    expect(out.map((p) => p.id)).toEqual(lines.map((l) => l.id));
    expect(lines.every((l) => l.createdBy === "auto")).toBe(true);
  });

  it("ingen linje, inget anrop", async () => {
    const { db, calls } = fakeWriter();
    expect(await saveLines(db, testCtx(), [], "auto")).toEqual([]);
    expect(calls).toEqual({ line: 0, projection: 0 });
  });

  it("kommer raderna tillbaka i annan ordning sparas inga modellpriser på fel linje", async () => {
    const { db, projections } = fakeWriter({ reverse: true });
    await expect(saveLines(db, testCtx(), ladder(), "auto")).rejects.toThrow();
    expect(projections).toHaveLength(0);
  });
});
