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
  /** Per-period scores. In football, entry 0 is the first half. */
  linescores?: { value?: number }[];
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

/**
 * First-period score for one side, or null when the feed does not break the
 * game down by period.
 *
 * Null and zero are not interchangeable here: a nil-nil first half and a feed
 * that simply does not report periods look identical if you coerce, and the
 * second settles half-time unders that never won.
 */
function firstPeriod(c: EspnCompetitor | undefined): number | null {
  const v = c?.linescores?.[0]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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
  /** Half-time score when the feed breaks the game into periods. */
  homeHalfScore?: number | null;
  awayHalfScore?: number | null;
  /** ESPN's own event id, for a follow-up summary lookup (corners, scorers). */
  eventId?: string | null;
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
      const homeHalf = firstPeriod(home);
      const awayHalf = firstPeriod(away);
      const eventId = ev.id ?? null;
      return direct
        ? {
            homeScore: hs,
            awayScore: as,
            wentToExtraTime,
            homeHalfScore: homeHalf,
            awayHalfScore: awayHalf,
            eventId,
          }
        : {
            homeScore: as,
            awayScore: hs,
            wentToExtraTime,
            homeHalfScore: awayHalf,
            awayHalfScore: homeHalf,
            eventId,
          };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Match detail — corners, cards and goalscorers
//
// The scoreboard carries the score and the period breakdown; anything richer
// needs ESPN's summary endpoint, which is a second request per event. It is
// only worth making for bets that actually need it, so callers ask for it
// explicitly rather than it being folded into fetchFinalScore.
// ---------------------------------------------------------------------------

interface EspnStatistic {
  name?: string;
  abbreviation?: string;
  displayValue?: string;
}
interface EspnSummaryTeam {
  homeAway?: "home" | "away";
  team?: EspnTeam;
  statistics?: EspnStatistic[];
}
interface EspnSummaryPlayerEntry {
  athlete?: { displayName?: string; shortName?: string };
  /** ESPN marks own goals and penalties on the scoring play. */
  ownGoal?: boolean;
  penaltyKick?: boolean;
  scoringPlay?: boolean;
  clock?: { displayValue?: string };
}
interface EspnSummary {
  boxscore?: { teams?: EspnSummaryTeam[] };
  scoringPlays?: {
    type?: { text?: string };
    text?: string;
    clock?: { value?: number };
    team?: { id?: string };
    athletesInvolved?: { displayName?: string; shortName?: string }[];
  }[];
  keyEvents?: (EspnSummaryPlayerEntry & { type?: { text?: string } })[];
}

/** A statistic ESPN reports per team, keyed the way its box score names it. */
const STAT_KEYS = {
  corners: ["wonCorners", "corner kicks", "corners"],
  yellowCards: ["yellowCards", "yellow cards"],
  redCards: ["redCards", "red cards"],
} as const;

function statValue(team: EspnSummaryTeam | undefined, keys: readonly string[]): number | null {
  for (const s of team?.statistics ?? []) {
    const name = (s.name ?? "").toLowerCase();
    const abbr = (s.abbreviation ?? "").toLowerCase();
    if (!keys.some((k) => k.toLowerCase() === name || k.toLowerCase() === abbr)) continue;
    const n = Number(s.displayValue);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export interface MatchDetail {
  homeCorners: number | null;
  awayCorners: number | null;
  /** Yellow + red, since "Kort & fouls" lines are usually quoted on all cards. */
  homeCards: number | null;
  awayCards: number | null;
  /** Everyone credited with a goal, own goals excluded. */
  scorers: string[];
  /** First non-own goal scorer, or null when nobody scored. */
  firstScorer: string | null;
}

function sumOrNull(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Corners, cards and goalscorers for one finished match.
 *
 * Returns nulls rather than zeros for statistics the feed omits — a league
 * ESPN does not break down must not settle every "under" as a winner.
 */
export async function fetchMatchDetail(
  path: string,
  eventId: string
): Promise<MatchDetail | null> {
  let summary: EspnSummary;
  try {
    const res = await fetch(`${BASE}/${path}/summary?event=${encodeURIComponent(eventId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    summary = (await res.json()) as EspnSummary;
  } catch {
    return null;
  }

  const teams = summary.boxscore?.teams ?? [];
  const home = teams.find((t) => t.homeAway === "home");
  const away = teams.find((t) => t.homeAway === "away");

  const scorers: string[] = [];
  for (const play of summary.scoringPlays ?? []) {
    // Own goals credit the scorer to the other side; a goalscorer bet on them
    // does not pay, so they must not enter the list.
    const text = `${play.type?.text ?? ""} ${play.text ?? ""}`.toLowerCase();
    if (text.includes("own goal")) continue;
    for (const a of play.athletesInvolved ?? []) {
      const name = a.displayName || a.shortName;
      if (name) scorers.push(name);
    }
  }

  return {
    homeCorners: statValue(home, STAT_KEYS.corners),
    awayCorners: statValue(away, STAT_KEYS.corners),
    homeCards: sumOrNull(
      statValue(home, STAT_KEYS.yellowCards),
      statValue(home, STAT_KEYS.redCards)
    ),
    awayCards: sumOrNull(
      statValue(away, STAT_KEYS.yellowCards),
      statValue(away, STAT_KEYS.redCards)
    ),
    scorers,
    firstScorer: scorers[0] ?? null,
  };
}

/**
 * Did a named player score?
 *
 * Deliberately conservative: an exact or surname match against ESPN's own
 * spelling, and null — not false — when the feed listed no scorers at all,
 * because "nobody scored" and "we could not read the scorers" settle a
 * goalscorer bet in opposite directions.
 */
export function playerScored(detail: MatchDetail, player: string): boolean | null {
  if (!detail.scorers.length) return null;
  const want = norm(player);
  if (!want) return null;
  const wantLast = want.split(" ").pop()!;
  return detail.scorers.some((s) => {
    const got = norm(s);
    if (got === want || got.includes(want) || want.includes(got)) return true;
    const gotLast = got.split(" ").pop()!;
    return wantLast.length >= 3 && gotLast === wantLast;
  });
}
