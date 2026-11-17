import { describe, it, expect } from "vitest";
import { extractPropSeries, firstOpen, mainRung, priceAt, snapshotAt, type HistEntry } from "../lib/nba/propsHistory";
import { reclassifyPropMarkets, type PropMarketSpec } from "../lib/oddspapi/markets";
import { buildHistory, type PlayerGameRow } from "../lib/nba/ratings";
import { preGameAverage, seedFromLiveLines, statMap, type PidAppearance } from "../lib/nba/propsMapping";
import type { OpHistoricalOdds } from "../lib/oddspapi";

const START = Date.parse("2026-02-01T00:00:00Z");
const at = (secBefore: number) => new Date(START - secBefore * 1000).toISOString();

// Katalogen som i ids.json: trepoängsstegen ligger som poäng — reclassify ska rätta.
const CATALOG: Record<string, PropMarketSpec> = {
  "111684": { stat: "pts", line: 7.5, sides: { "111684": 1, "111685": 2 }, name: "Over Under Player Points (incl. overtime)" },
  "111686": { stat: "pts", line: 8.5, sides: { "111686": 1, "111687": 2 }, name: "Over Under Player Points (incl. overtime)" },
  "111794": { stat: "pts", line: 1.5, sides: { "111794": 1, "111795": 2 }, name: "Over Under Player 3 Point FG (incl. overtime)" },
};

const hist = (players: Record<string, Record<string, Array<{ s: number; price: number; active?: boolean; limit?: number }>>>): OpHistoricalOdds => {
  const markets: Record<string, { outcomes: Record<string, { players: Record<string, unknown[]> }> }> = {};
  for (const [outcomeId, byPid] of Object.entries(players)) {
    const marketId = String(Number(outcomeId) - (Number(outcomeId) % 2 === 1 ? 1 : 0));
    const mk = (markets[marketId] ??= { outcomes: {} });
    mk.outcomes[outcomeId] = { players: Object.fromEntries(Object.entries(byPid).map(([pid, es]) => [pid, es.map((e) => ({ createdAt: at(e.s), price: e.price, active: e.active ?? true, limit: e.limit ?? null }))])) };
  }
  return { fixtureId: "x", bookmakers: { pinnacle: { markets } } } as unknown as OpHistoricalOdds;
};

describe("prop-historiken", () => {
  const h = hist({
    "111684": { "77": [{ s: 7200, price: 1.9, limit: 250 }, { s: 600, price: 1.8, limit: 1000 }] },
    "111685": { "77": [{ s: 7200, price: 1.9, limit: 250 }, { s: 600, price: 2.0, limit: 1000 }] },
    "111686": { "77": [{ s: 7200, price: 2.3 }, { s: 1800, price: 2.3, active: false }] },
    "111687": { "77": [{ s: 7200, price: 1.6 }, { s: 1800, price: 1.6, active: false }] },
    "111794": { "77": [{ s: 3600, price: 1.7 }] },
    "111795": { "77": [{ s: 3600, price: 2.1 }] },
  });
  const series = extractPropSeries(h, reclassifyPropMarkets(CATALOG), ["pinnacle"], START);

  it("trepoängsstegen blir fg3, inte poäng", () => {
    expect(Object.keys(series.pinnacle["77"].pts ?? {}).sort()).toEqual(["7.5", "8.5"]);
    expect(Object.keys(series.pinnacle["77"].fg3 ?? {})).toEqual(["1.5"]);
  });

  it("priset vid en tidpunkt: senaste händelsen, och stängd = inget pris", () => {
    const r = series.pinnacle["77"].pts!["7.5"];
    expect(priceAt(r.o, -3600)).toEqual({ price: 1.9, maxStake: 250 });
    expect(priceAt(r.o, -60)).toEqual({ price: 1.8, maxStake: 1000 });
    expect(priceAt(r.o, -8000)).toBeNull();
    const closed = series.pinnacle["77"].pts!["8.5"];
    expect(priceAt(closed.o, -3600)?.price).toBe(2.3);
    expect(priceAt(closed.o, -60)).toBeNull();
  });

  it("huvudlinjen är den jämnaste, ögonblicksbilden bara öppna steg", () => {
    const rungs = series.pinnacle["77"].pts!;
    expect(snapshotAt(rungs, -3600).map((q) => q.line)).toEqual([7.5, 8.5]);
    expect(mainRung(snapshotAt(rungs, -3600))?.line).toBe(7.5);
    expect(snapshotAt(rungs, -60).map((q) => q.line)).toEqual([7.5]);
    expect(firstOpen(rungs)).toBe(-7200);
  });

  it("serien börjar med tillståndet när fönstret öppnar", () => {
    const s = extractPropSeries(h, reclassifyPropMarkets(CATALOG), ["pinnacle"], START, 3600);
    const o = s.pinnacle["77"].pts!["7.5"].o as HistEntry[];
    expect(o[0]).toEqual([-3600, 1.9, 250, 1]);
    expect(o).toHaveLength(2);
  });
});

const row = (gameId: number, t: number, playerId: number, teamId: number, pts: number, minutes = 30): PlayerGameRow => ({
  gameId,
  t,
  playerId,
  teamId,
  position: "G",
  minutes,
  fga2: 0,
  fgm2: Math.floor(pts / 2),
  fga3: 0,
  fgm3: 0,
  fta: 0,
  ftm: pts % 2,
  oreb: 0,
  dreb: 5,
  ast: 3,
  tov: 0,
  dnp: minutes <= 0,
  dnpReason: null,
});

describe("koppling OddsPapi-id → ESPN", () => {
  // Två lagkamrater: A gör ~25 poäng, B ~10. Tio matcher historik, sedan fem med linjer.
  const DAY = 864e5;
  const rows: PlayerGameRow[] = [];
  for (let g = 0; g < 15; g++) {
    rows.push(row(g, START + g * DAY, 1, 10, 24 + (g % 3)), row(g, START + g * DAY, 2, 10, 9 + (g % 3)));
  }
  const h = buildHistory(rows, []);
  const apps = new Map<string, PidAppearance[]>();
  for (let g = 10; g < 15; g++) {
    const base = { gameId: g, t: START + g * DAY, homeTeamId: 10, awayTeamId: 20 };
    apps.set("A", [...(apps.get("A") ?? []), { ...base, lines: { pts: 24.5, reb: 4.5 } }]);
    apps.set("B", [...(apps.get("B") ?? []), { ...base, lines: { pts: 9.5, reb: 4.5 } }]);
  }

  it("snittet före matchen tar inte med matchen själv", () => {
    expect(preGameAverage(h, 1, START + 10 * DAY, "pts", 3)).toBeCloseTo((25 + 26 + 24) / 3);
  });

  it("kopplar efter linjernas nivå, och en seed låser spelaren", () => {
    const m = statMap(apps, h, new Map());
    expect(Object.fromEntries(m.map((x) => [x.pid, x.playerId]))).toEqual({ A: 1, B: 2 });
    const fixed = statMap(apps, h, new Map([["A", 1]]));
    expect(fixed.map((x) => [x.pid, x.playerId])).toEqual([["B", 2]]);
  });

  it("lämnar tvetydiga id okopplade", () => {
    const twins = buildHistory(
      rows.map((r) => ({ ...r, fgm2: 7, ftm: 1 })),
      []
    );
    expect(statMap(apps, twins, new Map())).toHaveLength(0);
  });

  it("seed: samma pris som historiken på samma linje och tid", () => {
    const sh = hist({ "111684": { "5": [{ s: 7200, price: 1.9 }], "6": [{ s: 7200, price: 2.05 }] }, "111685": { "5": [{ s: 7200, price: 1.9 }], "6": [{ s: 7200, price: 1.75 }] } });
    const series = new Map([[100, { startMs: START, books: extractPropSeries(sh, reclassifyPropMarkets(CATALOG), ["pinnacle"], START) }]]);
    const live = (playerId: number, over: number, under: number, s: number) => ({ gameId: 100, playerId, stat: "pts", line: 7.5, over, under, capturedAt: START - s * 1000 });
    const seeds = seedFromLiveLines([live(1, 1.9, 1.9, 3600), live(1, 1.9, 1.9, 1800), live(2, 2.05, 1.75, 3600)], series);
    expect(seeds.get("5")).toEqual({ playerId: 1, votes: 2 });
    // En röst räcker inte.
    expect(seeds.has("6")).toBe(false);
  });
});
