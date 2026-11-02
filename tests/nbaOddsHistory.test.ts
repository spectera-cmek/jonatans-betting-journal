import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import type { OpHistoricalOdds, OpMarket } from "../lib/oddspapi";

const fx = JSON.parse(fs.readFileSync("tests/fixtures/oddspapi-nba.json", "utf8")) as {
  markets: OpMarket[];
  history: OpHistoricalOdds;
};

// Historiken: fixture "missing" ger 404 som OddsPapi gör, "ok" ger fixturens historik.
vi.mock("../lib/oddspapi", async (orig) => {
  const real = await orig<typeof import("../lib/oddspapi")>();
  return {
    ...real,
    oddspapiBookmaker: () => "pinnacle",
    getHistoricalOdds: vi.fn(async (id: string) => {
      if (id === "missing") throw new real.OddspapiError(404, "NOT_FOUND", "OddsPapi /historical-odds (404 NOT_FOUND): No historical odds found.");
      if (id === "broken") throw new real.OddspapiError(401, "UNAUTHORIZED", "fel nyckel");
      return fx.history;
    }),
  };
});

vi.mock("../lib/oddspapi/markets", async (orig) => {
  const real = await orig<typeof import("../lib/oddspapi/markets")>();
  return { ...real, loadIds: () => ({ nba: { tournamentId: 132 }, basketballMarkets: real.buildMarketMap(fx.markets) }) };
});

const { captureHistoricalClosing } = await import("../lib/nba/oddspapiCapture");

function fakeDb(games: Array<{ id: number; oddspapiFixtureId: string }>) {
  const marked: number[] = [];
  const odds: unknown[] = [];
  let lastWhere: Record<string, unknown> = {};
  const db = {
    nbaGame: {
      findMany: async (q: { where: Record<string, unknown> }) => {
        lastWhere = q.where;
        return games.map((g) => ({ ...g, startAt: new Date("2026-03-01T00:30:00Z"), oddspapiP1Home: true }));
      },
      update: async (q: { where: { id: number } }) => marked.push(q.where.id),
    },
    nbaOdds: {
      deleteMany: async () => ({ count: 0 }),
      create: async (q: { data: unknown }) => odds.push(q.data),
    },
  };
  return { db: db as never, marked, odds, where: () => lastWhere };
}

describe("OddsPapi-historiken", () => {
  it("hoppar över matcher utan historik (404) och fortsätter med resten", async () => {
    const f = fakeDb([
      { id: 1, oddspapiFixtureId: "missing" },
      { id: 2, oddspapiFixtureId: "ok" },
    ]);
    const r = await captureHistoricalClosing(f.db, { from: new Date(0), to: new Date() });
    expect(r.games).toBe(2);
    expect(r.empty).toBe(1);
    expect(r.saved).toBeGreaterThan(0);
    expect(f.marked).toEqual([1]);
    // Tomma matcher frågas inte igen, om man inte ber om det.
    expect(f.where()).toHaveProperty("oddsHistoryEmptyAt", null);
    await captureHistoricalClosing(f.db, { from: new Date(0), to: new Date(), retryEmpty: true });
    expect(f.where()).not.toHaveProperty("oddsHistoryEmptyAt");
  });

  it("andra fel (t.ex. fel nyckel) stoppar körningen", async () => {
    const f = fakeDb([{ id: 3, oddspapiFixtureId: "broken" }]);
    await expect(captureHistoricalClosing(f.db, { from: new Date(0), to: new Date() })).rejects.toThrow("fel nyckel");
    expect(f.marked).toEqual([]);
  });
});
