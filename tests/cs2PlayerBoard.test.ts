import { describe, it, expect } from "vitest";
import {
  buildCard,
  hitStats,
  leanOf,
  rankTier,
  samplesFor,
  signalStrength,
  boardKey,
  type BoardMap,
  type BoardPlayer,
  type PlayerBoardData,
} from "../lib/cs2/playerBoard";

let mapId = 1;
const map = (o: Partial<BoardMap> & { matchId: number; mapNumber: number; kills: number; day: number }): BoardMap => ({
  mapId: mapId++,
  mapName: "inferno",
  oppId: 900,
  won: 13,
  lost: 10,
  // Som i databasen: seriens kartor har seriens starttid.
  playedAt: new Date(Date.UTC(2026, 10, o.day, 12)).toISOString(),
  ...o,
});

const team1 = { id: 1, name: "HEROIC", rank: 12 };
const team2 = { id: 2, name: "M80", rank: 25 };

function data(players: BoardPlayer[], extra: Partial<PlayerBoardData> = {}): PlayerBoardData {
  return {
    scopes: ["map1", "map2", "map3", "maps12"],
    team1,
    team2,
    teams: { 1: team1, 2: team2, 900: { id: 900, name: "Övriga", rank: 22 }, 901: { id: 901, name: "Topplag", rank: 3 } },
    mapWeights: { map1: [{ map: "inferno", w: 0.6 }, { map: "nuke", w: 0.4 }], map2: [{ map: "nuke", w: 0.7 }, { map: "inferno", w: 0.3 }] },
    players,
    lines: {},
    model: {},
    ...extra,
  };
}

const player = (maps: BoardMap[], side: 1 | 2 = 1): BoardPlayer => ({ playerId: 7, nickname: "nilo", teamId: side === 1 ? 1 : 2, side, role: null, maps });

describe("samplesFor", () => {
  const maps = [
    map({ matchId: 10, mapNumber: 1, kills: 20, day: 1 }),
    map({ matchId: 10, mapNumber: 2, kills: 15, day: 1, mapName: "nuke" }),
    map({ matchId: 10, mapNumber: 3, kills: 9, day: 1 }),
    map({ matchId: 11, mapNumber: 1, kills: 12, day: 5 }),
  ];
  it("kartlinjer: varje karta är ett utfall, nyast först", () => {
    const s = samplesFor(maps, "map1");
    expect(s.map((x) => x.kills)).toEqual([12, 9, 15, 20]);
    expect(s[0]).toMatchObject({ rounds: 23, score: "13–10", maps: ["inferno"], won: true });
  });
  it("karta 1–2: summan av seriens två första kartor; serier utan karta 2 räknas inte", () => {
    const s = samplesFor(maps, "maps12");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kills: 35, rounds: 46, maps: ["inferno", "nuke"], score: "13–10, 13–10", matchId: 10 });
  });
});

describe("hitStats och lean", () => {
  const s = samplesFor(
    [10, 12, 17, 18, 19, 20, 16].map((k, i) => map({ matchId: 100 + i, mapNumber: 1, kills: k, day: i + 1 })),
    "map1"
  );
  it("räknar över/under och snitt mot en halvlinje", () => {
    expect(hitStats(s, 15.5)).toEqual({ n: 7, over: 5, under: 2, push: 0, avg: 16 });
  });
  it("en heltalslinje ger push som inte räknas åt något håll", () => {
    const h = hitStats(s, 16);
    expect(h).toMatchObject({ over: 4, under: 2, push: 1 });
    expect(leanOf(h)).toBe("over");
  });
  it("för få utfall pekar inte", () => {
    expect(leanOf(hitStats(s.slice(0, 3), 9.5))).toBe("thin");
  });
  it("jämnt fördelat pekar inte heller", () => {
    expect(leanOf(hitStats(s, 17.5))).toBe("even");
  });
});

describe("rankTier", () => {
  it("delar in efter nuvarande rank", () => {
    expect(rankTier(3).key).toBe("t10");
    expect(rankTier(12).label).toBe("rank 11–20");
    expect(rankTier(50).key).toBe("t50");
    expect(rankTier(51).key).toBe("rest");
    expect(rankTier(null).key).toBe("rest");
  });
});

describe("buildCard", () => {
  // Tio kartor, 8 över 15,5. Inferno på jämna index, Nuke på udda. De två
  // första kartorna är mot M80 (lag 2): 18 och 19, båda över.
  const maps: BoardMap[] = [];
  const kills = [18, 19, 14, 20, 17, 13, 21, 16, 22, 17];
  kills.forEach((k, i) =>
    maps.push(map({ matchId: 200 + i, mapNumber: 1, kills: k, day: i + 1, mapName: i % 2 === 0 ? "inferno" : "nuke", oppId: i < 2 ? 2 : 900 }))
  );
  const p = player(maps);

  it("utan bokens linje används modellens median", () => {
    const d = data([p], { model: { [boardKey(7, "map1")]: { mean: 16.2, median: 15.5, lines: [{ line: 15.5, pOver: 0.52 }] } } });
    const c = buildCard(d, p, "map1");
    expect(c.line).toBe(15.5);
    expect(c.lineFrom).toBe("model");
    expect(c.model.pOver).toBe(0.52);
    expect(c.form.stats).toMatchObject({ n: 10, over: 8, under: 2 });
    expect(c.form.lean).toBe("over");
    // Grafen läses äldst → senast.
    expect(c.form.samples.map((s) => s.kills)).toEqual(kills);
  });

  it("bokens sparade linje går före modellen, och en inskriven linje före båda", () => {
    const d = data([p], {
      lines: { [boardKey(7, "map1")]: { line: 17.5, overOdds: 1.85, underOdds: 1.95, bookmaker: "Unibet", source: "kambi", createdAt: null } },
      model: { [boardKey(7, "map1")]: { mean: 16.2, median: 15.5, lines: [] } },
    });
    expect(buildCard(d, p, "map1").lineFrom).toBe("book");
    expect(buildCard(d, p, "map1").line).toBe(17.5);
    const typed = buildCard(d, p, "map1", 19.5);
    expect(typed).toMatchObject({ line: 19.5, lineFrom: "typed" });
    expect(typed.model.pOver).toBeNull();
  });

  it("kartan: kartorna som troligen spelas, viktade med vetot", () => {
    const c = buildCard(data([p]), p, "map1", 15.5);
    expect(c.map.rows.map((r) => [r.map, r.w])).toEqual([
      ["inferno", 0.6],
      ["nuke", 0.4],
    ]);
    const inferno = c.map.rows[0].stats;
    expect(inferno).toMatchObject({ n: 5, over: 4, under: 1 });
    // Inferno 18, 14, 17, 21, 22 och Nuke 19, 20, 13, 16, 17: båda 4 av 5 över → 0,8.
    expect(c.map.rate).toBeCloseTo(0.8, 6);
    expect(c.map.lean).toBe("over");
  });

  it("motståndet: tidigare möten med just det laget, och lag på samma nivå", () => {
    const c = buildCard(data([p]), p, "map1", 15.5);
    expect(c.h2h.opponent.name).toBe("M80");
    expect(c.h2h.stats).toMatchObject({ n: 2, over: 2 });
    expect(c.h2h.lean).toBe("thin");
    // M80 är rank 25 → 21–30; "Övriga" (22) ligger där, M80 själva också.
    expect(c.tier.label).toBe("rank 21–30");
    expect(c.tier.stats.n).toBe(10);
  });

  it("signalen räknar underlagen som pekar, inte de tunna", () => {
    const c = buildCard(data([p]), p, "map1", 15.5);
    expect(c.signal).toEqual({ over: 3, under: 0, counted: 3 });
    const hard = buildCard(data([p]), p, "map1", 21.5);
    expect(hard.signal.under).toBeGreaterThanOrEqual(2);
    expect(signalStrength(c)).toBeGreaterThan(signalStrength(buildCard(data([p]), p, "map1", 17.5)));
  });

  it("karta 1–2: förväntade kills ur snittet på de troliga kartorna", () => {
    const series: BoardMap[] = [];
    for (let i = 0; i < 5; i++) {
      series.push(map({ matchId: 300 + i, mapNumber: 1, kills: 20, day: i + 1, mapName: "inferno" }));
      series.push(map({ matchId: 300 + i, mapNumber: 2, kills: 14, day: i + 1, mapName: "nuke" }));
    }
    const q = player(series);
    const c = buildCard(data([q]), q, "maps12", 30.5);
    expect(c.form.stats).toMatchObject({ n: 5, over: 5 });
    // Karta 1: 0,6·20 + 0,4·14 = 17,6. Karta 2: 0,7·14 + 0,3·20 = 15,8. Summa 33,4.
    expect(c.map.expected).toBeCloseTo(33.4, 6);
    expect(c.map.lean).toBe("over");
  });

  it("lag 2:s spelare möter lag 1", () => {
    const q = player([map({ matchId: 1, mapNumber: 1, kills: 10, day: 1, oppId: 1 })], 2);
    const c = buildCard(data([q]), q, "map1", 15.5);
    expect(c.h2h.opponent.id).toBe(1);
    expect(c.h2h.stats.n).toBe(1);
    expect(c.tier.label).toBe("rank 11–20");
  });
});

describe("boardLines", () => {
  it("din egen boks linje går före Unibets, även om Unibets är nyare; annars nyast", async () => {
    const { boardLines } = await import("../lib/cs2/matchup");
    const l = (o: object) => ({ market: "kills" as const, scope: "map1" as const, playerId: 7, line: 15.5, ...o });
    const out = boardLines([
      l({ line: 16.5, source: "kambi", bookmaker: "Unibet", createdAt: "2026-11-24T10:00:00Z" }),
      l({ line: 15.5, source: "manual", bookmaker: "Spelklubben", createdAt: "2026-11-23T10:00:00Z", overOdds: 1.8 }),
      l({ line: 14.5, source: "manual", bookmaker: "Coolbet", createdAt: "2026-11-22T10:00:00Z" }),
      l({ scope: "map2", line: 17.5, source: "kambi", bookmaker: "Unibet", createdAt: "2026-11-24T10:00:00Z" }),
      l({ market: "headshots", line: 8.5, source: "manual" }),
      l({ scope: "match", line: 40.5, source: "manual" }),
    ]);
    expect(Object.keys(out).sort()).toEqual(["7|map1", "7|map2"]);
    expect(out["7|map1"]).toMatchObject({ line: 15.5, bookmaker: "Spelklubben", overOdds: 1.8 });
    expect(out["7|map2"]).toMatchObject({ line: 17.5, bookmaker: "Unibet" });
  });

  it("av Unibets stege används huvudlinjen, den med jämnast odds", async () => {
    const { boardLines } = await import("../lib/cs2/matchup");
    const k = (line: number, o: number, u: number) => ({ market: "kills" as const, scope: "map1" as const, playerId: 7, line, overOdds: o, underOdds: u, source: "kambi", bookmaker: "Unibet", createdAt: "2026-11-24T10:00:00Z" });
    const out = boardLines([k(10.5, 1.43, 2.55), k(13.5, 1.83, 1.93), k(14.5, 2.2, 1.6), k(16.5, 3.1, 1.3)]);
    expect(out["7|map1"]).toMatchObject({ line: 13.5, overOdds: 1.83 });
  });
});
