// Rena tolkare för Sofascores JSON. Inget nätverk här — testas mot fixturer
// i tests/fixtures/sofascore. Fältnamnen kommer från riktiga svar; när
// Sofascore ändrar något visar `npm run sofascore:capture` vad som saknas.
//
// Två saker att känna till om svaren:
//  - Lagstatistiken (/statistics) delas per period: ALL, 1ST, 2ND. Bara ALL
//    används här.
//  - Spelarstatistiken (/lineups) utelämnar räknare som är 0. En saknad nyckel
//    betyder alltså 0 — men bara om nyckeln finns hos någon annan spelare i
//    samma match. Annars vet vi inte om fältet ens finns (se hasStatKey).

import {
  hasStatKey,
  playerPlayed,
  type Lineups,
  type MatchEvent,
  type MatchStatus,
  type MatchTeam,
  type PlayerLine,
  type StatPair,
} from "../matchData";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

export type SofaStatus = MatchStatus;
export type SofaTeam = MatchTeam;
export type SofaEvent = MatchEvent;
export type SofaPlayerLine = PlayerLine;
export type SofaLineups = Lineups;
export type { StatPair };
export { hasStatKey, playerPlayed };

export function mapStatus(type: string | null): SofaStatus {
  switch ((type ?? "").toLowerCase()) {
    case "finished":
      return "finished";
    case "inprogress":
      return "live";
    case "postponed":
    case "interrupted":
    case "suspended":
    case "delayed":
      return "postponed";
    case "canceled":
    case "cancelled":
    case "abandoned":
      return "cancelled";
    default:
      return "scheduled";
  }
}

function parseTeam(v: unknown): SofaTeam | null {
  const t = obj(v);
  const id = num(t.id);
  const name = str(t.name);
  if (id == null || !name) return null;
  return { id, name, shortName: str(t.shortName) };
}

export function parseEvent(v: unknown): SofaEvent | null {
  const e = obj(v);
  const id = num(e.id);
  const ts = num(e.startTimestamp);
  const homeTeam = parseTeam(e.homeTeam);
  const awayTeam = parseTeam(e.awayTeam);
  if (id == null || ts == null || !homeTeam || !awayTeam) return null;
  const status = obj(e.status);
  const hs = obj(e.homeScore);
  const as = obj(e.awayScore);
  const tournament = obj(e.tournament);
  return {
    id,
    startAt: new Date(ts * 1000),
    status: mapStatus(str(status.type)),
    statusDescription: str(status.description),
    homeTeam,
    awayTeam,
    homeScore: num(hs.normaltime) ?? num(hs.current),
    awayScore: num(as.normaltime) ?? num(as.current),
    homeScoreFinal: num(hs.current),
    awayScoreFinal: num(as.current),
    tournamentName: str(tournament.name),
    uniqueTournamentId: num(obj(tournament.uniqueTournament).id),
    seasonId: num(obj(e.season).id),
    round: num(obj(e.roundInfo).round),
  };
}

/** /scheduled-events, /events/last|next och /event/{id} (som har `event` i stället för `events`). */
export function parseEvents(json: unknown): { events: SofaEvent[]; hasNextPage: boolean } {
  const j = obj(json);
  const raw = j.event ? [j.event] : arr(j.events);
  const events = raw.map(parseEvent).filter((e): e is SofaEvent => e !== null);
  return { events, hasNextPage: j.hasNextPage === true };
}

export interface SofaSeason {
  id: number;
  name: string;
  year: string;
}

/** /unique-tournament/{id}/seasons — senaste säsongen först, som Sofascore själv sorterar. */
export function parseSeasons(json: unknown): SofaSeason[] {
  return arr(obj(json).seasons)
    .map((v) => {
      const s = obj(v);
      const id = num(s.id);
      if (id == null) return null;
      return { id, name: str(s.name) ?? String(id), year: str(s.year) ?? "" };
    })
    .filter((s): s is SofaSeason => s !== null);
}

// ---------------------------------------------------------------------------
// Lagstatistik
// ---------------------------------------------------------------------------

/**
 * /event/{id}/statistics → nyckel → {home, away} för hela matchen (period ALL).
 * Samma nyckel kan stå i flera grupper (totalShotsOnGoal finns i både
 * "Match overview" och "Shots"); värdena är desamma, första vinner.
 */
export function parseStatistics(json: unknown): Record<string, StatPair> {
  const periods = arr(obj(json).statistics).map(obj);
  const all = periods.find((p) => p.period === "ALL") ?? periods[0];
  const out: Record<string, StatPair> = {};
  if (!all) return out;
  for (const g of arr(all.groups)) {
    for (const item of arr(obj(g).statisticsItems)) {
      const it = obj(item);
      const key = str(it.key);
      const home = num(it.homeValue);
      const away = num(it.awayValue);
      if (!key || home == null || away == null || key in out) continue;
      out[key] = { home, away };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spelarstatistik
// ---------------------------------------------------------------------------

/** /event/{id}/lineups — båda lagens spelare med sin matchstatistik. */
export function parseLineups(json: unknown): SofaLineups {
  const j = obj(json);
  const players: SofaPlayerLine[] = [];
  for (const side of ["home", "away"] as const) {
    for (const entry of arr(obj(j[side]).players)) {
      const e = obj(entry);
      const p = obj(e.player);
      const playerId = num(p.id);
      const name = str(p.name);
      if (playerId == null || !name) continue;
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj(e.statistics))) {
        const n = num(v);
        if (n != null) stats[k] = n;
      }
      players.push({ playerId, name, shortName: str(p.shortName), side, substitute: e.substitute === true, stats });
    }
  }
  return { confirmed: j.confirmed === true, players };
}
