import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyPropBet, dataNeeded, findPlayer, gradeProp, type PropBet } from "../lib/propsGrading";
import { sourceRegistry } from "../lib/statSources";
import { espnDate, espnStatus, parseEspnNbaSummary, parseEspnScoreboard, parseEspnSoccerSummary } from "../lib/statSources/espn";
import { JsonCache } from "../lib/statSources/http";
import { parseNhlBoxscore, parseNhlScore, toiSeconds } from "../lib/statSources/nhl";
import type { SofascoreClient } from "../lib/sofascore/client";

// Riktiga svar från ESPN och NHL:s API (oktober 2026), trimmade.
const FIX = path.join(__dirname, "fixtures");
const load = (f: string) => JSON.parse(readFileSync(path.join(FIX, f), "utf8"));

describe("ESPN", () => {
  it("scoreboard: status, lag och 90-minutersresultat", () => {
    const evs = parseEspnScoreboard(load("espn/soccer-scoreboard.json"), "soccer");
    expect(evs[0]).toMatchObject({
      id: 401879263,
      status: "finished",
      homeTeam: { name: "AFC Bournemouth", shortName: "Bournemouth" },
      awayTeam: { name: "Sunderland" },
      homeScore: 2,
      awayScore: 0,
    });
    // Straffar: slutresultatet finns, 90-minutersresultatet är okänt.
    const pens = evs.find((e) => e.statusDescription === "FT-Pens")!;
    expect(pens).toMatchObject({ homeScore: null, awayScore: null, homeScoreFinal: 0, awayScoreFinal: 0 });
  });

  it("statusar", () => {
    expect(espnStatus({ name: "STATUS_SCHEDULED", state: "pre", completed: false }).status).toBe("scheduled");
    expect(espnStatus({ name: "STATUS_IN_PROGRESS", state: "in", completed: false }).status).toBe("live");
    expect(espnStatus({ name: "STATUS_POSTPONED", state: "post", completed: false }).status).toBe("postponed");
    expect(espnStatus({ name: "STATUS_FINAL_AET", state: "post", completed: true })).toMatchObject({ status: "finished", extraTime: true });
    expect(espnDate(new Date("2026-10-21T23:00:00Z"))).toBe("20261021");
  });

  it("fotbollens lagstatistik döps om till de gemensamma namnen", () => {
    const { stats } = parseEspnSoccerSummary(load("espn/soccer-summary.json"));
    expect(stats).toMatchObject({
      totalShotsOnGoal: { home: 29, away: 3 },
      shotsOnGoal: { home: 6, away: 0 },
      cornerKicks: { home: 5, away: 3 },
      goalkeeperSaves: { home: 0, away: 4 },
      ballPossession: { home: 65, away: 35 },
    });
  });

  it("fotbollsspelare: skott, på mål, mål, och vem som spelade", () => {
    const { lineups } = parseEspnSoccerSummary(load("espn/soccer-summary.json"));
    const tav = lineups.players.find((p) => p.name === "Marcus Tavernier")!;
    expect(tav).toMatchObject({ side: "home", played: true, stats: { totalShots: 3, onTargetScoringAttempt: 2, goals: 1 } });
    const benched = lineups.players.find((p) => p.name === "Juanlu Sanchez")!;
    expect(benched.played).toBe(false);
  });

  it("NBA: kolumnerna ur 'keys', gjorda trepoängare, DNP", () => {
    const { lineups } = parseEspnNbaSummary(load("espn/nba-summary.json"));
    const jj = lineups.players.find((p) => p.name === "Jalen Johnson")!;
    expect(jj).toMatchObject({ side: "away", played: true, stats: { points: 20, rebounds: 14, assists: 6, secondsPlayed: 1680 } });
    expect(lineups.players.find((p) => p.name === "CJ McCollum")!.stats.threePointsMade).toBe(4);
    expect(lineups.players.find((p) => p.name === "Dorian Finney-Smith")!.played).toBe(false);
  });
});

describe("NHL", () => {
  it("score: matcher med lagnamn och status", () => {
    const evs = parseNhlScore(load("nhl/score.json"));
    expect(evs[0]).toMatchObject({ id: 2026020152, status: "finished", homeTeam: { name: "Sabres", shortName: "BUF" }, awayTeam: { name: "Flyers" } });
    expect(evs[0]).toMatchObject({ homeScoreFinal: 1, awayScoreFinal: 3, homeScore: 1 });
  });

  it("boxscore: skott på mål, istid, målvakter", () => {
    const { stats, lineups } = parseNhlBoxscore(load("nhl/boxscore.json"));
    expect(stats).toEqual({ shotsOnGoal: { home: 28, away: 27 } });
    const quinn = lineups.players.find((p) => p.name === "J. Quinn")!;
    expect(quinn).toMatchObject({ side: "home", played: true, stats: { shotsOnGoal: 4, assists: 1, timeOnIce: 1245 } });
    expect(lineups.players.find((p) => p.name === "U. Luukkonen")!.stats.saves).toBe(24);
    expect(lineups.players.find((p) => p.name === "C. Ellis")!.played).toBe(false); // backupmålvakt
    expect(toiSeconds("21:21")).toBe(1281);
  });

  it("förkortade namn: efternamn + initial räknas som hela namnet", () => {
    const { lineups } = parseNhlBoxscore(load("nhl/boxscore.json"));
    expect(findPlayer("Jordan Quinn över 3.5 skott", lineups)?.name).toBe("J. Quinn");
    expect(findPlayer("Quinn Over 3.5", lineups)?.name).toBe("J. Quinn");
    expect(findPlayer("Rasmus Dahlin över 3.5 skott", lineups)?.name).toBe("R. Dahlin");
  });
});

describe("källkedjan", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** Låtsas-fetch som svarar med de sparade svaren. */
  function registry(sofascoreEnabled = false) {
    dir = mkdtempSync(path.join(tmpdir(), "stats-"));
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const file = url.includes("soccer/all/scoreboard")
        ? "espn/soccer-scoreboard.json"
        : url.includes("soccer/all/summary?event=401879263")
          ? "espn/soccer-summary.json"
          : url.includes("api-web.nhle.com/v1/score/")
            ? "nhl/score.json"
            : url.includes("/gamecenter/2026020152/boxscore")
              ? "nhl/boxscore.json"
              : null;
      if (!file) return new Response("{}", { status: 404 });
      return new Response(readFileSync(path.join(FIX, file), "utf8"), { status: 200 });
    }) as typeof fetch;
    const http = new JsonCache({ cacheDir: dir, throttleMs: 0, fetchImpl });
    const sourcesFor = sourceRegistry({
      http,
      sofascore: () => {
        throw new Error("Sofascore ska inte startas i testet");
      },
      sofascoreEnabled: () => sofascoreEnabled,
    });
    return { sourcesFor, calls };
  }

  async function run(bet: PropBet, sourcesFor: ReturnType<typeof registry>["sourcesFor"]) {
    const c = classifyPropBet(bet);
    if (!c.ok) throw new Error(c.reason);
    for (const src of sourcesFor(c.need.sport, bet.league)) {
      const ev = await src.findEvent(bet);
      if (!ev) continue;
      return gradeProp(bet, c.need, await src.loadData(ev, dataNeeded(c.need)));
    }
    return null;
  }

  const base: PropBet & { league: string } = {
    id: "b",
    sport: "Football",
    league: "Premier League",
    event: "AFC Bournemouth vs Sunderland",
    homeTeam: "Bournemouth",
    awayTeam: "Sunderland",
    eventAt: new Date("2026-10-18T13:00:00Z"),
    market: "totals",
    marketCategory: "Hörnor",
    marketScope: "match",
    selection: "Över 7.5 hörnor",
    selectionSide: "over",
    line: 7.5,
    betType: "single",
    eventKind: "match",
  };

  it("fotboll via ESPN: matchtotal hörnor", async () => {
    const { sourcesFor } = registry();
    const g = await run(base, sourcesFor);
    expect(g).toMatchObject({ ok: true, outcome: "win", value: 8 });
    expect((g as { reason: string }).reason).toMatch(/ESPN 401879263/);
  });

  it("fotboll via ESPN: spelarskott och lagskott", async () => {
    const { sourcesFor } = registry();
    expect(
      await run({ ...base, market: "other", marketCategory: "Skott", marketScope: "player", selection: "Rayan över 5.5 skott", line: 5.5 }, sourcesFor)
    ).toMatchObject({ ok: true, outcome: "win", value: 7 });
    expect(
      await run({ ...base, marketCategory: "Skott på mål", marketScope: "team", selection: "Sunderland över 0.5 skott på mål", line: 0.5 }, sourcesFor)
    ).toMatchObject({ ok: true, outcome: "loss", value: 0 });
  });

  it("dagslistorna hämtas en gång per dag, inte per bet", async () => {
    const { sourcesFor, calls } = registry();
    await run(base, sourcesFor);
    await run({ ...base, selectionSide: "under" }, sourcesFor);
    expect(calls.filter((u) => u.includes("scoreboard"))).toHaveLength(3); // dagen före, dagen, dagen efter
  });

  it("hockey via NHL:s API", async () => {
    const { sourcesFor } = registry();
    const bet: PropBet = {
      ...base,
      sport: "Ice Hockey",
      league: "NHL",
      event: "Buffalo Sabres vs Philadelphia Flyers",
      homeTeam: "Buffalo Sabres",
      awayTeam: "Philadelphia Flyers",
      eventAt: new Date("2026-10-21T23:30:00Z"),
      market: "other",
      marketCategory: "Skott",
      marketScope: "player",
      selection: "Jordan Quinn över 3.5 skott",
      line: 3.5,
    };
    const g = await run(bet, sourcesFor);
    expect(g).toMatchObject({ ok: true, outcome: "win", value: 4 });
    expect((g as { reason: string }).reason).toMatch(/NHL 2026020152/);
  });

  it("ligor utanför ESPN/NHL går bara till Sofascore", () => {
    const { sourcesFor } = registry(false);
    expect(sourcesFor("ice-hockey", "SHL")).toEqual([]);
    expect(sourcesFor("basketball", "Euroleague")).toEqual([]);
    expect(registry(true).sourcesFor("ice-hockey", "SHL").map((s) => s.name)).toEqual(["Sofascore"]);
    expect(registry(true).sourcesFor("football", "Allsvenskan").map((s) => s.name)).toEqual(["ESPN", "Sofascore"]);
  });

  it("samma källa återanvänds mellan anropen", () => {
    const { sourcesFor } = registry();
    expect(sourcesFor("football", "Allsvenskan")[0]).toBe(sourcesFor("football", "Premier League")[0]);
  });
});

// Typkontroll: Sofascore-klienten skapas bara via fabriken.
export type _Unused = SofascoreClient;
