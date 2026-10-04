import { describe, it, expect } from "vitest";
import {
  buildRounds,
  normalizeRaw,
  normGrenadeType,
  normReason,
  normSide,
  sampleTicksFor,
  roundIndexer,
} from "../lib/cs2/demo/parseDemo";
import { analyzeDemo, buyType, halfOf, inferReason, zoneOf, siteOfPlace } from "../lib/cs2/demo/analyze";
import { addToGrid, placeAt, prettyPlace, cellKey } from "../lib/cs2/demo/places";
import { editDistance, linkPlayers, linkTeams, nameScore } from "../lib/cs2/demo/link";
import { detectArchive } from "../lib/cs2/demo/archive";
import { buildDemoQueue, type QueueMapRow } from "../lib/cs2/demo/queue";
import { deriveRoles, type RoleInput } from "../lib/cs2/roles";
import { WINNERS, buildEvents, buildRaw, roundTicks } from "./helpers/cs2Synthetic";

// ---------------------------------------------------------------------------

describe("normalisering", () => {
  it("läser sidor, orsaker och granattyper i flera format", () => {
    expect(normSide(3)).toBe("ct");
    expect(normSide("TERRORIST")).toBe("t");
    expect(normSide("CT")).toBe("ct");
    expect(normSide(1)).toBeNull();
    expect(normReason("bomb_defused")).toBe("bomb_defused");
    expect(normReason("t_killed")).toBe("elimination");
    expect(normReason("target_saved")).toBe("time");
    expect(normReason(7)).toBe("unknown");
    expect(normGrenadeType("CSmokeGrenadeProjectile")).toBe("smoke");
    expect(normGrenadeType("Incendiary Grenade")).toBe("molotov");
    expect(normGrenadeType("HE Grenade")).toBe("he");
    expect(normGrenadeType("Flashbang")).toBe("flash");
  });

  it("bygger rundor och kastar uppvärmning och knivrunda", () => {
    const rounds = buildRounds(buildEvents());
    expect(rounds).toHaveLength(13);
    expect(rounds[0]).toMatchObject({ n: 1, winner: "t", freezeEndTick: roundTicks(1).freezeEnd });
    // Runda 13: B vinner och spelar CT i andra halvlek.
    expect(rounds[12].winner).toBe("ct");
    // Med känt slutresultat behålls bara de sista rundorna.
    expect(buildRounds(buildEvents(), 10)).toHaveLength(10);
  });

  it("tilldelar ticks till rätt runda", () => {
    const rounds = buildRounds(buildEvents());
    const of = roundIndexer(rounds);
    expect(of(roundTicks(1).start + 10)).toBe(1);
    expect(of(roundTicks(2).freezeEnd)).toBe(2);
    expect(of(500)).toBeNull();
  });

  it("normaliserar hela demon utan saknade fält", () => {
    const d = normalizeRaw(buildRaw());
    expect(d.mapName).toBe("mirage");
    expect(d.rounds).toHaveLength(13);
    expect(d.players).toHaveLength(10);
    expect(d.sides[1].a1).toBe("ct");
    expect(d.sides[13].a1).toBe("t");
    expect(d.kills.length).toBeGreaterThan(50);
    expect(d.grenades).toEqual([
      expect.objectContaining({ round: 1, type: "smoke", thrower: "b2", x: 100, y: 100 }),
    ]);
    expect(d.timeouts).toEqual([{ round: 5, side: "t" }]);
    expect(d.utilityDamage).toEqual([{ round: 1, attacker: "b3", damage: 40 }]);
    expect(d.bombs.find((b) => b.round === 1)).toMatchObject({ kind: "planted", site: "A" });
    expect(d.missingFields).toEqual([]);
  });

  it("rapporterar fält som saknas i stället för att gissa", () => {
    const raw = buildRaw();
    raw.samples = raw.samples.map(({ last_place_name, ...rest }) => (void last_place_name, rest));
    expect(normalizeRaw(raw).missingFields).toContain("ticks.last_place_name");
  });
});

describe("analys", () => {
  const demo = normalizeRaw(buildRaw());
  const grid = addToGrid({}, demo.gridSamples);
  const a = analyzeDemo(demo, (x, y, z) => placeAt(grid, x, y, z));

  it("delar in lagen efter första rundan", () => {
    expect(a.teamOf.a1).toBe("A");
    expect(a.teamOf.b5).toBe("B");
    expect(a.teams.A.ct.rounds).toHaveLength(12);
    expect(a.teams.A.t.rounds).toHaveLength(1);
    expect(a.teams.B.t.rounds).toHaveLength(12);
    expect(a.roundWinners.map((r) => r.team).join("")).toBe(WINNERS.join(""));
  });

  it("klassar ekonomi, pistol och köprundor", () => {
    const aCt = a.teams.A.ct.rounds;
    expect(aCt[0]).toMatchObject({ n: 1, pistol: true, buy: "pistol", won: false });
    expect(aCt[1]).toMatchObject({ n: 2, buy: "eco", oppBuy: "force", afterLostPistol: true, won: true });
    expect(a.teams.B.t.rounds[1].afterLostPistol).toBe(false);
    expect(aCt[2]).toMatchObject({ n: 3, buy: "full", buyIndex: 1 });
    expect(aCt[3]).toMatchObject({ n: 4, buyIndex: 2 });
    expect(a.teams.A.t.rounds[0]).toMatchObject({ n: 13, pistol: true, half: 1 });
  });

  it("härleder rundslut, bomb och poängläge", () => {
    const r1 = a.teams.B.t.rounds[0];
    expect(r1).toMatchObject({ won: true, plantSite: "A", reason: "elimination", scoreBefore: [0, 0] });
    const r2 = a.teams.A.ct.rounds[1];
    expect(r2.scoreBefore).toEqual([0, 1]);
    expect(r2.lossStreakBefore).toBe(1);
  });

  it("ser timeouten och rundan efter", () => {
    expect(a.teams.B.t.rounds[4]).toMatchObject({ n: 5, afterTimeout: true });
    expect(a.teams.A.ct.rounds[4]).toMatchObject({ n: 5, afterTimeout: false, oppTimeout: true });
  });

  it("läser setup, zoner, AWP och lurker", () => {
    const r3 = a.teams.A.ct.rounds[2];
    expect(r3.setup).toBe("BombsiteA×2 BombsiteB×2 Connector");
    expect(r3.zones).toBe("A2-M1-B2");
    expect(r3.awpers).toEqual(["a1"]);
    expect(a.teams.B.t.rounds[2].lurker).toBe("b5");
  });

  it("namnger granatens landningsplats via rutnätet", () => {
    expect(a.teams.B.t.rounds[0].utility).toEqual([{ type: "smoke", place: "Window", sec: 3, thrower: "b2" }]);
  });

  it("räknar spelarfakta: kills, öppningar, multi, clutch och AWP", () => {
    const ct = (id: string) => a.players.find((p) => p.steamId === id && p.side === "ct")!.facts;
    const a5 = ct("a5");
    // Sist vid liv i varje förlorad CT-runda (1, 4, 8, 11) + clutchen i runda 7.
    expect(a5.clutchAttempts).toBe(5);
    expect(a5.clutchWins).toBe(1);
    expect(a5.multi[3]).toBeGreaterThanOrEqual(1); // 5k i clutchrundan
    const total = Object.values(a.killTotals).reduce((s, n) => s + n, 0);
    expect(total).toBe(demo.kills.length);
    const awpKiller = a.players.find((p) => p.facts.awpKills > 0)!;
    expect(awpKiller.facts.awpEarlyKills).toBe(1);
    const sumOpen = a.players.reduce((s, p) => s + p.facts.openingKills, 0);
    expect(sumOpen).toBe(13);
    // Kills i vunna + förlorade rundor = alla kills.
    for (const p of a.players) expect(p.facts.killsWon + p.facts.killsLost).toBe(p.facts.kills);
    expect(ct("a1").awpRounds).toBe(12);
    expect(ct("a4").siteRounds).toBeGreaterThan(0);
  });

  it("buyType, halvlekar och zoner", () => {
    expect(buyType(4000, false)).toBe("eco");
    expect(buyType(15000, false)).toBe("force");
    expect(buyType(25000, false)).toBe("full");
    expect(buyType(25000, true)).toBe("pistol");
    expect([halfOf(1), halfOf(12), halfOf(13), halfOf(24), halfOf(25), halfOf(28)]).toEqual([0, 0, 1, 1, 2, 3]);
    expect(siteOfPlace("BombsiteB")).toBe("B");
    expect(zoneOf("Ramp", 0, 0, { A: [100, 0], B: [5000, 0] })).toBe("A");
    expect(zoneOf("Middle", 2500, 0, { A: [0, 0], B: [5000, 0] })).toBe("M");
    expect(
      inferReason({ n: 1, startTick: 0, freezeEndTick: 0, endTick: 0, winner: "ct", reason: "unknown" }, false, false, { ct: 3, t: 2 })
    ).toBe("time");
  });
});

describe("callout-rutnät", () => {
  it("väljer vanligaste callout och hittar närmaste cell", () => {
    const g = addToGrid({}, [
      [0, 0, 0, "Window"],
      [10, 10, 0, "Window"],
      [20, 20, 0, "Jungle"],
    ]);
    expect(g[cellKey(0, 0, 0)]).toEqual(["Window", 3]);
    expect(placeAt(g, 30, 30, 0)).toBe("Window");
    expect(placeAt(g, 96 * 2, 0, 0)).toBe("Window");
    expect(placeAt(g, 96 * 40, 0, 0)).toBeNull();
    // Sammanslagning behåller stödet.
    const g2 = addToGrid(g, [[5, 5, 0, "Jungle"]]);
    expect(g2[cellKey(0, 0, 0)][1]).toBe(4);
  });
  it("gör callouts läsbara", () => {
    expect(prettyPlace("TopofMid")).toBe("Top of Mid");
    expect(prettyPlace("BombsiteA")).toBe("A-site");
    expect(prettyPlace("CTSpawn")).toBe("CTSpawn");
    expect(prettyPlace(null)).toBe("okänt");
  });
});

describe("länkning demo → HLTV", () => {
  const lineup = [
    { playerId: 1, nickname: "ZywOo", teamId: 10 },
    { playerId: 2, nickname: "ropz", teamId: 10 },
    { playerId: 3, nickname: "broky", teamId: 20 },
  ];
  it("matchar nick med taggar och små stavfel", () => {
    expect(nameScore("Vitality | ZywOo", "ZywOo")).toBe(1);
    expect(nameScore("zyw0o", "ZywOo")).toBe(3);
    expect(nameScore("someoneelse", "ZywOo")).toBeNull();
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
  it("länkar spelare och lag, och kända länkar vinner", () => {
    const links = linkPlayers(
      [
        { steamId: "s1", name: "Vitality ZywOo" },
        { steamId: "s2", name: "ropz" },
        { steamId: "s3", name: "whoever" },
      ],
      lineup,
      new Map([["s3", 3]])
    );
    expect(links.get("s1")?.playerId).toBe(1);
    expect(links.get("s2")?.playerId).toBe(2);
    expect(links.get("s3")?.playerId).toBe(3);
    const teams = linkTeams({ s1: "A", s2: "A", s3: "B" }, links, new Map(), [
      { id: 10, name: "Vitality" },
      { id: 20, name: "FaZe" },
    ]);
    expect(teams).toEqual({ A: 10, B: 20 });
  });
  it("faller tillbaka på lagnamnet i demon", () => {
    const teams = linkTeams({ x: "A", y: "B" }, new Map(), new Map([["x", "Vitality"], ["y", null]]), [
      { id: 10, name: "Vitality" },
      { id: 20, name: "FaZe" },
    ]);
    expect(teams).toEqual({ A: 10, B: 20 });
  });
});

describe("arkiv och kö", () => {
  it("känner igen arkivformat på magic bytes", () => {
    expect(detectArchive(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a]))).toBe("rar");
    expect(detectArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(detectArchive(new Uint8Array([0x1f, 0x8b]))).toBe("gzip");
    expect(detectArchive(new Uint8Array(Buffer.from("PBDEMS2\0")))).toBe("dem");
    expect(detectArchive(new Uint8Array([1, 2, 3]))).toBe("unknown");
  });

  it("väljer K senaste kartor per lag och karta, prioriterar kommande matcher", () => {
    const d = (day: number) => new Date(Date.UTC(2026, 8, day));
    const row = (mapId: number, matchId: number, mapName: string, day: number, t1: number, t2: number, parsed = false): QueueMapRow => ({
      mapId,
      matchId,
      mapName,
      playedAt: d(day),
      team1Id: t1,
      team2Id: t2,
      demoParsedAt: parsed ? d(day) : null,
      demoUrl: `/download/demo/${matchId}`,
      demoStatus: "none",
    });
    const rows = [
      row(1, 100, "mirage", 20, 1, 2),
      row(2, 101, "mirage", 18, 1, 3),
      row(3, 102, "mirage", 10, 1, 4), // tredje Mirage för lag 1 — utanför K=2
      row(4, 103, "nuke", 19, 5, 6),
      row(5, 104, "nuke", 15, 1, 6, true), // redan tolkad
    ];
    const q = buildDemoQueue(rows, { teams: [1, 5], priorityTeams: new Set([5]), perTeamMap: 2, since: d(1) });
    expect(q.map((s) => s.matchId)).toEqual([103, 100, 101]);
    expect(q[0].priority).toBe(true);
  });
});

describe("roller", () => {
  const p = (playerId: number, o: Partial<{ awp: number; open: number; lurk: number; site: number; flash: number }>): RoleInput => ({
    playerId,
    teamId: 1,
    ct: { rounds: 50, awpRounds: o.awp ?? 0, siteRounds: o.site ?? 0, util: { smoke: 0, flash: o.flash ?? 0, molotov: 0, he: 0, decoy: 0 }, flashAssists: 0, openingAttempts: 0 },
    t: { rounds: 50, awpRounds: o.awp ?? 0, lurkRounds: o.lurk ?? 0, util: { smoke: 0, flash: o.flash ?? 0, molotov: 0, he: 0, decoy: 0 }, flashAssists: 0, openingAttempts: o.open ?? 0 },
  });
  it("delar ut en roll per spelare inom laget", () => {
    const roles = deriveRoles([p(1, { awp: 45 }), p(2, { open: 15 }), p(3, { lurk: 20 }), p(4, { site: 35 }), p(5, { flash: 60 })]);
    expect(Object.fromEntries(roles)).toEqual({ 1: "awper", 2: "entry", 3: "lurker", 4: "anchor", 5: "support" });
  });
  it("hoppar över spelare med för få rundor", () => {
    const thin = { ...p(9, { awp: 10 }), ct: { ...p(9, {}).ct, rounds: 5 }, t: { ...p(9, {}).t, rounds: 5 } };
    expect(deriveRoles([thin]).size).toBe(0);
  });
});
