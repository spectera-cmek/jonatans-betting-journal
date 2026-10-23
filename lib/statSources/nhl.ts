// NHL:s officiella, öppna API (api-web.nhle.com) som statistikkälla för
// hockeyprops: skott på mål, mål, assists, poäng och räddningar per spelare.
// Ingen nyckel, ingen skrapning. Gäller bara NHL — andra ligor (SHL m.fl.)
// går till nästa källa.
//
// Spelarnamnen är förkortade ("A. Matthews"); findPlayer i propsGrading.ts
// matchar efternamn + initial.

import type { Lineups, MatchEvent, MatchStatus, PlayerLine, StatPair } from "../matchData";

export const NHL_API = "https://api-web.nhle.com/v1";

export const nhlUrls = {
  /** Alla matcher en dag (YYYY-MM-DD, lokal NHL-dag). */
  score: (date: string) => `${NHL_API}/score/${date}`,
  boxscore: (gameId: number) => `${NHL_API}/gamecenter/${gameId}/boxscore`,
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
/** NHL skriver lokaliserade namn som {"default": "Sabres", "fr": …}. */
const loc = (v: unknown): string | null => str(obj(v).default) ?? str(v);

export function nhlStatus(gameState: unknown, scheduleState: unknown): MatchStatus {
  const sched = String(scheduleState ?? "");
  if (sched === "PPD" || sched === "SUSP") return "postponed";
  if (sched === "CNCL") return "cancelled";
  switch (String(gameState ?? "")) {
    case "OFF":
    case "FINAL":
      return "finished";
    case "LIVE":
    case "CRIT":
      return "live";
    default:
      return "scheduled";
  }
}

function teamName(t: Json): string | null {
  const nick = loc(t.commonName) ?? loc(t.name);
  const place = loc(t.placeName);
  if (!nick) return null;
  return place && !nick.includes(place) ? `${place} ${nick}` : nick;
}

function parseGame(g: Json): MatchEvent | null {
  const id = num(g.id);
  const start = str(g.startTimeUTC);
  const h = obj(g.homeTeam);
  const a = obj(g.awayTeam);
  const hName = teamName(h);
  const aName = teamName(a);
  const hId = num(h.id);
  const aId = num(a.id);
  if (id == null || !start || !hName || !aName || hId == null || aId == null) return null;
  const hs = num(h.score);
  const as = num(a.score);
  const regulation = str(obj(g.gameOutcome).lastPeriodType) === "REG";
  return {
    id,
    startAt: new Date(start),
    status: nhlStatus(g.gameState, g.gameScheduleState),
    statusDescription: str(obj(g.gameOutcome).lastPeriodType),
    homeTeam: { id: hId, name: hName, shortName: str(h.abbrev) },
    awayTeam: { id: aId, name: aName, shortName: str(a.abbrev) },
    // Resultat efter ordinarie tid bara när matchen avgjordes där.
    homeScore: regulation ? hs : null,
    awayScore: regulation ? as : null,
    homeScoreFinal: hs,
    awayScoreFinal: as,
    tournamentName: "NHL",
    uniqueTournamentId: null,
    seasonId: null,
    round: null,
  };
}

/** /score/{datum} → dagens matcher. */
export function parseNhlScore(json: unknown): MatchEvent[] {
  return arr(obj(json).games)
    .map((g) => parseGame(obj(g)))
    .filter((e): e is MatchEvent => e !== null);
}

/** "21:21" → 1281 sekunder. */
export function toiSeconds(toi: unknown): number | null {
  const m = String(toi ?? "").match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** NHL:s fält → de gemensamma namnen. */
const SKATER_KEYS: Record<string, string> = {
  goals: "goals",
  assists: "assists",
  points: "points",
  sog: "shotsOnGoal",
  hits: "hits",
  blockedShots: "blockedShots",
  pim: "penaltyMinutes",
};
const GOALIE_KEYS: Record<string, string> = {
  saves: "saves",
  goalsAgainst: "goalsAgainst",
  shotsAgainst: "shotsAgainst",
};

/** /gamecenter/{id}/boxscore → lagens skott och spelarna. */
export function parseNhlBoxscore(json: unknown): { stats: Record<string, StatPair> | null; lineups: Lineups } {
  const j = obj(json);
  const hSog = num(obj(j.homeTeam).sog);
  const aSog = num(obj(j.awayTeam).sog);
  const stats = hSog != null && aSog != null ? { shotsOnGoal: { home: hSog, away: aSog } } : null;

  const players: PlayerLine[] = [];
  const byGame = obj(j.playerByGameStats);
  for (const [side, key] of [
    ["home", "homeTeam"],
    ["away", "awayTeam"],
  ] as const) {
    const t = obj(byGame[key]);
    for (const [group, map] of [
      ["forwards", SKATER_KEYS],
      ["defense", SKATER_KEYS],
      ["goalies", GOALIE_KEYS],
    ] as const) {
      for (const p of arr(t[group]).map(obj)) {
        const playerId = num(p.playerId);
        const name = loc(p.name);
        if (playerId == null || !name) continue;
        const stats: Record<string, number> = {};
        for (const [from, to] of Object.entries(map)) {
          const v = num(p[from]);
          if (v != null) stats[to] = v;
        }
        const toi = toiSeconds(p.toi);
        if (toi != null) stats.timeOnIce = toi;
        players.push({ playerId, name, shortName: name, side, substitute: false, played: (toi ?? 0) > 0, stats });
      }
    }
  }
  return { stats, lineups: { confirmed: players.length > 0, players } };
}
