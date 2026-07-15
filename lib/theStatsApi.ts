// Thin client for TheStatsAPI (https://www.thestatsapi.com/).
// Football fixtures, historical odds (opening + last_seen closing lines), and player props.

const BASE = "https://api.thestatsapi.com/api";

export function hasTheStatsApiKey(): boolean {
  return !!process.env.THESTATSAPI_KEY;
}

function key(): string {
  const k = process.env.THESTATSAPI_KEY;
  if (!k) throw new Error("THESTATSAPI_KEY is not set in .env.local");
  return k;
}

export class TheStatsApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "TheStatsApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface PaginationMeta {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface StatsTeam {
  id: string;
  name: string;
  short_name?: string;
  country?: string;
}

export interface StatsCompetition {
  id: string;
  name: string;
  country?: string;
  type?: string;
  odds_available?: boolean;
}

export interface StatsMatch {
  id: string;
  competition_id: string;
  season_id?: string;
  matchday?: number;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled";
  utc_date: string;
  home_team: StatsTeam;
  away_team: StatsTeam;
  odds_available?: boolean;
  score?: {
    home?: number;
    away?: number;
    regulation?: { home: number; away: number };
    went_to_extra_time?: boolean;
    went_to_penalties?: boolean;
    winner?: string;
  };
}

export interface OddsValue {
  opening: string | null;
  last_seen: string;
}

export interface OverUnderOdds {
  over?: OddsValue;
  under?: OddsValue;
}

export interface MatchOddsMarkets {
  match_odds?: {
    home?: OddsValue;
    draw?: OddsValue;
    away?: OddsValue;
  };
  btts?: {
    yes?: OddsValue;
    no?: OddsValue;
  };
  total_goals?: Record<string, OverUnderOdds>;
  match_corners?: Record<string, OverUnderOdds>;
  asian_handicap?: {
    home?: Record<string, OddsValue>;
    away?: Record<string, OddsValue>;
  };
}

export interface BookmakerMatchOdds {
  bookmaker: string;
  markets: MatchOddsMarkets;
}

export interface MatchOddsResponse {
  match_id: string;
  bookmakers: BookmakerMatchOdds[];
}

export type PlayerPropMarket =
  | "anytime_goalscorer"
  | "first_goalscorer"
  | "player_shots"
  | "player_shots_on_target"
  | "player_assists";

export interface MatchPlayerOddsEntry {
  id: string | null;
  name: string;
  line: number | null;
  market_type: "Over" | "Under" | null;
  odd: number;
}

export interface MatchPlayerOddsMarket {
  name: PlayerPropMarket;
  players: MatchPlayerOddsEntry[];
}

export interface MatchPlayerOddsResponse {
  match_id: string;
  home_team: StatsTeam;
  away_team: StatsTeam;
  kickoff_at: string;
  bookmaker: string;
  markets: MatchPlayerOddsMarket[];
}

interface ApiList<T> {
  data: T[];
  meta?: PaginationMeta;
}

interface ApiSingle<T> {
  data: T;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; status_code?: number };
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    cache: "no-store",
    headers: { Authorization: `Bearer ${key()}` },
  });

  const body = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!res.ok) {
    const err = body.error;
    throw new TheStatsApiError(
      res.status,
      err?.code ?? "api_error",
      err?.message ?? `TheStatsAPI ${res.status}`
    );
  }
  return body;
}

/** TheStatsAPI match ids are prefixed with `mt_`. */
export function isStatsApiMatchRef(ref: string | null | undefined): boolean {
  return !!ref && ref.startsWith("mt_");
}

/** sportKey stored on bets linked via TheStatsAPI. */
export function statsApiSportKey(competitionId: string): string {
  return `tsa:${competitionId}`;
}

export function isStatsApiSportKey(sportKey: string | null | undefined): boolean {
  return !!sportKey && sportKey.startsWith("tsa:");
}

export function searchTeams(search: string, opts?: { perPage?: number }): Promise<StatsTeam[]> {
  return get<ApiList<StatsTeam>>("/football/teams", {
    search,
    per_page: String(opts?.perPage ?? 20),
  }).then((r) => r.data);
}

export function searchCompetitions(search: string): Promise<StatsCompetition[]> {
  return get<ApiList<StatsCompetition>>("/football/competitions", {
    search,
    per_page: "20",
  }).then((r) => r.data);
}

export interface ListMatchesParams {
  competitionId?: string;
  seasonId?: string;
  teamId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: StatsMatch["status"];
  page?: number;
  perPage?: number;
}

export function listMatches(params: ListMatchesParams = {}): Promise<ApiList<StatsMatch>> {
  const q: Record<string, string> = {
    page: String(params.page ?? 1),
    per_page: String(params.perPage ?? 50),
  };
  if (params.competitionId) q.competition_id = params.competitionId;
  if (params.seasonId) q.season_id = params.seasonId;
  if (params.teamId) q.team_id = params.teamId;
  if (params.dateFrom) q.date_from = params.dateFrom;
  if (params.dateTo) q.date_to = params.dateTo;
  if (params.status) q.status = params.status;
  return get<ApiList<StatsMatch>>("/football/matches", q);
}

export async function listAllMatches(params: ListMatchesParams): Promise<StatsMatch[]> {
  const all: StatsMatch[] = [];
  let page = 1;
  for (;;) {
    const res = await listMatches({ ...params, page, perPage: 100 });
    all.push(...res.data);
    const totalPages = res.meta?.total_pages ?? 1;
    if (page >= totalPages || res.data.length === 0) break;
    page += 1;
  }
  return all;
}

export function getMatch(matchId: string): Promise<StatsMatch> {
  return get<ApiSingle<StatsMatch>>(`/football/matches/${matchId}`).then((r) => r.data);
}

export function getMatchOdds(matchId: string): Promise<MatchOddsResponse> {
  return get<ApiSingle<MatchOddsResponse>>(`/football/matches/${matchId}/odds`).then((r) => r.data);
}

export function getPlayerPropOdds(
  matchId: string,
  opts?: { markets?: PlayerPropMarket[]; bookmaker?: "bet365" }
): Promise<MatchPlayerOddsResponse> {
  const q: Record<string, string> = {};
  if (opts?.markets?.length) q.markets = opts.markets.join(",");
  if (opts?.bookmaker) q.bookmaker = opts.bookmaker;
  return get<ApiSingle<MatchPlayerOddsResponse>>(`/football/matches/${matchId}/odds/players`, q).then(
    (r) => r.data
  );
}

/** Parse a decimal odds string from the API into a number. */
export function parseOddsValue(value: OddsValue | undefined | null, useClosing = true): number | null {
  if (!value) return null;
  const raw = useClosing ? value.last_seen : value.opening;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/** Map app bookmaker names to TheStatsAPI bookmaker labels. */
export function statsApiBookmakerName(bookmaker: string | null | undefined): string | null {
  if (!bookmaker) return null;
  const b = bookmaker.toLowerCase();
  if (b.includes("pinnacle")) return "Pinnacle";
  if (b.includes("bet365") || b === "bet365") return "Bet365";
  if (b.includes("betfair")) return "Betfair Exchange";
  if (b.includes("kambi") || b.includes("unibet") || b.includes("betsson")) return "Kambi";
  return null;
}

/** Bookmaker priority: bet's own → Pinnacle → Bet365 → any. */
export function pickBookmakerOdds(
  bookmakers: BookmakerMatchOdds[],
  betBookmaker: string | null | undefined
): BookmakerMatchOdds | null {
  if (!bookmakers.length) return null;
  const preferred = [
    statsApiBookmakerName(betBookmaker),
    "Pinnacle",
    "Bet365",
  ].filter(Boolean) as string[];

  for (const name of preferred) {
    const hit = bookmakers.find((b) => b.bookmaker.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return bookmakers[0];
}
