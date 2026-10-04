// Validering av en inmatad bokmakarlinje (POST /api/cs2/lines).

import type { Cs2Market, Cs2Scope } from "./types";
import { PLAYER_MARKETS, TOTAL_MARKETS } from "./types";

export const MARKETS: Cs2Market[] = [
  "kills",
  "headshots",
  "rounds",
  "map_handicap",
  "map_winner",
  "match_winner",
  "match_handicap",
  "total_maps",
  "pistol",
  "first_kill",
  "player_first_kill",
];
export const SCOPES: Cs2Scope[] = ["map1", "map2", "map3", "maps12", "match"];

export interface ValidLine {
  matchId: number;
  market: Cs2Market;
  scope: Cs2Scope;
  playerId: number | null;
  teamId: number | null;
  line: number | null;
  overOdds: number | null;
  underOdds: number | null;
  includesOt: boolean;
  bookmaker: string | null;
  source: string;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export function validateLine(body: Record<string, unknown>): ValidLine | string {
  const matchId = num(body.matchId);
  if (matchId == null || !Number.isInteger(matchId)) return "matchId saknas";
  const market = String(body.market ?? "") as Cs2Market;
  if (!MARKETS.includes(market)) return "Okänd marknad";
  const scope = String(body.scope ?? "") as Cs2Scope;
  if (!SCOPES.includes(scope)) return "Okänt scope";
  const playerId = num(body.playerId);
  const teamId = num(body.teamId);
  if (PLAYER_MARKETS.has(market) && playerId == null) return "Marknaden kräver en spelare";
  const line = num(body.line);
  if ((TOTAL_MARKETS.has(market) || market === "map_handicap" || market === "match_handicap") && line == null) return "Marknaden kräver en linje";
  const overOdds = num(body.overOdds);
  const underOdds = num(body.underOdds);
  if (overOdds == null && underOdds == null) return "Ange minst ett odds";
  for (const o of [overOdds, underOdds]) if (o != null && (o <= 1 || o > 1000)) return "Odds måste vara decimalodds över 1";
  return {
    matchId,
    market,
    scope,
    playerId,
    teamId,
    line,
    overOdds,
    underOdds,
    includesOt: body.includesOt === false ? false : true,
    bookmaker: body.bookmaker ? String(body.bookmaker).slice(0, 60) : null,
    source: body.source === "screenshot" ? "screenshot" : "manual",
  };
}
