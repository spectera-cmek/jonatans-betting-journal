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

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

export type SofaStatus = "scheduled" | "live" | "finished" | "postponed" | "cancelled";

export interface SofaTeam {
  id: number;
  name: string;
  shortName: string | null;
}

export interface SofaEvent {
  id: number;
  startAt: Date;
  status: SofaStatus;
  /** Sofascores egen statustext, t.ex. "AET" eller "AP" — för loggar. */
  statusDescription: string | null;
  homeTeam: SofaTeam;
  awayTeam: SofaTeam;
  /** Mål/poäng efter ordinarie tid (fotboll) när det finns, annars slutresultatet. */
  homeScore: number | null;
  awayScore: number | null;
  /** Slutresultatet inklusive förlängning. */
  homeScoreFinal: number | null;
  awayScoreFinal: number | null;
  tournamentName: string | null;
  uniqueTournamentId: number | null;
  seasonId: number | null;
  round: number | null;
}

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

/** /unique-tournament/{id} → namnet, för att kontrollera att id:t är rätt liga. */
export function parseUniqueTournament(json: unknown): { id: number; name: string; category: string | null } | null {
  const t = obj(obj(json).uniqueTournament);
  const id = num(t.id);
  const name = str(t.name);
  if (id == null || !name) return null;
  return { id, name, category: str(obj(t.category).name) };
}

// ---------------------------------------------------------------------------
// Lagstatistik
// ---------------------------------------------------------------------------

export interface StatPair {
  home: number;
  away: number;
}

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

export interface ShotTotals {
  homeShots: number | null;
  awayShots: number | null;
  homeSot: number | null;
  awaySot: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeXg: number | null;
  awayXg: number | null;
  homePossession: number | null;
  awayPossession: number | null;
}

/**
 * Skottmodellens fält ur lagstatistiken. Obs: Sofascores `totalShotsOnGoal`
 * är TOTALA skott; skott på mål heter `shotsOnGoal`.
 */
export function shotTotals(stats: Record<string, StatPair>): ShotTotals {
  const pick = (key: string) => stats[key] ?? null;
  const shots = pick("totalShotsOnGoal");
  const sot = pick("shotsOnGoal");
  const corners = pick("cornerKicks");
  const xg = pick("expectedGoals");
  const poss = pick("ballPossession");
  return {
    homeShots: shots?.home ?? null,
    awayShots: shots?.away ?? null,
    homeSot: sot?.home ?? null,
    awaySot: sot?.away ?? null,
    homeCorners: corners?.home ?? null,
    awayCorners: corners?.away ?? null,
    homeXg: xg?.home ?? null,
    awayXg: xg?.away ?? null,
    homePossession: poss?.home ?? null,
    awayPossession: poss?.away ?? null,
  };
}

// ---------------------------------------------------------------------------
// Spelarstatistik
// ---------------------------------------------------------------------------

export interface SofaPlayerLine {
  playerId: number;
  name: string;
  shortName: string | null;
  side: "home" | "away";
  substitute: boolean;
  /** Bara numeriska värden, platta (ratingVersions o.d. hoppas över). */
  stats: Record<string, number>;
}

export interface SofaLineups {
  confirmed: boolean;
  players: SofaPlayerLine[];
}

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

/** Finns nyckeln hos någon spelare i matchen? Om inte vet vi inte om fältet finns alls. */
export function hasStatKey(lineups: SofaLineups, key: string): boolean {
  return lineups.players.some((p) => key in p.stats);
}

/**
 * Spelade spelaren? Fotboll har minutesPlayed, basket secondsPlayed, hockey
 * timeOnIce (sekunder). En avbytare utan någon statistik alls kom inte in.
 */
export function playerPlayed(p: SofaPlayerLine): boolean {
  for (const key of ["minutesPlayed", "secondsPlayed", "timeOnIce"]) {
    if (key in p.stats) return p.stats[key] > 0;
  }
  return !p.substitute || Object.keys(p.stats).length > 0;
}
