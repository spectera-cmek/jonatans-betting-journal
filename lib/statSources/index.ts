// Statistikkällorna för props-rättningen, i den ordning de provas:
//
//   fotboll  → ESPN (alla ligor ESPN följer)        → Sofascore
//   basket   → ESPN (NBA/WNBA)                       → Sofascore
//   hockey   → NHL:s officiella API (bara NHL)       → Sofascore
//
// ESPN och NHL är öppna API:er utan nyckel och utan skrapning. Sofascore är
// reserven för ligor de inte täcker; den hämtas via Scrapling och startas
// bara om den behövs.

import type { MatchData, PropBet } from "../propsGrading";
import { findEventForBet } from "../propsGrading";
import type { MatchEvent } from "../matchData";
import { sofaPaths, utcDate, type SofaSport } from "../sofascore/api";
import { SOFA_MAX_AGE, type SofascoreClient } from "../sofascore/client";
import { parseEvents, parseLineups, parseStatistics } from "../sofascore/parse";
import { espnDate, espnUrls, parseEspnNbaSummary, parseEspnScoreboard, parseEspnSoccerSummary, type EspnLeague } from "./espn";
import { JsonCache, STATS_MAX_AGE, scheduleMaxAge } from "./http";
import { nhlUrls, parseNhlBoxscore, parseNhlScore } from "./nhl";

export interface StatSource {
  name: string;
  /** Matchen för betet, eller null om källan inte hittar den. */
  findEvent(bet: PropBet): Promise<MatchEvent | null>;
  /** Statistiken för en färdigspelad match. */
  loadData(event: MatchEvent, needs: { stats: boolean; lineups: boolean }): Promise<MatchData>;
}

/** Dagarna runt avspark — källornas datum följer olika tidszoner. */
function daysAround(at: Date): Date[] {
  return [-1, 0, 1].map((d) => new Date(at.getTime() + d * 86_400_000));
}

/** Cachar dagslistorna i minnet också, så samma dag bara tolkas en gång per körning. */
function dayIndex(load: (day: Date) => Promise<MatchEvent[]>) {
  const memo = new Map<string, Promise<MatchEvent[]>>();
  return async (at: Date): Promise<MatchEvent[]> => {
    const lists = await Promise.all(
      daysAround(at).map((day) => {
        const key = utcDate(day);
        if (!memo.has(key)) memo.set(key, load(day));
        return memo.get(key)!;
      })
    );
    // Samma match kan stå i två intilliggande dagslistor (källornas dygn
    // följer olika tidszoner). Dubbletter skulle se ut som två lika bra
    // träffar, och då avstår matchFixture.
    const byId = new Map<number, MatchEvent>();
    for (const e of lists.flat()) byId.set(e.id, e);
    return [...byId.values()];
  };
}

export function espnSource(http: JsonCache, league: EspnLeague): StatSource {
  const sport = league === "soccer/all" ? "soccer" : "basketball";
  const events = dayIndex(async (day) =>
    parseEspnScoreboard(await http.get(espnUrls.scoreboard(league, espnDate(day)), scheduleMaxAge(day)), sport)
  );
  return {
    name: "ESPN",
    async findEvent(bet) {
      return bet.eventAt ? findEventForBet(bet, await events(bet.eventAt)) : null;
    },
    async loadData(event, needs) {
      if (!needs.stats && !needs.lineups) return { source: "ESPN", event, stats: null, lineups: null };
      const json = await http.get(espnUrls.summary(league, event.id), STATS_MAX_AGE.finished);
      if (sport === "soccer") {
        const s = parseEspnSoccerSummary(json ?? {});
        return { source: "ESPN", event, stats: s.stats, lineups: s.lineups };
      }
      return { source: "ESPN", event, stats: null, lineups: parseEspnNbaSummary(json ?? {}).lineups };
    },
  };
}

export function nhlSource(http: JsonCache): StatSource {
  const events = dayIndex(async (day) => parseNhlScore(await http.get(nhlUrls.score(utcDate(day)), scheduleMaxAge(day))));
  return {
    name: "NHL",
    async findEvent(bet) {
      return bet.eventAt ? findEventForBet(bet, await events(bet.eventAt)) : null;
    },
    async loadData(event, needs) {
      if (!needs.stats && !needs.lineups) return { source: "NHL", event, stats: null, lineups: null };
      const box = parseNhlBoxscore((await http.get(nhlUrls.boxscore(event.id), STATS_MAX_AGE.finished)) ?? {});
      return { source: "NHL", event, stats: box.stats, lineups: box.lineups };
    },
  };
}

export function sofascoreSource(client: () => SofascoreClient, sport: SofaSport): StatSource {
  const events = dayIndex(async (day) => {
    const json = await client().get(sofaPaths.scheduledEvents(sport, utcDate(day)), SOFA_MAX_AGE.schedule);
    return parseEvents(json).events;
  });
  return {
    name: "Sofascore",
    async findEvent(bet) {
      return bet.eventAt ? findEventForBet(bet, await events(bet.eventAt)) : null;
    },
    async loadData(event, needs) {
      const c = client();
      return {
        source: "Sofascore",
        event,
        stats: needs.stats ? parseStatistics((await c.get(sofaPaths.statistics(event.id), SOFA_MAX_AGE.finished)) ?? {}) : null,
        lineups: needs.lineups ? parseLineups((await c.get(sofaPaths.lineups(event.id), SOFA_MAX_AGE.finished)) ?? {}) : null,
      };
    },
  };
}

export interface SourceDeps {
  http: JsonCache;
  /** Skapas först när Sofascore behövs (startar Python-workern). */
  sofascore: () => SofascoreClient;
  /** Slås av när Sofascore spärrat oss — då hoppas reserven över resten av körningen. */
  sofascoreEnabled: () => boolean;
}

/**
 * Ger källorna för ett bet, i tur och ordning. `league` avgör om ESPN/NHL
 * alls täcker matchen: NBA/WNBA respektive NHL. Fotboll provas alltid mot
 * ESPN. Varje källa skapas en gång, så dagslistorna delas mellan betten.
 */
export function sourceRegistry(deps: SourceDeps): (sport: SofaSport, league: string | null | undefined) => StatSource[] {
  const made = new Map<string, StatSource>();
  const once = (key: string, make: () => StatSource) => {
    if (!made.has(key)) made.set(key, make());
    return made.get(key)!;
  };
  return (sport, league) => {
    const l = (league ?? "").toLowerCase();
    const out: StatSource[] = [];
    if (sport === "football") out.push(once("espn-soccer", () => espnSource(deps.http, "soccer/all")));
    if (sport === "basketball") {
      if (/wnba/.test(l)) out.push(once("espn-wnba", () => espnSource(deps.http, "basketball/wnba")));
      else if (!l || /\bnba\b/.test(l)) out.push(once("espn-nba", () => espnSource(deps.http, "basketball/nba")));
    }
    if (sport === "ice-hockey" && (!l || /\bnhl\b/.test(l))) out.push(once("nhl", () => nhlSource(deps.http)));
    if (deps.sofascoreEnabled()) out.push(once(`sofa-${sport}`, () => sofascoreSource(deps.sofascore, sport)));
    return out;
  };
}
