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

/** Betfair Exchange depth-of-book level. */
export interface ExchangePriceLevel {
  price: number;
  size: number;
}

export interface OddsValue {
  opening: string | null;
  last_seen: string;
  /** Betfair Exchange only — best price first. `last_seen` mirrors best back. */
  available_to_back?: ExchangePriceLevel[];
  available_to_lay?: ExchangePriceLevel[];
}

export interface OverUnderOdds {
  over?: OddsValue;
  under?: OddsValue;
}

/** Per-team over/under lines, keyed by line string ("9.5"). */
export interface TeamOverUnderLines {
  home?: Record<string, OverUnderOdds>;
  away?: Record<string, OverUnderOdds>;
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
  match_shots?: Record<string, OverUnderOdds>;
  match_shots_on_target?: Record<string, OverUnderOdds>;
  team_corners?: TeamOverUnderLines;
  team_shots?: TeamOverUnderLines;
  team_shots_on_target?: TeamOverUnderLines;
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

export interface StatsSeason {
  id: string;
  name: string;
  year: string;
  start_year?: number;
  end_year?: number;
  is_current?: boolean;
}

/** Säsonger för en liga, nyaste först. */
export function listSeasons(competitionId: string): Promise<StatsSeason[]> {
  return get<ApiList<StatsSeason>>(`/football/competitions/${competitionId}/seasons`).then((r) => r.data);
}

export interface ListMatchesParams {
  competitionId?: string;
  seasonId?: string;
  teamId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: StatsMatch["status"];
  /** "regular" utesluter slutspel/cupmatcher inom ligan. */
  stage?: "regular" | "playoff" | "all";
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
  if (params.stage) q.stage = params.stage;
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

export function getMatchOdds(
  matchId: string,
  opts?: { bookmakers?: StatsApiBookmakerSlug[] }
): Promise<MatchOddsResponse> {
  const q: Record<string, string> = {};
  if (opts?.bookmakers?.length) q.bookmaker = opts.bookmakers.join(",");
  return get<ApiSingle<MatchOddsResponse>>(`/football/matches/${matchId}/odds`, q).then((r) => r.data);
}

export function getMatchStats(matchId: string): Promise<MatchStats> {
  return get<ApiSingle<MatchStats>>(`/football/matches/${matchId}/stats`).then((r) => r.data);
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

// ---------------------------------------------------------------------------
// Skottmodellen — matchstatistik och skott-/hörnmarknader
// ---------------------------------------------------------------------------

/** Bookmaker-slugs som `?bookmaker=` accepterar. */
export type StatsApiBookmakerSlug =
  | "bet365"
  | "paddy-power"
  | "betmgm-uk"
  | "pinnacle"
  | "betfair-exchange";

/** Svaren använder visningsnamn; frågorna använder slugs. */
const BOOKMAKER_SLUG_BY_NAME: Record<string, StatsApiBookmakerSlug> = {
  bet365: "bet365",
  "paddy power": "paddy-power",
  "betmgm uk": "betmgm-uk",
  pinnacle: "pinnacle",
  "betfair exchange": "betfair-exchange",
};

/** Skarpa referenser i fallande prioritet — börsen först, sedan Pinnacle. */
export const SHARP_BOOKMAKERS: StatsApiBookmakerSlug[] = ["betfair-exchange", "pinnacle"];

export function bookmakerSlug(displayName: string): StatsApiBookmakerSlug | null {
  return BOOKMAKER_SLUG_BY_NAME[displayName.trim().toLowerCase()] ?? null;
}

export interface StatValue {
  home: number;
  away: number;
}

/** Statistik med helmatch och halvlekar. Null när perioden inte lästs in. */
export interface MatchStatItem {
  all: StatValue | null;
  first_half: StatValue | null;
  second_half: StatValue | null;
}

export interface MatchStats {
  match_id: string;
  overview?: {
    ball_possession?: MatchStatItem | null;
    expected_goals?: MatchStatItem | null;
    total_shots?: MatchStatItem | null;
    shots_on_target?: MatchStatItem | null;
    corner_kicks?: MatchStatItem | null;
    fouls?: MatchStatItem | null;
  };
  shots?: {
    total_shots?: MatchStatItem | null;
    shots_on_target?: MatchStatItem | null;
    shots_off_target?: MatchStatItem | null;
    blocked_shots?: MatchStatItem | null;
    shots_inside_box?: MatchStatItem | null;
    shots_outside_box?: MatchStatItem | null;
  };
  np_expected_goals?: MatchStatItem | null;
}

/** Helmatchvärdet ur en MatchStatItem, eller null när perioden saknas. */
export function fullMatchStat(item: MatchStatItem | null | undefined): StatValue | null {
  const v = item?.all;
  if (!v || !Number.isFinite(v.home) || !Number.isFinite(v.away)) return null;
  return { home: v.home, away: v.away };
}

/** Lagnivåutfallen skottmodellen tränar på. */
export interface MatchTeamTotals {
  shots: StatValue | null;
  sot: StatValue | null;
  corners: StatValue | null;
  xg: StatValue | null;
  possession: StatValue | null;
}

/**
 * Plockar ut de lagnivåtal modellen behöver. `shots`-blocket är mer detaljerat
 * än `overview` men båda bär samma totaler — overview används som reserv.
 */
export function matchTeamTotals(stats: MatchStats): MatchTeamTotals {
  return {
    shots: fullMatchStat(stats.shots?.total_shots) ?? fullMatchStat(stats.overview?.total_shots),
    sot: fullMatchStat(stats.shots?.shots_on_target) ?? fullMatchStat(stats.overview?.shots_on_target),
    corners: fullMatchStat(stats.overview?.corner_kicks),
    xg: fullMatchStat(stats.overview?.expected_goals),
    possession: fullMatchStat(stats.overview?.ball_possession),
  };
}

export type ShotOddsMetric = "shots" | "sot" | "corners";
export type ShotOddsSide = "home" | "away" | "match";

/** En normaliserad prisrad: en bookmaker, ett mätetal, en sida, en linje. */
export interface ShotOddsLine {
  bookmaker: StatsApiBookmakerSlug;
  metric: ShotOddsMetric;
  side: ShotOddsSide;
  line: number;
  overOdds: number | null;
  underOdds: number | null;
  /** false = opening, true = last_seen. */
  isClosing: boolean;
}

/** API:ets marknadsnycklar → (metric, side). */
const MATCH_MARKETS: Array<[keyof MatchOddsMarkets, ShotOddsMetric]> = [
  ["match_shots", "shots"],
  ["match_shots_on_target", "sot"],
  ["match_corners", "corners"],
];

const TEAM_MARKETS: Array<[keyof MatchOddsMarkets, ShotOddsMetric]> = [
  ["team_shots", "shots"],
  ["team_shots_on_target", "sot"],
  ["team_corners", "corners"],
];

function pushLines(
  out: ShotOddsLine[],
  bookmaker: StatsApiBookmakerSlug,
  metric: ShotOddsMetric,
  side: ShotOddsSide,
  lines: Record<string, OverUnderOdds> | undefined
): void {
  if (!lines) return;
  for (const [key, ou] of Object.entries(lines)) {
    const line = Number(key);
    if (!Number.isFinite(line)) continue;
    for (const isClosing of [false, true]) {
      const overOdds = parseOddsValue(ou.over, isClosing);
      const underOdds = parseOddsValue(ou.under, isClosing);
      if (overOdds == null && underOdds == null) continue;
      out.push({ bookmaker, metric, side, line, overOdds, underOdds, isClosing });
    }
  }
}

/**
 * Plattar ut ett /odds-svar till skott- och hörnrader.
 *
 * Betfair Exchange behandlas som vilken bok som helst: `last_seen` speglar
 * bästa back-pris, och eftersom båda sidor kvoteras tar den proportionella
 * avviggningen bort spreaden av sig själv. Ingen mittpunktsberäkning behövs —
 * och till skillnad från en mittpunkt är bästa back-pris faktiskt spelbart.
 */
export function extractShotLines(res: MatchOddsResponse): ShotOddsLine[] {
  const out: ShotOddsLine[] = [];
  for (const book of res.bookmakers ?? []) {
    const slug = bookmakerSlug(book.bookmaker);
    if (!slug) continue;
    for (const [key, metric] of MATCH_MARKETS) {
      pushLines(out, slug, metric, "match", book.markets[key] as Record<string, OverUnderOdds> | undefined);
    }
    for (const [key, metric] of TEAM_MARKETS) {
      const teams = book.markets[key] as TeamOverUnderLines | undefined;
      pushLines(out, slug, metric, "home", teams?.home);
      pushLines(out, slug, metric, "away", teams?.away);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Huvudmarknader — 1X2, över/under mål, asiatiskt handikapp
// ---------------------------------------------------------------------------

export type MainMarket = "1x2" | "totals" | "ah";
export type MainOutcome = "home" | "draw" | "away" | "over" | "under";

/** En normaliserad prisrad ur /odds. `line` är null för 1X2. */
export interface MainMarketPrice {
  bookmaker: StatsApiBookmakerSlug;
  market: MainMarket;
  outcome: MainOutcome;
  line: number | null;
  /** Bästa spelbara pris. För börsen: bästa back. */
  odds: number;
  /** Börsen: bästa lay. Null för fastodds-böcker. */
  layOdds: number | null;
  /** Börsen: tillgängligt belopp. Null för fastodds-böcker. */
  backSize: number | null;
  laySize: number | null;
}

/**
 * Bästa priset och SAMLAT djup i en orderbok.
 *
 * API:et ger upp till tre nivåer. Att bara läsa den första underskattar hur
 * mycket som faktiskt går att få — priset man kan ta är bästa nivån, men
 * likviditeten som avgör om marknaden är trovärdig är summan.
 */
function bestLevel(levels: ExchangePriceLevel[] | undefined): { price: number; size: number } | null {
  if (!levels?.length) return null;
  const top = levels[0];
  if (!Number.isFinite(top.price) || top.price <= 1) return null;
  const size = levels.reduce((s, l) => s + (Number.isFinite(l.size) ? l.size : 0), 0);
  return { price: top.price, size };
}

/**
 * En prisrad ur ett OddsValue. Börsposter bär orderboken; fastodds-böcker
 * lämnar lay och storlekar som null, vilket är signalen till modellen att
 * mittpunkt inte går att räkna.
 */
function priceRow(
  bookmaker: StatsApiBookmakerSlug,
  market: MainMarket,
  outcome: MainOutcome,
  line: number | null,
  value: OddsValue | undefined
): MainMarketPrice | null {
  const odds = parseOddsValue(value, true);
  if (odds == null) return null;
  const back = bestLevel(value?.available_to_back);
  const lay = bestLevel(value?.available_to_lay);
  return {
    bookmaker,
    market,
    outcome,
    line,
    // `last_seen` speglar bästa back på börsen; orderboken vinner när den finns.
    odds: back?.price ?? odds,
    layOdds: lay?.price ?? null,
    backSize: back?.size ?? null,
    laySize: lay?.size ?? null,
  };
}

/**
 * Plattar ut ett /odds-svar till huvudmarknadernas prisrader.
 *
 * Asiatiskt handikapp lagras per sida och linje, och böckerna är INTE överens
 * om teckenkonventionen — se `normalizeHandicap` i lib/marketOdds.ts. Här
 * lagras linjen precis som API:et angav den; normaliseringen sker en gång, i
 * modellen, så att rådatan förblir spårbar.
 */
export function extractMarketPrices(res: MatchOddsResponse): MainMarketPrice[] {
  const out: MainMarketPrice[] = [];
  for (const book of res.bookmakers ?? []) {
    const slug = bookmakerSlug(book.bookmaker);
    if (!slug) continue;
    const m = book.markets;

    const mo = m.match_odds;
    if (mo) {
      for (const outcome of ["home", "draw", "away"] as const) {
        const row = priceRow(slug, "1x2", outcome, null, mo[outcome]);
        if (row) out.push(row);
      }
    }

    for (const [key, ou] of Object.entries(m.total_goals ?? {})) {
      const line = Number(key);
      if (!Number.isFinite(line)) continue;
      for (const outcome of ["over", "under"] as const) {
        const row = priceRow(slug, "totals", outcome, line, ou[outcome]);
        if (row) out.push(row);
      }
    }

    const ah = m.asian_handicap;
    for (const side of ["home", "away"] as const) {
      for (const [key, value] of Object.entries(ah?.[side] ?? {})) {
        const line = Number(key);
        if (!Number.isFinite(line)) continue;
        const row = priceRow(slug, "ah", side, line, value);
        if (row) out.push(row);
      }
    }
  }
  return out;
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
