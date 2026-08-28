// Auto-link bets to The Odds API events for auto-grading and CLV capture.
// Matches on sport/league → sportKey, team names and kickoff time.

import type { PrismaClient } from "@prisma/client";
import { splitTeams } from "./categorize";
import { VM_2026_LEAGUE } from "./betTaxonomy";
import { getOdds, hasOddsApiKey, type OddsEvent } from "./oddsApi";

/** sport|league (lowercase) → The Odds API sport_key */
const LEAGUE_KEYS: Record<string, string> = {
  "football|premier league": "soccer_epl",
  "football|epl": "soccer_epl",
  "football|la liga": "soccer_spain_la_liga",
  "football|serie a": "soccer_italy_serie_a",
  "football|bundesliga": "soccer_germany_bundesliga",
  "football|ligue 1": "soccer_france_ligue_one",
  "football|champions league": "soccer_uefa_champs_league",
  "football|allsvenskan": "soccer_sweden_allsvenskan",
  "football|vm 2026": "soccer_fifa_world_cup",
  "fotboll|premier league": "soccer_epl",
  "fotboll|allsvenskan": "soccer_sweden_allsvenskan",
  "fotboll|vm 2026": "soccer_fifa_world_cup",
  "basketball|nba": "basketball_nba",
  "basket|nba": "basketball_nba",
  "basketball|wnba": "basketball_wnba",
  "basket|wnba": "basketball_wnba",
  "ice hockey|nhl": "icehockey_nhl",
  "ishockey|nhl": "icehockey_nhl",
  "baseball|mlb": "baseball_mlb",
  "american football|nfl": "americanfootball_nfl",
  // Tennis saknar generell nyckel — se kommentaren vid inferSportKey.
  "mma|ufc": "mma_mixed_martial_arts",
};

/** Single-league sports when league is omitted. */
const SPORT_ONLY_KEYS: Record<string, string> = {
  basketball: "basketball_nba",
  basket: "basketball_nba",
  "ice hockey": "icehockey_nhl",
  ishockey: "icehockey_nhl",
  baseball: "baseball_mlb",
  "american football": "americanfootball_nfl",
  mma: "mma_mixed_martial_arts",
  ufc: "mma_mixed_martial_arts",
};

function normalizeSportLabel(sport: string): string {
  const s = sport.toLowerCase().trim();
  if (s === "fotboll" || s === "soccer") return "football";
  if (s === "ishockey") return "ice hockey";
  if (s === "basket") return "basketball";
  if (s === "amerikansk fotboll") return "american football";
  return s;
}

/** Infer The Odds API sport_key from stored sport + league. */
export function inferSportKey(
  sport: string | null | undefined,
  league: string | null | undefined
): string | null {
  if (!sport) return null;
  const sportNorm = normalizeSportLabel(sport);
  const leagueNorm = (league || "").toLowerCase();
  const key = `${sportNorm}|${leagueNorm}`;
  if (LEAGUE_KEYS[key]) return LEAGUE_KEYS[key];
  // Also try raw sport label for Swedish keys already in LEAGUE_KEYS.
  const rawKey = `${sport.toLowerCase()}|${leagueNorm}`;
  if (LEAGUE_KEYS[rawKey]) return LEAGUE_KEYS[rawKey];
  if (leagueNorm === VM_2026_LEAGUE.toLowerCase()) return "soccer_fifa_world_cup";
  if (leagueNorm.includes("wnba")) return "basketball_wnba";
  if (leagueNorm.includes("ufc") || sportNorm === "mma") return "mma_mixed_martial_arts";
  // Tennis har ingen generell nyckel hos The Odds API — bara en per turnering
  // ("tennis_atp_us_open" osv.), och de flesta står som inactive utanför sin
  // vecka. "tennis_atp"/"tennis_wta" som fanns här gav 404 UNKNOWN_SPORT på
  // varje anrop, både för rättning och CLV. Null är ärligare: ingen täckning.
  if (sportNorm === "tennis") return null;
  return SPORT_ONLY_KEYS[sportNorm] ?? SPORT_ONLY_KEYS[sport.toLowerCase()] ?? null;
}

/** Bokstäver som inte faller isär av NFD men ändå skrivs om av engelska API:er. */
const LETTER_FOLDS: Record<string, string> = {
  ø: "o", æ: "ae", œ: "oe", ß: "ss", đ: "d", ð: "d", þ: "th", ł: "l", ı: "i",
};

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[øæœßðþłı]|đ/g, (c) => LETTER_FOLDS[c] ?? c)
    // Fäll ihop diakriter innan skiljetecken städas bort. Utan det blir
    // "Västerås SK" till "v ster s sk" och matchar aldrig API:ets "Vasteras SK".
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does a bet team name match an Odds API team label? */
export function teamNameMatches(betName: string, apiName: string): boolean {
  if (!betName || !apiName) return false;
  const b = norm(betName);
  const a = norm(apiName);
  if (!b || !a) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const bLast = b.split(" ").pop()!;
  const aLast = a.split(" ").pop()!;
  return bLast.length >= 3 && aLast === bLast;
}

/** Parse home/away from an event string. "@" = away @ home; "vs" = home vs away. */
export function parseHomeAway(event: string): { home: string; away: string } | null {
  const e = event.trim();
  if (!e) return null;
  if (/ @ /.test(e)) {
    const [away, home] = splitTeams(e);
    if (away && home) return { home, away };
  }
  if (/ vs /i.test(e) || / v /.test(e)) {
    const [home, away] = splitTeams(e);
    if (home && away) return { home, away };
  }
  // "Home – Away" (en-dash from event search UI)
  if (/[–—]/.test(e)) {
    const [home, away] = e.split(/[–—]/).map((s) => s.trim());
    if (home && away) return { home, away };
  }
  // "Home - Away" — så skrivs matcherna i flera av importerna. Bindestrecket
  // måste ha mellanslag omkring sig, annars delas Saint-Étienne mitt itu.
  if (/ - /.test(e)) {
    const [home, away] = e.split(/ - /).map((s) => s.trim());
    if (home && away) return { home, away };
  }
  return null;
}

export interface LinkableBet {
  id: string;
  event: string;
  homeTeam?: string | null;
  awayTeam?: string | null;
  eventAt?: Date | null;
  sport?: string | null;
  league?: string | null;
  sportKey?: string | null;
  externalRef?: string | null;
}

/** The fields matching needs — live and historical events both satisfy this. */
export type MatchableEvent = Pick<
  OddsEvent,
  "id" | "home_team" | "away_team" | "commence_time"
>;

/** Find the single best Odds API event for a bet, or null if ambiguous/unmatched. */
export function matchOddsEvent<T extends MatchableEvent>(
  bet: Pick<LinkableBet, "homeTeam" | "awayTeam" | "eventAt" | "event">,
  events: T[]
): T | null {
  let home = bet.homeTeam?.trim() || "";
  let away = bet.awayTeam?.trim() || "";
  if (!home || !away) {
    const parsed = parseHomeAway(bet.event);
    if (parsed) {
      home = parsed.home;
      away = parsed.away;
    }
  }
  if (!home || !away) return null;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const betTime = bet.eventAt ? new Date(bet.eventAt).getTime() : null;

  const candidates = events.filter((ev) => {
    const direct =
      teamNameMatches(home, ev.home_team) && teamNameMatches(away, ev.away_team);
    const swapped =
      teamNameMatches(home, ev.away_team) && teamNameMatches(away, ev.home_team);
    if (!direct && !swapped) return false;
    if (betTime == null) return true;
    const commence = new Date(ev.commence_time).getTime();
    return Math.abs(commence - betTime) <= 2 * DAY_MS;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple fixtures (e.g. cup replay) — pick closest kickoff.
  if (betTime != null) {
    candidates.sort(
      (a, b) =>
        Math.abs(new Date(a.commence_time).getTime() - betTime) -
        Math.abs(new Date(b.commence_time).getTime() - betTime)
    );
    const best = candidates[0];
    const second = candidates[1];
    const gap =
      Math.abs(new Date(best.commence_time).getTime() - betTime) -
      Math.abs(new Date(second.commence_time).getTime() - betTime);
    if (gap >= 6 * 60 * 60 * 1000) return best; // clear winner (6h+ closer)
  }
  return null; // ambiguous
}

export interface LinkResult {
  linked: boolean;
  externalRef?: string;
  sportKey?: string;
  homeTeam?: string;
  awayTeam?: string;
  eventAt?: Date;
}

/** Try to link one bet to an Odds API event. Updates the row on success. */
export async function linkBetToOddsEvent(
  prisma: PrismaClient,
  bet: LinkableBet,
  eventsCache?: Map<string, OddsEvent[]>
): Promise<LinkResult> {
  if (!hasOddsApiKey()) return { linked: false };
  if (bet.externalRef && bet.sportKey) return { linked: false };

  const sportKey = bet.sportKey || inferSportKey(bet.sport, bet.league);
  if (!sportKey) return { linked: false };

  let events = eventsCache?.get(sportKey);
  if (!events) {
    try {
      events = await getOdds(sportKey, { markets: "h2h" });
      eventsCache?.set(sportKey, events);
    } catch {
      return { linked: false };
    }
  }

  const match = matchOddsEvent(bet, events);
  if (!match) return { linked: false };

  const parsed = parseHomeAway(bet.event);
  const homeTeam = bet.homeTeam || parsed?.home || match.home_team;
  const awayTeam = bet.awayTeam || parsed?.away || match.away_team;
  const eventAt = bet.eventAt ?? new Date(match.commence_time);

  await prisma.bet.update({
    where: { id: bet.id },
    data: {
      externalRef: match.id,
      sportKey,
      homeTeam,
      awayTeam,
      eventAt,
    },
  });

  return {
    linked: true,
    externalRef: match.id,
    sportKey,
    homeTeam,
    awayTeam,
    eventAt,
  };
}
