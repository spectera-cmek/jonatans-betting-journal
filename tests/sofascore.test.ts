import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sofaSportFor, utcDate } from "../lib/sofascore/api";
import { SofascoreBlockedError, SofascoreBudgetError, SofascoreClient, jsonFromBrowserPage } from "../lib/sofascore/client";
import {
  hasStatKey,
  mapStatus,
  parseEvents,
  parseLineups,
  parseSeasons,
  parseStatistics,
  playerPlayed,
  shotTotals,
} from "../lib/sofascore/parse";
import type { ScraplingRequest, ScraplingResponse, ScraplingWorker } from "../lib/scrapling";

const FIX = path.join(__dirname, "fixtures", "sofascore");
const load = (f: string) => JSON.parse(readFileSync(path.join(FIX, f), "utf8"));

describe("Sofascore-tolkarna", () => {
  it("events: status, lag, poäng efter ordinarie tid", () => {
    const { events, hasNextPage } = parseEvents(load("football-events.json"));
    expect(hasNextPage).toBe(true);
    expect(events).toHaveLength(3); // den trasiga raden hoppas över
    const [mff, cup, upcoming] = events;
    expect(mff).toMatchObject({
      id: 13981234,
      status: "finished",
      homeTeam: { id: 1714, name: "Malmö FF", shortName: "Malmö" },
      awayTeam: { id: 1735, name: "AIK" },
      homeScore: 2,
      awayScore: 1,
      uniqueTournamentId: 40,
      seasonId: 69956,
      round: 27,
    });
    expect(mff.startAt.toISOString()).toBe("2025-10-18T19:00:00.000Z");
    // Förlängning: ordinarie tid 2–2, slutresultat 3–2.
    expect(cup).toMatchObject({ homeScore: 2, awayScore: 2, homeScoreFinal: 3, awayScoreFinal: 2, statusDescription: "AET" });
    expect(upcoming).toMatchObject({ status: "scheduled", homeScore: null, awayScore: null });
  });

  it("event/{id} har `event` i stället för `events`", () => {
    const one = load("football-events.json").events[0];
    expect(parseEvents({ event: one }).events.map((e) => e.id)).toEqual([13981234]);
  });

  it("statusmappning", () => {
    expect(mapStatus("finished")).toBe("finished");
    expect(mapStatus("inprogress")).toBe("live");
    expect(mapStatus("canceled")).toBe("cancelled");
    expect(mapStatus("postponed")).toBe("postponed");
    expect(mapStatus("notstarted")).toBe("scheduled");
    expect(mapStatus(null)).toBe("scheduled");
  });

  it("säsonger", () => {
    expect(parseSeasons({ seasons: [{ id: 2, name: "Allsvenskan 2026", year: "2026" }, { id: 1, year: "2025" }, {}] })).toEqual([
      { id: 2, name: "Allsvenskan 2026", year: "2026" },
      { id: 1, name: "1", year: "2025" },
    ]);
  });

  it("lagstatistik: bara period ALL, första nyckeln vinner", () => {
    const stats = parseStatistics(load("football-statistics.json"));
    expect(stats.cornerKicks).toEqual({ home: 7, away: 4 }); // inte 1ST:s 3–1
    expect(stats.totalShotsOnGoal).toEqual({ home: 15, away: 9 });
    expect(stats.shotsOnGoal).toEqual({ home: 6, away: 3 });
    expect(shotTotals(stats)).toEqual({
      homeShots: 15,
      awayShots: 9,
      homeSot: 6,
      awaySot: 3,
      homeCorners: 7,
      awayCorners: 4,
      homeXg: 1.84,
      awayXg: 0.92,
      homePossession: 58,
      awayPossession: 42,
    });
  });

  it("tom statistik ger null-fält, inte ett fel", () => {
    expect(shotTotals(parseStatistics({})).homeShots).toBeNull();
    expect(shotTotals(parseStatistics(null)).awayCorners).toBeNull();
  });

  it("lineups: spelare per sida med platt numerisk statistik", () => {
    const l = parseLineups(load("football-lineups.json"));
    expect(l.confirmed).toBe(true);
    expect(l.players).toHaveLength(7);
    const kt = l.players.find((p) => p.playerId === 900002)!;
    expect(kt).toMatchObject({ side: "home", substitute: false, name: "Isaac Kiese Thelin" });
    expect(kt.stats.totalShots).toBe(4);
    expect(kt.stats).not.toHaveProperty("ratingVersions");
    expect(l.players.find((p) => p.playerId === 900102)!.side).toBe("away");
  });

  it("hasStatKey och playerPlayed", () => {
    const l = parseLineups(load("football-lineups.json"));
    expect(hasStatKey(l, "goalAssist")).toBe(true);
    expect(hasStatKey(l, "points")).toBe(false);
    const byId = (id: number) => l.players.find((p) => p.playerId === id)!;
    expect(playerPlayed(byId(900002))).toBe(true);
    expect(playerPlayed(byId(900004))).toBe(false); // avbytare utan statistik
    expect(playerPlayed(byId(900103))).toBe(true); // inhoppare

    const bb = parseLineups(load("basketball-lineups.json"));
    expect(playerPlayed(bb.players.find((p) => p.name === "Jayson Tatum")!)).toBe(true);
    expect(playerPlayed(bb.players.find((p) => p.name === "Neemias Queta")!)).toBe(false);
  });

  it("sporter och datum", () => {
    expect(sofaSportFor("Football")).toBe("football");
    expect(sofaSportFor("Ice Hockey")).toBe("ice-hockey");
    expect(sofaSportFor("Basketball")).toBe("basketball");
    expect(sofaSportFor("Tennis")).toBeNull();
    expect(utcDate(new Date("2026-10-18T23:30:00+02:00"))).toBe("2026-10-18");
  });

  // Riktiga svar från `npm run sofascore:capture`, när de finns.
  const LIVE = path.join(FIX, "live");
  describe.skipIf(!existsSync(LIVE))("live-fixturer från Sofascore", () => {
    const files = existsSync(LIVE) ? readdirSync(LIVE) : [];
    for (const f of files.filter((x) => x.endsWith("-statistics.json"))) {
      it(`${f}: skottmodellens fält finns`, () => {
        const t = shotTotals(parseStatistics(JSON.parse(readFileSync(path.join(LIVE, f), "utf8"))));
        if (f.startsWith("football")) {
          expect(t.homeShots).not.toBeNull();
          expect(t.homeCorners).not.toBeNull();
        }
      });
    }
    for (const f of files.filter((x) => x.endsWith("-lineups.json"))) {
      it(`${f}: spelare tolkas`, () => {
        const l = parseLineups(JSON.parse(readFileSync(path.join(LIVE, f), "utf8")));
        expect(l.players.length).toBeGreaterThan(0);
      });
    }
  });
});

describe("SofascoreClient", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** Låtsasworker: svarar ur en kö och minns anropen. */
  function stubWorker(responses: Partial<ScraplingResponse>[]) {
    const calls: ScraplingRequest[] = [];
    const worker = {
      fetch: async (req: ScraplingRequest) => {
        calls.push(req);
        const r = responses.shift();
        if (!r) throw new Error("inga fler svar");
        return { status: 200, url: req.url, body: "", ...r };
      },
      close: async () => undefined,
    } as unknown as ScraplingWorker;
    return { worker, calls };
  }

  function client(responses: Partial<ScraplingResponse>[], extra = {}) {
    dir = mkdtempSync(path.join(tmpdir(), "sofa-"));
    const stub = stubWorker(responses);
    const c = new SofascoreClient({ worker: stub.worker, cacheDir: dir, throttleMs: 0, log: () => undefined, ...extra });
    return { c, calls: stub.calls };
  }

  it("hämtar via HTTP-läget, cachar och läser cachen nästa gång", async () => {
    const { c, calls } = client([{ body: '{"a":1}' }]);
    expect(await c.get("/event/1/statistics")).toEqual({ a: 1 });
    expect(await c.get("/event/1/statistics")).toEqual({ a: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mode: "http", url: "https://www.sofascore.com/api/v1/event/1/statistics" });
    expect(c.fetched).toBe(1);
    expect(c.cacheHits).toBe(1);
  });

  it("404 ger null och cachas inte", async () => {
    const { c, calls } = client([{ status: 404 }, { body: '{"ok":true}' }]);
    expect(await c.get("/event/2/lineups")).toBeNull();
    expect(await c.get("/event/2/lineups")).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("403 → nästa väg (www, api, sedan webbläsaren via startsidan), och vägen som fungerar sitter kvar", async () => {
    const { c, calls } = client([
      { status: 403, body: '{"error":{"code":403}}' }, // HTTP www
      { status: 403 }, // HTTP api
      { body: "<html>sofascore.com</html>" }, // webbläsaren besöker startsidan
      { body: '<html><body><pre>{"x":"a &amp; b"}</pre></body></html>' }, // webbläsare www
      { body: '<pre>{"y":2}</pre>' }, // nästa anrop: samma väg direkt
    ]);
    expect(await c.get("/event/3")).toEqual({ x: "a & b" });
    expect(await c.get("/event/4")).toEqual({ y: 2 });
    expect(calls.map((r) => `${r.mode} ${new URL(r.url).host}${new URL(r.url).pathname}`)).toEqual([
      "http www.sofascore.com/api/v1/event/3",
      "http api.sofascore.com/api/v1/event/3",
      "browser www.sofascore.com/",
      "browser www.sofascore.com/api/v1/event/3",
      "browser www.sofascore.com/api/v1/event/4",
    ]);
  });

  it("403 på alla vägar ger spärrfel med Sofascores svar", async () => {
    const { c } = client([
      { status: 403 },
      { status: 403 },
      { body: "" },
      { status: 403 },
      { status: 403, body: '{"error":{"code":403,"reason":"Forbidden"}}' },
    ]);
    const err = (await c.get("/event/5").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(SofascoreBlockedError);
    expect(err.message).toMatch(/Forbidden/);
    expect(err.message).toMatch(/webbläsare api\.sofascore\.com/);
  });

  it("taket per körning", async () => {
    const { c } = client([{ body: "{}" }, { body: "{}" }], { maxRequests: 1 });
    await c.get("/a");
    await expect(c.get("/b")).rejects.toBeInstanceOf(SofascoreBudgetError);
  });

  it("offline läser bara cachen", async () => {
    const { c } = client([], { offline: true });
    await expect(c.get("/event/9")).rejects.toThrow(/offline/);
  });

  it("jsonFromBrowserPage klarar sidor utan <pre>", () => {
    expect(jsonFromBrowserPage('{"a":1}')).toBe('{"a":1}');
  });
});
