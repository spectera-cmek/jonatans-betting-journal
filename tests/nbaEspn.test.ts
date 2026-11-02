import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  americanToDecimal,
  espnDate,
  madeAttempted,
  parseInjuries,
  parseMinutes,
  parsePickcenter,
  parseScoreboard,
  parseSummary,
  simplePosition,
} from "../lib/nba/espn";

const load = (f: string) => JSON.parse(fs.readFileSync(`tests/fixtures/${f}`, "utf8"));

describe("ESPN-hjälpare", () => {
  it("tolkar skott, minuter och positioner", () => {
    expect(madeAttempted("4-9")).toEqual([4, 9]);
    expect(madeAttempted("--")).toEqual([0, 0]);
    expect(parseMinutes("31")).toBe(31);
    expect(parseMinutes("31:30")).toBe(31.5);
    expect(parseMinutes("--")).toBe(0);
    expect(simplePosition("PG")).toBe("G");
    expect(simplePosition("SF")).toBe("F");
    expect(simplePosition("C")).toBe("C");
    expect(simplePosition("G-F")).toBe("G");
  });

  it("räknar om amerikanska odds", () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1.909, 3);
    expect(americanToDecimal(210)).toBeCloseTo(3.1, 6);
    expect(americanToDecimal(0)).toBeNull();
  });

  it("speldagen är amerikansk östkusttid", () => {
    // 01:00 svensk tid den 1 november = 31 oktober i New York.
    expect(espnDate(new Date("2026-11-01T00:30:00Z"))).toBe("20261031");
  });
});

describe("scoreboard", () => {
  const games = parseScoreboard(load("espn-nba-scoreboard.json"));

  it("läser spelade och kommande matcher", () => {
    expect(games).toHaveLength(3);
    const g = games[0];
    expect(g.id).toBe(401909896);
    expect(g.status).toBe("final");
    expect(g.home.abbr).toBe("UTAH");
    expect(g.away.abbr).toBe("POR");
    expect(g.homeScore).toBe(90);
    expect(g.awayScore).toBe(112);
    expect(g.season).toBe(2027);
    expect(g.seasonType).toBe(2);
    const next = games[2];
    expect(next.status).toBe("scheduled");
    expect(next.homeScore).toBeNull();
  });
});

describe("summary", () => {
  const s = parseSummary(load("espn-nba-summary.json"), 401909896)!;

  it("läser matchen och båda lagens boxscore", () => {
    expect(s.game.homeScore).toBe(90);
    expect(s.teams).toHaveLength(2);
    const por = s.teams.find((t) => t.teamId === 22)!;
    expect(por.home).toBe(false);
    expect(por.pts).toBe(112);
    // 31-76 FG, 16-44 3P → 15-32 på tvåor.
    expect(por.fgm2).toBe(15);
    expect(por.fga2).toBe(32);
    expect(por.fga3).toBe(44);
    expect(por.fta).toBe(41);
    expect(por.tov).toBe(19);
  });

  it("läser spelarrader och DNP", () => {
    const camara = s.players.find((p) => p.name === "Toumani Camara")!;
    expect(camara.teamId).toBe(22);
    expect(camara.starter).toBe(true);
    expect(camara.minutes).toBe(31);
    expect(camara.fga3).toBe(9);
    expect(camara.fga2).toBe(0);
    expect(camara.position).toBe("F");
    const dnp = s.players.find((p) => p.dnp);
    expect(dnp).toBeTruthy();
    expect(dnp!.minutes).toBe(0);
    expect(dnp!.dnpReason).toMatch(/COACH/);
    // Lagets poäng = spelarnas poäng.
    const sum = s.players.filter((p) => p.teamId === 22).reduce((a, p) => a + p.pts, 0);
    expect(sum).toBe(112);
  });

  it("läser DraftKings-linjen med hemmalagets handicap", () => {
    const o = s.odds!;
    expect(o.book).toBe("draftkings");
    // POR (borta) favorit −6,5 → hemma +6,5.
    expect(o.spread!.line).toBe(6.5);
    expect(o.total!.line).toBe(232.5);
    expect(o.ml!.home).toBeCloseTo(3.1, 6);
    expect(o.ml!.away).toBeCloseTo(1 + 100 / 258, 6);
  });

  it("hemmafavorit ger negativ linje", () => {
    const o = parsePickcenter([{ provider: { name: "DraftKings", priority: 1 }, spread: 4.5, overUnder: 220, homeTeamOdds: { favorite: true, moneyLine: -180 }, awayTeamOdds: { favorite: false, moneyLine: 150 } }])!;
    expect(o.spread!.line).toBe(-4.5);
    expect(o.spread!.home).toBeCloseTo(1.909, 3);
  });
});

describe("skadelistan", () => {
  it("läser spelar-id ur länken och status", () => {
    const list = parseInjuries(load("espn-nba-injuries.json"));
    const landale = list.find((i) => i.playerName === "Jock Landale")!;
    expect(landale.playerId).toBe(3146557);
    expect(landale.status).toBe("Day-To-Day");
    expect(landale.teamId).toBe(1);
    expect(list.some((i) => i.status === "Out")).toBe(true);
  });
});
