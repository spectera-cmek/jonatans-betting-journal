// Kopplar en avläst rad ur bokens skärmdump till matchens spelare och lag,
// och avgör om raden kan sparas som en linje. Rent och testat — används av
// POST /api/cs2/lines/parse-screenshot och linjepanelen.

import { nameScore, normName } from "./demo/link";

/** Marknader som kräver en spelare / ett lag ("sida 1") för att kunna sparas. */
export const PLAYER_PROP_MARKETS = new Set<string>(["kills", "headshots", "player_first_kill"]);
export const TEAM_PROP_MARKETS = new Set<string>(["map_winner", "map_handicap", "match_winner", "match_handicap", "pistol", "first_kill"]);
const TOTAL_ONLY = new Set<string>(["rounds", "total_maps"]);

/** Vanliga kortnamn hos bokarna → HLTV:s namn (normaliserade). */
const TEAM_ALIASES: Record<string, string> = {
  navi: "natusvincere",
  mousesports: "mouz",
  vp: "virtuspro",
  faze: "fazeclan",
  liquid: "teamliquid",
  col: "complexity",
};

/** Bokens lagnamn innehåller ofta "Team", "Esports", "Gaming" som HLTV saknar (eller tvärtom). */
function teamKey(name: string): string {
  const k = normName(name.replace(/\b(team|esports?|gaming|club|e-?sports|clan)\b/gi, ""));
  return TEAM_ALIASES[k] ?? k;
}

/** Bästa lag för ett namn ur boken, eller null om inget passar. */
export function matchTeam(name: string | null | undefined, teams: Array<{ id: number; name: string }>): number | null {
  if (!name) return null;
  const key = teamKey(name);
  let best: { id: number; score: number } | null = null;
  for (const t of teams) {
    const k = teamKey(t.name);
    let score: number | null = key && k && key === k ? 0 : nameScore(key, k);
    if (score == null) score = nameScore(name, t.name);
    if (score != null && (!best || score < best.score)) best = { id: t.id, score };
  }
  return best?.id ?? null;
}

/**
 * Lagen för alla namn på en skärmdump. Känns bara det ena lagets namn igen
 * och ett annat namn står kvar, måste det vara motståndaren.
 */
export function matchTeams(names: Array<string | null>, teams: Array<{ id: number; name: string }>): Map<string, number> {
  const out = new Map<string, number>();
  const distinct = [...new Set(names.filter((n): n is string => !!n))];
  for (const n of distinct) {
    const id = matchTeam(n, teams);
    if (id != null) out.set(n, id);
  }
  const unknown = distinct.filter((n) => !out.has(n));
  const used = new Set(out.values());
  const free = teams.filter((t) => !used.has(t.id));
  if (unknown.length === 1 && free.length === 1 && used.size === 1) out.set(unknown[0], free[0].id);
  return out;
}

/** Bästa spelare för en nick ur boken, eller null. */
export function matchPlayer(name: string | null | undefined, players: Array<{ id: number; nickname: string }>): number | null {
  if (!name) return null;
  let best: { id: number; score: number } | null = null;
  for (const p of players) {
    const s = nameScore(name, p.nickname);
    if (s != null && (!best || s < best.score)) best = { id: p.id, score: s };
  }
  return best?.id ?? null;
}

/** Varför en rad inte kan sparas, eller null om den kan det. */
export function skipReason(row: { market: string; playerId: number | null; teamId: number | null; line: number | null; overOdds: number | null; underOdds: number | null }): string | null {
  if (row.market === "other") return "marknaden finns inte i modellen";
  if (PLAYER_PROP_MARKETS.has(row.market) && row.playerId == null) return "spelaren hittades inte i trupperna";
  if (TEAM_PROP_MARKETS.has(row.market) && row.teamId == null) return "laget kändes inte igen";
  const needsLine = row.market === "kills" || row.market === "headshots" || TOTAL_ONLY.has(row.market) || row.market.endsWith("_handicap");
  if (needsLine && row.line == null) return "linje saknas";
  if (row.overOdds == null && row.underOdds == null) return "odds saknas";
  return null;
}

