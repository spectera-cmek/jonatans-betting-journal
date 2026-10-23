// ESPN:s öppna JSON (site.api.espn.com) som statistikkälla för props:
// fotboll (alla ligor ESPN följer, även Allsvenskan) och NBA. Samma API som
// lib/scores.ts redan använder för resultat. Ingen nyckel, ingen skrapning.
//
// Rena tolkare här; hämtningen sköter lib/statSources/index.ts. Fälten
// döps om till de gemensamma namnen i lib/matchData.ts.

import type { Lineups, MatchEvent, MatchStatus, PlayerLine, StatPair } from "../matchData";

export const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports";

/** "soccer/all" täcker alla fotbollsligor ESPN har; NBA har en egen. */
export type EspnLeague = "soccer/all" | "basketball/nba" | "basketball/wnba";

export const espnUrls = {
  scoreboard: (league: EspnLeague, ymd: string) => `${ESPN_SITE}/${league}/scoreboard?dates=${ymd}&limit=500`,
  summary: (league: EspnLeague, id: number) => `${ESPN_SITE}/${league}/summary?event=${id}`,
};

/** 2026-10-21 → 20261021 (ESPN:s datumformat). */
export function espnDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const toNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function espnStatus(type: unknown): { status: MatchStatus; description: string | null; extraTime: boolean } {
  const t = obj(type);
  const name = (str(t.name) ?? "").toUpperCase();
  const description = str(t.detail) ?? str(t.description);
  // Förlängning eller straffar: ESPN:s resultat är då inte 90-minutersresultatet.
  const extraTime = /AET|PEN|OVERTIME|_OT/.test(name) || /AET|pens/i.test(description ?? "");
  let status: MatchStatus = "scheduled";
  if (/POSTPONED|DELAYED|SUSPENDED/.test(name)) status = "postponed";
  else if (/CANCELED|CANCELLED|ABANDONED|FORFEIT/.test(name)) status = "cancelled";
  else if (t.completed === true) status = "finished";
  else if (t.state === "in") status = "live";
  return { status, description, extraTime };
}

function competitorsOf(comp: Json): { home: Json; away: Json } | null {
  const cs = arr(comp.competitors).map(obj);
  const home = cs.find((c) => c.homeAway === "home");
  const away = cs.find((c) => c.homeAway === "away");
  return home && away ? { home, away } : null;
}

function team(c: Json): { id: number; name: string; shortName: string | null } | null {
  const t = obj(c.team);
  const id = toNum(t.id);
  const name = str(t.displayName) ?? str(t.name);
  if (id == null || !name) return null;
  return { id, name, shortName: str(t.shortDisplayName) };
}

/** Scoreboard → matcher. `normalTimeKnown`: fotboll har 90-minutersmarknader, basket inte. */
export function parseEspnScoreboard(json: unknown, sport: "soccer" | "basketball"): MatchEvent[] {
  const out: MatchEvent[] = [];
  for (const raw of arr(obj(json).events)) {
    const e = obj(raw);
    const id = toNum(e.id);
    const date = str(e.date);
    const comp = obj(arr(e.competitions)[0]);
    const cs = competitorsOf(comp);
    if (id == null || !date || !cs) continue;
    const home = team(cs.home);
    const away = team(cs.away);
    if (!home || !away) continue;
    const st = espnStatus(obj(e.status).type ?? obj(comp.status).type);
    const hs = toNum(cs.home.score);
    const as = toNum(cs.away.score);
    // Fotboll efter förlängning/straffar: 90-minutersresultatet är okänt.
    const normalUnknown = sport === "soccer" && st.extraTime;
    out.push({
      id,
      startAt: new Date(date),
      status: st.status,
      statusDescription: st.description,
      homeTeam: home,
      awayTeam: away,
      homeScore: normalUnknown ? null : hs,
      awayScore: normalUnknown ? null : as,
      homeScoreFinal: hs,
      awayScoreFinal: as,
      tournamentName: str(obj(e.season).slug),
      uniqueTournamentId: null,
      seasonId: null,
      round: null,
    });
  }
  return out;
}

/** Hemma/borta per lag-id ur summary-svarets header. */
function sidesById(summary: Json): Map<number, "home" | "away"> {
  const sides = new Map<number, "home" | "away">();
  const comp = obj(arr(obj(summary.header).competitions)[0]);
  for (const c of arr(comp.competitors).map(obj)) {
    const id = toNum(obj(c.team).id);
    if (id != null && (c.homeAway === "home" || c.homeAway === "away")) sides.set(id, c.homeAway);
  }
  return sides;
}

/** ESPN:s fotbollsfält → de gemensamma namnen (lagnivå). */
const SOCCER_TEAM_KEYS: Record<string, string> = {
  totalShots: "totalShotsOnGoal", // ESPN: alla skott — gemensamt namn (Sofascores) för TOTALA skott
  shotsOnTarget: "shotsOnGoal",
  wonCorners: "cornerKicks",
  saves: "goalkeeperSaves",
  offsides: "offsides",
  possessionPct: "ballPossession",
  foulsCommitted: "fouls",
  yellowCards: "yellowCards",
  redCards: "redCards",
};

/** ESPN:s fotbollsfält → de gemensamma namnen (spelarnivå). */
const SOCCER_PLAYER_KEYS: Record<string, string> = {
  totalShots: "totalShots",
  shotsOnTarget: "onTargetScoringAttempt",
  totalGoals: "goals",
  goalAssists: "goalAssist",
  saves: "saves",
  offsides: "totalOffside",
  foulsCommitted: "fouls",
  yellowCards: "yellowCards",
};

/** Fotbollens summary → lagstatistik och spelare. */
export function parseEspnSoccerSummary(json: unknown): { stats: Record<string, StatPair> | null; lineups: Lineups } {
  const j = obj(json);
  const sides = sidesById(j);
  const sideOf = (t: Json): "home" | "away" | null => {
    if (t.homeAway === "home" || t.homeAway === "away") return t.homeAway;
    const id = toNum(obj(t.team).id);
    return id != null ? sides.get(id) ?? null : null;
  };

  const perSide: Partial<Record<"home" | "away", Record<string, number>>> = {};
  for (const t of arr(obj(j.boxscore).teams).map(obj)) {
    const side = sideOf(t);
    if (!side) continue;
    const vals: Record<string, number> = {};
    for (const s of arr(t.statistics).map(obj)) {
      const key = SOCCER_TEAM_KEYS[str(s.name) ?? ""];
      const v = toNum(s.displayValue ?? s.value);
      if (key && v != null) vals[key] = v;
    }
    perSide[side] = vals;
  }
  let stats: Record<string, StatPair> | null = null;
  if (perSide.home && perSide.away) {
    stats = {};
    for (const key of Object.keys(perSide.home)) {
      if (key in perSide.away) stats[key] = { home: perSide.home[key], away: perSide.away[key] };
    }
  }

  const players: PlayerLine[] = [];
  for (const r of arr(j.rosters).map(obj)) {
    const side = sideOf(r);
    if (!side) continue;
    for (const p of arr(r.roster).map(obj)) {
      const a = obj(p.athlete);
      const playerId = toNum(a.id);
      const name = str(a.displayName);
      if (playerId == null || !name) continue;
      const raw: Record<string, number> = {};
      for (const s of arr(p.stats).map(obj)) {
        const v = toNum(s.value);
        if (str(s.name) && v != null) raw[s.name as string] = v;
      }
      const stats: Record<string, number> = {};
      for (const [from, to] of Object.entries(SOCCER_PLAYER_KEYS)) if (from in raw) stats[to] = raw[from];
      const played = "appearances" in raw ? raw.appearances > 0 : p.starter === true || p.subbedIn === true;
      players.push({ playerId, name, shortName: str(a.shortName), side, substitute: p.starter !== true, played, stats });
    }
  }
  return { stats, lineups: { confirmed: players.length > 0, players } };
}

/** NBA-box score: "keys" talar om vad varje kolumn är; "3-7" = gjorda-försök. */
const NBA_KEYS: Record<string, string[]> = {
  minutes: ["secondsPlayed"],
  points: ["points"],
  rebounds: ["rebounds"],
  assists: ["assists"],
  steals: ["steals"],
  blocks: ["blocks"],
  turnovers: ["turnovers"],
  offensiveRebounds: ["offensiveRebounds"],
  defensiveRebounds: ["defensiveRebounds"],
  "fieldGoalsMade-fieldGoalsAttempted": ["fieldGoalsMade", "fieldGoalAttempts"],
  "threePointFieldGoalsMade-threePointFieldGoalsAttempted": ["threePointsMade", "threePointAttempts"],
  "freeThrowsMade-freeThrowsAttempted": ["freeThrowsMade", "freeThrowAttempts"],
};

export function parseEspnNbaSummary(json: unknown): { lineups: Lineups } {
  const j = obj(json);
  const sides = sidesById(j);
  const players: PlayerLine[] = [];
  for (const block of arr(obj(j.boxscore).players).map(obj)) {
    const side = sides.get(toNum(obj(block.team).id) ?? NaN);
    if (!side) continue;
    for (const table of arr(block.statistics).map(obj)) {
      const keys = arr(table.keys).map((k) => String(k));
      for (const ath of arr(table.athletes).map(obj)) {
        const a = obj(ath.athlete);
        const playerId = toNum(a.id);
        const name = str(a.displayName);
        if (playerId == null || !name) continue;
        const values = arr(ath.stats).map((v) => String(v));
        const stats: Record<string, number> = {};
        keys.forEach((key, i) => {
          const targets = NBA_KEYS[key];
          const v = values[i];
          if (!targets || v == null) return;
          const parts = v.split("-").map((x) => parseFloat(x));
          targets.forEach((t, k) => {
            const n = targets.length === 1 ? parseFloat(v) : parts[k];
            if (Number.isFinite(n)) stats[t] = t === "secondsPlayed" ? n * 60 : n;
          });
        });
        const played = ath.didNotPlay !== true && values.length > 0;
        players.push({ playerId, name, shortName: str(a.shortName), side, substitute: ath.starter !== true, played, stats });
      }
    }
  }
  return { lineups: { confirmed: players.length > 0, players } };
}
