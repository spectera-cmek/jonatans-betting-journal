import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  isChallengePage,
  parseMapStats,
  parseMatchPage,
  parseRanking,
  parseResults,
  parseTeamPage,
  parseVetoLine,
  resultsHasNextPage,
  roundIcon,
  summarizeRounds,
} from "../lib/cs2/hltv/parse";
import { trimHltvPage, type HltvPageKind } from "../lib/cs2/hltv/trim";
import { idFromHref, slugFromHref, hltvUrls } from "../lib/cs2/hltv/urls";
import { sideRoundsFromHalves } from "../lib/cs2/ingest";
import { canonicalMap, activeMapPool, mapLabel } from "../lib/cs2/maps";
import { cacheFileFor } from "../lib/cs2/hltv/session";

const FIX = path.join(__dirname, "fixtures", "cs2", "hltv");
const read = (name: string) => readFileSync(path.join(FIX, name), "utf8");

describe("hltv urls", () => {
  it("plockar id och slug ur länkar", () => {
    expect(idFromHref("/team/9565/vitality", "team")).toBe(9565);
    expect(idFromHref("https://www.hltv.org/matches/2380001/a-vs-b", "matches")).toBe(2380001);
    expect(idFromHref("/stats/matches/mapstatsid/200001/x", "mapstatsid")).toBe(200001);
    expect(idFromHref("/stats/players/11893/zywoo", "players")).toBe(11893);
    expect(idFromHref("/teams/abc", "team")).toBeNull();
    expect(idFromHref(undefined, "team")).toBeNull();
    expect(slugFromHref("/team/9565/vitality", "team")).toBe("vitality");
  });

  it("bygger resultat-URL med datum och offset", () => {
    const u = hltvUrls.teamResults(9565, new Date("2026-04-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"), 100);
    expect(u).toBe("/results?team=9565&startDate=2026-04-01&endDate=2026-10-01&offset=100");
  });

  it("cachefilnamn är stabila och unika per sökväg", () => {
    const a = cacheFileFor(".cache/cs2", "/results?team=1&offset=0");
    const b = cacheFileFor(".cache/cs2", "/results?team=1&offset=100");
    expect(a).not.toBe(b);
    expect(cacheFileFor(".cache/cs2", "/results?team=1&offset=0")).toBe(a);
    expect(a.endsWith(".html")).toBe(true);
  });
});

describe("kartnamn", () => {
  it("normaliserar HLTV- och demonamn", () => {
    expect(canonicalMap("de_dust2")).toBe("dust2");
    expect(canonicalMap("Dust II")).toBe("dust2");
    expect(canonicalMap("d2")).toBe("dust2");
    expect(canonicalMap("Mirage")).toBe("mirage");
    expect(canonicalMap("mrg")).toBe("mirage");
    expect(canonicalMap("de_anubis")).toBe("anubis");
    expect(canonicalMap("TBA")).toBeNull();
    expect(canonicalMap("Default")).toBeNull();
    // Ny karta behålls i stället för att försvinna.
    expect(canonicalMap("de_newmap")).toBe("newmap");
    expect(mapLabel("dust2")).toBe("Dust2");
    expect(mapLabel("newmap")).toBe("Newmap");
  });

  it("härleder kartpoolen ur förekomster", () => {
    const at = new Date("2026-09-01");
    const old = new Date("2025-01-01");
    const rows = [
      ...Array(5).fill({ mapName: "mirage", at }),
      ...Array(3).fill({ mapName: "nuke", at }),
      ...Array(2).fill({ mapName: "vertigo", at }),
      ...Array(9).fill({ mapName: "cache", at: old }),
    ];
    expect(activeMapPool(rows, new Date("2026-06-01"), 3)).toEqual(["mirage", "nuke"]);
  });
});

describe("parseRanking", () => {
  const r = parseRanking(read("ranking.html"));
  it("läser lag, placering, poäng och lineup", () => {
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ rank: 1, team: { id: 9565, name: "Vitality", slug: "vitality" }, points: 1987 });
    expect(r[0].players.map((p) => p.nickname)).toEqual(["ZywOo", "apEX", "mezii", "flameZ", "ropz"]);
    expect(r[1].team.id).toBe(4494);
    expect(r[1].players).toHaveLength(5);
  });
});

describe("parseTeamPage", () => {
  const t = parseTeamPage(read("team.html"));
  it("läser namn, land och startfemman (bänkade utelämnas)", () => {
    expect(t.id).toBe(9565);
    expect(t.name).toBe("Vitality");
    expect(t.country).toBe("France");
    expect(t.players.map((p) => p.id)).toEqual([11893, 7322, 18462, 16947, 2730]);
  });
  it("tar bara kommande matcher, inte senaste resultat", () => {
    expect(t.upcoming).toHaveLength(1);
    expect(t.upcoming[0].matchId).toBe(2390001);
    expect(t.upcoming[0].startAt?.getTime()).toBe(1791648000000);
  });
});

describe("parseResults", () => {
  const html = read("results.html");
  const rows = parseResults(html);
  it("läser varje serie", () => {
    expect(rows.map((r) => r.matchId)).toEqual([2380001, 2379000]);
    expect(rows[0]).toMatchObject({ team1Name: "Vitality", team2Name: "FaZe", score1: 2, score2: 0, eventName: "IEM X 2026" });
    expect(rows[0].startAt?.getTime()).toBe(1790000000000);
    expect(rows[1]).toMatchObject({ score1: 1, score2: 2 });
  });
  it("ser att det inte finns fler sidor", () => {
    expect(resultsHasNextPage(html)).toBe(false);
    expect(resultsHasNextPage('<a class="pagination-next" href="/results?offset=100">Next</a>')).toBe(true);
  });
});

describe("parseVetoLine", () => {
  it("tolkar ban, pick och decider", () => {
    expect(parseVetoLine("1. FaZe removed Anubis")).toEqual({ step: 1, teamName: "FaZe", action: "ban", mapName: "anubis" });
    expect(parseVetoLine("3. Team Spirit picked Dust2")).toEqual({ step: 3, teamName: "Team Spirit", action: "pick", mapName: "dust2" });
    expect(parseVetoLine("7. Inferno was left over")).toEqual({ step: 7, teamName: null, action: "decider", mapName: "inferno" });
    expect(parseVetoLine("Best of 3 (LAN)")).toBeNull();
  });
});

describe("parseMatchPage", () => {
  const m = parseMatchPage(read("match.html"));
  it("läser lag, resultat, format och status", () => {
    expect(m.id).toBe(2380001);
    expect(m.team1).toMatchObject({ id: 9565, name: "Vitality" });
    expect(m.team2).toMatchObject({ id: 6667, name: "FaZe" });
    expect(m.score1).toBe(2);
    expect(m.score2).toBe(0);
    expect(m.format).toBe("bo3");
    expect(m.lan).toBe(true);
    expect(m.status).toBe("finished");
    expect(m.startAt?.getTime()).toBe(1790000000000);
    expect(m.event).toMatchObject({ id: 8000, name: "IEM X 2026" });
  });
  it("läser vetot i ordning", () => {
    expect(m.vetoes).toHaveLength(7);
    expect(m.vetoes.filter((v) => v.action === "pick").map((v) => [v.teamName, v.mapName])).toEqual([
      ["FaZe", "nuke"],
      ["Vitality", "mirage"],
    ]);
    expect(m.vetoes[6]).toMatchObject({ action: "decider", mapName: "inferno", teamName: null });
  });
  it("läser kartor, pick, halvlekar och övertid", () => {
    expect(m.maps).toHaveLength(3);
    const [nuke, mirage, inferno] = m.maps;
    expect(nuke).toMatchObject({ mapNumber: 1, mapName: "nuke", mapStatsId: 200001, team1Score: 13, team2Score: 9, pickedBy: "team2", played: true, otRounds: 0 });
    expect(nuke.halves).toEqual([
      { team1: 5, team2: 7, team1Side: "t" },
      { team1: 8, team2: 2, team1Side: "ct" },
    ]);
    expect(mirage).toMatchObject({ mapName: "mirage", team1Score: 16, team2Score: 14, pickedBy: "team1", otRounds: 6 });
    expect(inferno.played).toBe(false);
    expect(inferno.mapStatsId).toBeNull();
  });
  it("läser demolänk och lineups", () => {
    expect(m.demoUrl).toBe("/download/demo/95001");
    expect(m.lineups).toHaveLength(2);
    expect(m.lineups[0].teamId).toBe(9565);
    expect(m.lineups[0].players.map((p) => p.nickname)).toEqual(["ZywOo", "apEX", "mezii", "flameZ", "ropz"]);
    expect(m.lineups[1].players).toHaveLength(5);
  });
  it("kommande match är scheduled", () => {
    const html = read("match.html")
      .replace("Match over", "1d : 03h : 12m")
      .replace(/results-team-score">\d+/g, 'results-team-score">-');
    expect(parseMatchPage(html).status).toBe("scheduled");
  });
});

describe("halvlekar → sidor", () => {
  it("summerar rundor per lag och sida", () => {
    expect(
      sideRoundsFromHalves([
        { team1: 5, team2: 7, team1Side: "t" },
        { team1: 8, team2: 2, team1Side: "ct" },
      ])
    ).toEqual({ team1Ct: 8, team1T: 5, team2Ct: 7, team2T: 2, team1StartSide: "t" });
    expect(sideRoundsFromHalves([{ team1: 5, team2: 7, team1Side: null }])).toBeNull();
    expect(sideRoundsFromHalves([])).toBeNull();
  });
});

describe("parseMapStats", () => {
  const s = parseMapStats(read("mapstats.html"));
  it("läser karta, lag, länk och startsida", () => {
    expect(s.id).toBe(200001);
    expect(s.matchId).toBe(2380001);
    expect(s.mapName).toBe("nuke");
    expect(s.playedAt?.getTime()).toBe(1790000600000);
    expect(s.team1).toMatchObject({ id: 9565, name: "Vitality" });
    expect(s.team2).toMatchObject({ id: 6667, name: "FaZe" });
    expect(s.team1Score).toBe(13);
    expect(s.team2Score).toBe(9);
    expect(s.team1StartSide).toBe("t");
  });
  it("läser rundhistoriken så att den går ihop med resultatet", () => {
    expect(s.rounds).toHaveLength(22);
    expect(s.rounds[0]).toEqual({ n: 1, winner: "team2", side: "ct", reason: "elimination" });
    expect(s.rounds[2]).toEqual({ n: 3, winner: "team1", side: "t", reason: "bomb_exploded" });
    expect(s.rounds[6].reason).toBe("time");
    expect(summarizeRounds(s.rounds)).toEqual({ team1Ct: 8, team1T: 5, team2Ct: 7, team2T: 2, otRounds: 0 });
  });
  it("läser scoreboards för båda lagen och båda sidor", () => {
    const all = s.players.filter((p) => p.side === "all");
    expect(all).toHaveLength(10);
    const zywoo = all.find((p) => p.playerId === 11893)!;
    expect(zywoo).toMatchObject({
      nickname: "ZywOo",
      teamId: 9565,
      kills: 22,
      headshots: 11,
      assists: 5,
      flashAssists: 1,
      deaths: 14,
      kast: 77.3,
      adr: 98.1,
      rating: 1.45,
      openingDiff: 3,
    });
    expect(all.find((p) => p.playerId === 3741)).toMatchObject({ teamId: 6667, openingDiff: -3 });
    expect(s.players.filter((p) => p.side === "ct")).toHaveLength(10);
    expect(s.players.filter((p) => p.side === "t")).toHaveLength(10);
  });
  it("tolkar rundikonerna", () => {
    expect(roundIcon("//x/emptyHistory.svg")).toBeNull();
    expect(roundIcon("//x/bomb_defused.svg")).toEqual({ side: "ct", reason: "bomb_defused" });
    expect(roundIcon("//x/t_win.svg")).toEqual({ side: "t", reason: "elimination" });
    expect(roundIcon("//x/stopwatch.svg")).toEqual({ side: "ct", reason: "time" });
  });
});

describe("Cloudflare och trimning", () => {
  it("känner igen en utmaningssida", () => {
    expect(isChallengePage("<html><title>Just a moment...</title><div id='cf-browser-verification'></div></html>")).toBe(true);
    expect(isChallengePage(read("match.html"))).toBe(false);
  });

  it("tar inte en vanlig sida med Cloudflares skript för en utmaning", () => {
    const links = Array.from({ length: 40 }, (_, i) => `<a href="/team/${i}/x">t${i}</a>`).join("");
    const normal = `<html><head><title>CS2 Valve ranking | HLTV.org</title></head><body>${links}<script>(function(){var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';})();</script></body></html>`;
    expect(isChallengePage(normal)).toBe(false);
    // Turnstile-rutan på mellansidan, utan riktigt innehåll runt.
    const turnstile = `<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div><script>window._cf_chl_opt={}</script></body></html>`;
    expect(isChallengePage(turnstile)).toBe(true);
    // Absoluta HLTV-länkar räknas också, och en Turnstile-ruta i ett formulär gör inte sidan till en utmaning.
    const absolute = Array.from({ length: 40 }, (_, i) => `<a href="https://www.hltv.org/team/${i}/x">t</a>`).join("");
    expect(isChallengePage(`<html><title>Just a moment...</title><body>${absolute}</body></html>`)).toBe(false);
    expect(isChallengePage(`<html><title>HLTV</title><body><div class="cf-turnstile"></div></body></html>`)).toBe(false);
  });

  const kinds: Array<[HltvPageKind, string, (h: string) => unknown]> = [
    ["ranking", "ranking.html", parseRanking],
    ["team", "team.html", parseTeamPage],
    ["results", "results.html", parseResults],
    ["match", "match.html", parseMatchPage],
    ["mapstats", "mapstats.html", parseMapStats],
  ];
  for (const [kind, file, parse] of kinds) {
    it(`trimmad ${kind}-sida tolkas likadant som originalet`, () => {
      const html = read(file);
      const trimmed = trimHltvPage(html, kind);
      expect(trimmed.length).toBeLessThanOrEqual(html.length + 200);
      expect(JSON.stringify(parse(trimmed))).toBe(JSON.stringify(parse(html)));
    });
  }
});

// Riktiga sidor sparade med `npm run cs2:capture`. Hoppas över tills de finns.
const LIVE = path.join(__dirname, "fixtures", "cs2", "live");
const live = (f: string) => path.join(LIVE, f);
describe.skipIf(!existsSync(live("match.html")))("live-fixturer från HLTV", () => {
  it("ranking ger minst 10 lag med lineups", () => {
    if (!existsSync(live("ranking.html"))) return;
    const r = parseRanking(readFileSync(live("ranking.html"), "utf8"));
    expect(r.length).toBeGreaterThanOrEqual(5);
    expect(r[0].players.length).toBeGreaterThanOrEqual(5);
  });
  it("matchsidan ger lag, format och kartor", () => {
    const m = parseMatchPage(readFileSync(live("match.html"), "utf8"));
    expect(m.team1).not.toBeNull();
    expect(m.team2).not.toBeNull();
    expect(m.format).not.toBeNull();
    expect(m.maps.length).toBeGreaterThan(0);
  });
  it("mapstats går ihop med sig själv", () => {
    if (!existsSync(live("mapstats.html"))) return;
    const s = parseMapStats(readFileSync(live("mapstats.html"), "utf8"));
    expect(s.players.filter((p) => p.side === "all")).toHaveLength(10);
    expect(s.rounds.length).toBe((s.team1Score ?? 0) + (s.team2Score ?? 0));
  });
});

describe("synligt fönster som standard", () => {
  it("är synligt utom med --headless eller CS2_HEADLESS=1", async () => {
    const { headedFromArgs } = await import("../lib/cs2/hltv/session");
    const prev = process.env.CS2_HEADLESS;
    delete process.env.CS2_HEADLESS;
    expect(headedFromArgs(["node", "x"])).toBe(true);
    expect(headedFromArgs(["node", "x", "--headed"])).toBe(true);
    expect(headedFromArgs(["node", "x", "--confirm", "--headless"])).toBe(false);
    process.env.CS2_HEADLESS = "1";
    expect(headedFromArgs(["node", "x"])).toBe(false);
    if (prev === undefined) delete process.env.CS2_HEADLESS;
    else process.env.CS2_HEADLESS = prev;
  });
});
