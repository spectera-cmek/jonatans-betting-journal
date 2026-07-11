import {
  TOURNAMENT_STAGE_LABELS,
  normalizeTournamentStage,
  type TournamentStage,
} from "./betTaxonomy";

const SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=2026&limit=200";
const STANDINGS_URL =
  "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026";

export interface WorldCupTeam {
  id: string;
  name: string;
  abbreviation: string;
  logo: string | null;
}

export interface WorldCupMatch {
  id: string;
  startsAt: string;
  stage: TournamentStage | null;
  stageLabel: string;
  group: string | null;
  status: "scheduled" | "live" | "final";
  statusText: string;
  completed: boolean;
  home: WorldCupTeam;
  away: WorldCupTeam;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
  wentToExtraTime: boolean;
}

export interface WorldCupStanding {
  position: number;
  team: WorldCupTeam;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  goalDifference: number;
}

export interface WorldCupGroup {
  id: string;
  name: string;
  standings: WorldCupStanding[];
}

export interface WorldCupPhase {
  stage: TournamentStage;
  label: string;
  detail: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

export interface WorldCupData {
  ok: boolean;
  stale: boolean;
  fetchedAt: string;
  currentStage: TournamentStage | null;
  phases: WorldCupPhase[];
  matches: WorldCupMatch[];
  groups: WorldCupGroup[];
  error?: string;
}

interface EspnTeam {
  id?: string;
  displayName?: string;
  shortDisplayName?: string;
  abbreviation?: string;
  logo?: string;
  logos?: { href?: string }[];
}

interface EspnCompetitor {
  homeAway?: "home" | "away";
  score?: string;
  shootoutScore?: string;
  team?: EspnTeam;
}

interface EspnEvent {
  id?: string;
  date?: string;
  season?: { slug?: string };
  status?: {
    type?: {
      state?: string;
      completed?: boolean;
      detail?: string;
      shortDetail?: string;
      description?: string;
      name?: string;
    };
  };
  competitions?: {
    competitors?: EspnCompetitor[];
    status?: EspnEvent["status"];
    venue?: { fullName?: string };
    altGameNote?: string;
    notes?: { headline?: string }[];
  }[];
  venue?: { displayName?: string };
}

interface EspnScoreboard {
  leagues?: {
    season?: { type?: { name?: string } };
    calendar?: {
      entries?: {
        label?: string;
        detail?: string;
        startDate?: string;
        endDate?: string;
      }[];
    }[];
  }[];
  events?: EspnEvent[];
}

interface EspnStandingEntry {
  team?: EspnTeam;
  stats?: { name?: string; value?: number; displayValue?: string }[];
}

interface EspnStandings {
  children?: {
    id?: string;
    name?: string;
    standings?: { entries?: EspnStandingEntry[] };
  }[];
}

let lastGood: WorldCupData | null = null;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function teamOf(team: EspnTeam | undefined): WorldCupTeam {
  return {
    id: team?.id ?? "",
    name: team?.displayName ?? team?.shortDisplayName ?? "TBD",
    abbreviation: team?.abbreviation ?? "TBD",
    logo: team?.logo ?? team?.logos?.[0]?.href ?? null,
  };
}

function stageFromEvent(event: EspnEvent): TournamentStage | null {
  const competition = event.competitions?.[0];
  return (
    normalizeTournamentStage(event.season?.slug) ??
    normalizeTournamentStage(competition?.altGameNote?.split(",").pop()?.trim()) ??
    null
  );
}

function groupFromEvent(event: EspnEvent): string | null {
  const note = event.competitions?.[0]?.altGameNote ?? "";
  const match = note.match(/\bGroup\s+([A-L])\b/i);
  return match ? `Grupp ${match[1].toUpperCase()}` : null;
}

function statusOf(event: EspnEvent) {
  const type = event.status?.type ?? event.competitions?.[0]?.status?.type;
  const state = type?.state;
  const completed = type?.completed === true;
  return {
    status: completed ? ("final" as const) : state === "in" ? ("live" as const) : ("scheduled" as const),
    completed,
    text: type?.shortDetail ?? type?.detail ?? type?.description ?? "Planerad",
    raw: `${type?.name ?? ""} ${type?.shortDetail ?? ""} ${type?.detail ?? ""}`,
  };
}

function parseMatches(scoreboard: EspnScoreboard): WorldCupMatch[] {
  return (scoreboard.events ?? [])
    .map((event): WorldCupMatch | null => {
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      const home = competitors.find((item) => item.homeAway === "home");
      const away = competitors.find((item) => item.homeAway === "away");
      if (!event.id || !event.date || !home || !away) return null;
      const status = statusOf(event);
      const stage = stageFromEvent(event);
      const extraText = `${status.raw} ${competition?.altGameNote ?? ""} ${(competition?.notes ?? []).map((n) => n.headline ?? "").join(" ")}`;
      const wentToExtraTime =
        /after extra time|\baet\b|penalt|straff|\bft-pens?\b/i.test(extraText) ||
        numberOrNull(home.shootoutScore) !== null ||
        numberOrNull(away.shootoutScore) !== null;
      return {
        id: event.id,
        startsAt: event.date,
        stage,
        stageLabel: stage ? TOURNAMENT_STAGE_LABELS[stage] : "VM-match",
        group: groupFromEvent(event),
        status: status.status,
        statusText: status.text,
        completed: status.completed,
        home: teamOf(home.team),
        away: teamOf(away.team),
        homeScore: status.completed || status.status === "live" ? numberOrNull(home.score) : null,
        awayScore: status.completed || status.status === "live" ? numberOrNull(away.score) : null,
        venue: competition?.venue?.fullName ?? event.venue?.displayName ?? null,
        wentToExtraTime,
      };
    })
    .filter((match): match is WorldCupMatch => match !== null)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

function stat(entry: EspnStandingEntry, ...names: string[]): number {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const value = entry.stats?.find((item) => item.name && wanted.has(item.name.toLowerCase()));
  return numberOrNull(value?.value ?? value?.displayValue) ?? 0;
}

function parseGroups(payload: EspnStandings): WorldCupGroup[] {
  return (payload.children ?? []).map((group) => ({
    id: group.id ?? group.name ?? "",
    name: (group.name ?? "Grupp").replace(/^Group/i, "Grupp"),
    standings: (group.standings?.entries ?? []).map((entry, index) => ({
      position: stat(entry, "rank", "position") || index + 1,
      team: teamOf(entry.team),
      played: stat(entry, "gamesPlayed", "gamesplayed"),
      wins: stat(entry, "wins"),
      draws: stat(entry, "ties", "draws"),
      losses: stat(entry, "losses"),
      points: stat(entry, "points"),
      goalDifference: stat(entry, "pointDifferential", "goalDifference", "pointdifferential"),
    })),
  }));
}

function parsePhases(scoreboard: EspnScoreboard): WorldCupPhase[] {
  const entries = scoreboard.leagues?.[0]?.calendar?.[0]?.entries ?? [];
  return entries
    .map((entry): WorldCupPhase | null => {
      const stage = normalizeTournamentStage(entry.label);
      if (!stage) return null;
      return {
        stage,
        label: TOURNAMENT_STAGE_LABELS[stage],
        detail: entry.detail ?? null,
        startsAt: entry.startDate ?? null,
        endsAt: entry.endDate ?? null,
      };
    })
    .filter((phase): phase is WorldCupPhase => phase !== null);
}

export async function fetchWorldCupData(): Promise<WorldCupData> {
  try {
    const [scoreboardResponse, standingsResponse] = await Promise.all([
      fetch(SCOREBOARD_URL, { next: { revalidate: 60 } }),
      fetch(STANDINGS_URL, { next: { revalidate: 300 } }),
    ]);
    if (!scoreboardResponse.ok) {
      throw new Error(`ESPN schema svarade ${scoreboardResponse.status}`);
    }
    const scoreboard = (await scoreboardResponse.json()) as EspnScoreboard;
    const standings = standingsResponse.ok
      ? ((await standingsResponse.json()) as EspnStandings)
      : ({ children: [] } as EspnStandings);
    const data: WorldCupData = {
      ok: true,
      stale: false,
      fetchedAt: new Date().toISOString(),
      currentStage:
        normalizeTournamentStage(scoreboard.leagues?.[0]?.season?.type?.name) ?? null,
      phases: parsePhases(scoreboard),
      matches: parseMatches(scoreboard),
      groups: parseGroups(standings),
    };
    lastGood = data;
    return data;
  } catch (error) {
    if (lastGood) {
      return {
        ...lastGood,
        ok: false,
        stale: true,
        error: (error as Error).message,
      };
    }
    return {
      ok: false,
      stale: true,
      fetchedAt: new Date().toISOString(),
      currentStage: null,
      phases: [],
      matches: [],
      groups: [],
      error: (error as Error).message,
    };
  }
}

function normalizedName(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameTeam(value: string | null | undefined, team: WorldCupTeam): boolean {
  if (!value) return false;
  const input = normalizedName(value);
  const candidates = [team.name, team.abbreviation].map(normalizedName);
  return candidates.some(
    (candidate) =>
      candidate === input ||
      (candidate.length >= 4 && input.includes(candidate)) ||
      (input.length >= 4 && candidate.includes(input))
  );
}

/** Match a legacy bet by structured teams/date when no ESPN event id exists. */
export function findWorldCupMatchForBet(
  bet: {
    eventAt?: string | Date | null;
    homeTeam?: string | null;
    awayTeam?: string | null;
    event: string;
  },
  matches: WorldCupMatch[]
): WorldCupMatch | null {
  const eventTime = bet.eventAt ? new Date(bet.eventAt).getTime() : null;
  const eventParts = bet.event.split(/\s+(?:vs?\.?|–|-|@)\s+/i);
  const homeName = bet.homeTeam ?? eventParts[0] ?? null;
  const awayName = bet.awayTeam ?? eventParts[1] ?? null;

  const candidates = matches.filter((match) => {
    if (eventTime !== null && Math.abs(Date.parse(match.startsAt) - eventTime) > 36 * 3600_000) {
      return false;
    }
    const direct = sameTeam(homeName, match.home) && sameTeam(awayName, match.away);
    const swapped = sameTeam(homeName, match.away) && sameTeam(awayName, match.home);
    return direct || swapped;
  });
  return candidates.length === 1 ? candidates[0] : null;
}
