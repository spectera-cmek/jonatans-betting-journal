import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CACHE_VERSION, historyCacheFile, planRefresh, readCache, syncCache, writeCache, type CachedGame } from "../lib/nba/historyCache";

const game = (id: number, version: string): CachedGame => ({
  id,
  version,
  startAt: "2026-11-01T00:00:00.000Z",
  periods: 4,
  homeTeamId: 1,
  awayTeamId: 2,
  hasBox: true,
  team: [],
  players: [],
  stints: null,
});

const dirs: string[] = [];
const tmpFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nba-cache-"));
  dirs.push(d);
  return path.join(d, "history.json");
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.VERCEL;
});

describe("NBA-historikens cache", () => {
  it("hämtar nya och ändrade matcher, släpper borttagna", () => {
    expect(
      planRefresh(new Map([[1, "a"], [2, "b"], [3, "c"]]), [
        { id: 1, version: "a" },
        { id: 2, version: "B" },
        { id: 4, version: "d" },
      ])
    ).toEqual({ fetch: [2, 4], drop: [3] });
  });

  it("saknad, trasig eller gammal cachefil ger en tom cache", () => {
    const f = tmpFile();
    expect(readCache(f).size).toBe(0);
    fs.writeFileSync(f, "{trasig");
    expect(readCache(f).size).toBe(0);
    fs.writeFileSync(f, JSON.stringify({ version: CACHE_VERSION - 1, games: [game(1, "a")] }));
    expect(readCache(f).size).toBe(0);
  });

  it("det som skrivs läses tillbaka oförändrat", () => {
    const f = tmpFile();
    const games = new Map([[1, game(1, "a")], [7, { ...game(7, "b"), stints: [{ homeIds: [1], awayIds: [2], homePts: 3, awayPts: 0, poss: 2 }] }]]);
    writeCache(f, games);
    expect(readCache(f)).toEqual(games);
    expect(fs.readdirSync(path.dirname(f))).toEqual(["history.json"]);
  });

  it("en omsparad match ersätter sina rader och bara den hämtas igen", async () => {
    const f = tmpFile();
    const games = [
      { id: 1, updatedAt: new Date("2026-11-02T00:00:00Z"), startAt: new Date("2026-11-01T00:00:00Z"), periods: 4, homeTeamId: 1, awayTeamId: 2, boxFetchedAt: new Date() },
      { id: 2, updatedAt: new Date("2026-11-03T00:00:00Z"), startAt: new Date("2026-11-02T00:00:00Z"), periods: 4, homeTeamId: 3, awayTeamId: 4, boxFetchedAt: new Date() },
    ];
    const asked: number[][] = [];
    const db = {
      $disconnect: async () => {},
      nbaGame: { findMany: async () => games },
      nbaTeamGame: { findMany: async ({ where }: any) => (asked.push(where.gameId.in), where.gameId.in.map((gameId: number) => ({ gameId, teamId: 9 }))) },
      nbaPlayerGame: { findMany: async ({ where }: any) => where.gameId.in.map((gameId: number) => ({ gameId, playerId: 5 })) },
      nbaStint: { findMany: async ({ where }: any) => where.gameId.in.map((gameId: number) => ({ gameId, homeIds: [], awayIds: [], homePts: 1, awayPts: 0, poss: 1 })) },
    } as any;
    const since = new Date("2026-10-01T00:00:00Z");
    await syncCache(db, since, { withStints: true, file: f });
    games[1] = { ...games[1], updatedAt: new Date("2026-11-04T00:00:00Z") };
    const out = await syncCache(db, since, { withStints: true, file: f });
    expect(asked).toEqual([[1, 2], [2]]);
    expect(out.map((g) => [g.id, g.team.length, g.players.length, g.stints?.length])).toEqual([
      [1, 1, 1, 1],
      [2, 1, 1, 1],
    ]);
  });

  it("används inte på Vercel", () => {
    expect(historyCacheFile()).toBe(path.join(".cache", "nba", "history.json"));
    process.env.VERCEL = "1";
    expect(historyCacheFile()).toBeNull();
  });
});
