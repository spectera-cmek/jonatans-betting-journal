// Free, keyless final-score lookup via ESPN's public scoreboard endpoints.
// No API key, no betting API — just the same JSON the espn.com site uses.
// Used to auto-grade future structured (h2h/totals/spreads) single bets from
// the real final score. Best-effort: only the leagues we can map + team-name
// matching that tolerates bet365's abbreviated "CITY Nick" naming.

const BASE = "https://site.api.espn.com/apis/site/v2/sports";

// "<sport>|<league>" -> ESPN scoreboard path. sport values match lib/constants
// SPORTS; league is what the user typed (case-insensitive). Extend as needed.
const LEAGUE_PATHS: Record<string, string> = {
  "basketball|nba": "basketball/nba",
  "ice hockey|nhl": "hockey/nhl",
  "baseball|mlb": "baseball/mlb",
  "american football|nfl": "football/nfl",
  // Best-effort soccer leagues (ESPN slugs).
  "football|premier league": "soccer/eng.1",
  "football|epl": "soccer/eng.1",
  "football|la liga": "soccer/esp.1",
  "football|serie a": "soccer/ita.1",
  "football|bundesliga": "soccer/ger.1",
  "football|ligue 1": "soccer/fra.1",
  "football|champions league": "soccer/uefa.champions",
  "football|allsvenskan": "soccer/swe.1",
  "football|vm 2026": "soccer/fifa.world",
};

/** Resolve a bet's sport+league to an ESPN scoreboard path, or null if unknown. */
export function espnPath(sport: string | null | undefined, league: string | null | undefined): string | null {
  if (!sport) return null;
  const key = `${sport.toLowerCase()}|${(league || "").toLowerCase()}`;
  if (LEAGUE_PATHS[key]) return LEAGUE_PATHS[key];
  // Fall back to sport-only for single-league sports.
  const sportOnly: Record<string, string> = {
    "basketball": "basketball/nba",
    "ice hockey": "hockey/nhl",
    "baseball": "baseball/mlb",
    "american football": "football/nfl",
  };
  return sportOnly[sport.toLowerCase()] ?? null;
}

interface EspnTeam {
  displayName?: string;
  shortDisplayName?: string;
  name?: string;
  abbreviation?: string;
}
interface EspnCompetitor {
  homeAway: "home" | "away";
  score?: string;
  shootoutScore?: string;
  team?: EspnTeam;
}
interface EspnEvent {
  id?: string;
  date?: string;
  status?: {
    type?: {
      completed?: boolean;
      name?: string;
      detail?: string;
      shortDetail?: string;
    };
  };
  competitions?: { competitors?: EspnCompetitor[] }[];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does an ESPN team match the name on the bet? Tolerates abbreviations by also
 * comparing the trailing nickname token ("SA Spurs" ~ "San Antonio Spurs").
 */
export function teamMatches(betName: string, team: EspnTeam | undefined): boolean {
  if (!betName || !team) return false;
  const b = norm(betName);
  if (!b) return false;
  const bLast = b.split(" ").pop()!;
  const candidates = [team.displayName, team.shortDisplayName, team.name, team.abbreviation]
    .filter(Boolean)
    .map((s) => norm(s as string));
  return candidates.some((c) => {
    if (!c) return false;
    if (c === b || c.includes(b) || b.includes(c)) return true;
    const cLast = c.split(" ").pop()!;
    return cLast === bLast; // nickname match
  });
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export interface FinalScore {
  homeScore: number;
  awayScore: number;
  wentToExtraTime?: boolean;
}

/**
 * Look up a finished game's score. Searches the event's day (and the next day,
 * to cover late games crossing midnight / timezones). Returns null if the game
 * isn't found or isn't completed yet.
 */
export async function fetchFinalScore(
  path: string,
  eventAt: Date,
  homeTeam: string,
  awayTeam: string,
  eventRef?: string | null
): Promise<FinalScore | null> {
  const days = [eventAt, new Date(eventAt.getTime() + 24 * 3600 * 1000), new Date(eventAt.getTime() - 24 * 3600 * 1000)];
  for (const day of days) {
    let events: EspnEvent[];
    try {
      const res = await fetch(`${BASE}/${path}/scoreboard?dates=${ymd(day)}`, { cache: "no-store" });
      if (!res.ok) continue;
      const json = (await res.json()) as { events?: EspnEvent[] };
      events = json.events ?? [];
    } catch {
      continue;
    }

    for (const ev of events) {
      if (eventRef && ev.id !== eventRef) continue;
      const comp = ev.competitions?.[0];
      const competitors = comp?.competitors ?? [];
      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");
      if (!home || !away) continue;

      // Match either orientation (some feeds/leagues flip home/away vs the book).
      const direct = teamMatches(homeTeam, home.team) && teamMatches(awayTeam, away.team);
      const swapped = teamMatches(homeTeam, away.team) && teamMatches(awayTeam, home.team);
      if (!direct && !swapped) continue;
      if (!ev.status?.type?.completed) return null; // found but not finished

      const hs = Number(home.score);
      const as = Number(away.score);
      if (Number.isNaN(hs) || Number.isNaN(as)) return null;
      const statusText = `${ev.status.type.name ?? ""} ${ev.status.type.detail ?? ""} ${ev.status.type.shortDetail ?? ""}`;
      const wentToExtraTime =
        /after extra time|\baet\b|penalt|\bft-pens?\b/i.test(statusText) ||
        home.shootoutScore !== undefined ||
        away.shootoutScore !== undefined;
      return direct
        ? { homeScore: hs, awayScore: as, wentToExtraTime }
        : { homeScore: as, awayScore: hs, wentToExtraTime };
    }
  }
  return null;
}
