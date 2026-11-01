// Tunn klient för OddsPapi v4 (https://oddspapi.io/en/docs).
//
// Gratisplanen ger runt 250 anrop i månaden (nollställs den 1:a). Varje anrop
// till en debiterad endpoint kostar 1, även om svaret är ett fel. Undantag:
//   /v4/historical-odds  — alltid gratis
//   /v4/account          — räknas aldrig, fungerar även när kvoten är slut
//
// Nyckeln skickas som ?apiKey=, så hela URL:er loggas aldrig här — bara
// sökvägen. Varje endpoint har en egen cooldown som klienten respekterar.

const BASE = "https://api.oddspapi.io/v4";

export function hasOddspapiKey(): boolean {
  return !!process.env.ODDSPAPI_KEY;
}

function key(): string {
  const k = process.env.ODDSPAPI_KEY;
  if (!k) throw new Error("ODDSPAPI_KEY saknas i .env.local");
  return k;
}

/** Boken som används som marknadsreferens. */
export function oddspapiBookmaker(): string {
  return (process.env.ODDSPAPI_BOOKMAKER || "pinnacle").trim().toLowerCase();
}

export class OddspapiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "OddspapiError";
    this.statusCode = statusCode;
    this.code = code;
  }

  get quotaExceeded(): boolean {
    return this.code === "REQUEST_LIMIT_EXCEEDED";
  }
}

/** Cooldown per endpoint enligt docs (ms). */
const COOLDOWN_MS: Record<string, number> = {
  "/odds": 500,
  "/odds-by-tournaments": 1000,
  "/fixtures": 2000,
  "/settlements": 2000,
  "/historical-odds": 5000,
};
const DEFAULT_COOLDOWN_MS = 1000;

/** Endpoints som inte drar kvot. */
const FREE_PATHS = new Set(["/historical-odds", "/account"]);

const lastCall = new Map<string, number>();
let billableCalls = 0;

/** Antal debiterade anrop som gjorts i den här processen. */
export function oddspapiCallsThisRun(): number {
  return billableCalls;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bygger URL:en. Exporterad för tester — logga den aldrig. */
export function buildUrl(path: string, params: Record<string, string | number | boolean | undefined>, apiKey: string): string {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  u.searchParams.set("apiKey", apiKey);
  return u.toString();
}

export async function oddspapiGet<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  init?: { headers?: Record<string, string> }
): Promise<T> {
  const cooldown = COOLDOWN_MS[path] ?? DEFAULT_COOLDOWN_MS;
  const since = Date.now() - (lastCall.get(path) ?? 0);
  if (since < cooldown) await sleep(cooldown - since);
  lastCall.set(path, Date.now());

  const res = await fetch(buildUrl(path, params, key()), { headers: { Accept: "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  if (!FREE_PATHS.has(path)) billableCalls++;
  if (res.status === 304) return null as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* lämnas som null */
  }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; message?: string; details?: string; error?: string };
    throw new OddspapiError(res.status, b.code ?? `HTTP_${res.status}`, `OddsPapi ${path}: ${b.details ?? b.message ?? b.error ?? res.statusText}`);
  }
  return body as T;
}

/** Försök igen på 429 (inte kvot-slut) och 5xx — aldrig på 4xx, det bränner bara kvot. */
export async function oddspapiRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const transient = e instanceof OddspapiError && !e.quotaExceeded && (e.statusCode === 429 || e.statusCode >= 500);
      if (!transient || i === attempts - 1) throw e;
      await sleep(2000 * Math.pow(2, i));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Typer (det vi använder ur svaren)
// ---------------------------------------------------------------------------

export interface OpTournament {
  tournamentId: number;
  tournamentSlug: string;
  tournamentName: string;
  categorySlug: string;
  categoryName: string;
  futureFixtures?: number;
  upcomingFixtures?: number;
}

export interface OpMarketOutcome {
  outcomeId: number;
  outcomeName: string;
}

export interface OpMarket {
  marketId: number;
  marketLength?: number;
  marketName: string;
  playerProp: boolean;
  sportId: number;
  handicap: number;
  period: string;
  marketType: string;
  outcomes: OpMarketOutcome[];
}

export interface OpFixture {
  fixtureId: string;
  participant1Id: number;
  participant2Id: number;
  participant1Name?: string;
  participant2Name?: string;
  sportId: number;
  tournamentId: number;
  statusId: number;
  statusName?: string;
  hasOdds?: boolean;
  startTime: string;
}

export interface OpPlayerPrice {
  active?: boolean;
  bookmakerOutcomeId?: string | null;
  price: number;
  playerName?: string | null;
  mainLine?: boolean;
  changedAt?: string | null;
}

export interface OpBookOdds {
  bookmakerIsActive?: boolean;
  suspended?: boolean;
  markets: Record<
    string,
    {
      bookmakerMarketId?: string;
      marketActive?: boolean;
      outcomes: Record<string, { players: Record<string, OpPlayerPrice> }>;
    }
  >;
}

export interface OpFixtureOdds extends OpFixture {
  bookmakerOdds?: Record<string, OpBookOdds>;
}

export interface OpHistoryEntry {
  createdAt: string;
  price: number;
  active?: boolean;
}

export interface OpHistoricalOdds {
  fixtureId: string;
  bookmakers: Record<
    string,
    { markets: Record<string, { outcomes: Record<string, { players: Record<string, OpHistoryEntry[]> }> }> }
  >;
}

export interface OpAccount {
  subscriptions?: Array<{
    is_active?: boolean;
    request_limit?: number;
    request_count?: number;
    sport_ids?: number[];
    bookmakers?: Record<string, { has_live_odds?: boolean; has_player_props?: boolean }>;
    valid_until?: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const SPORT_SOCCER = 10;
export const SPORT_BASKETBALL = 11;

export const getAccount = () => oddspapiGet<OpAccount>("/account");
export const getTournaments = (sportId: number) => oddspapiGet<OpTournament[]>("/tournaments", { sportId });
export const getMarkets = () => oddspapiGet<OpMarket[]>("/markets");

export function getFixtures(p: { tournamentId?: number; sportId?: number; from?: string; to?: string; statusId?: number }) {
  return oddspapiGet<OpFixture[]>("/fixtures", p);
}

/** Alla matcher i upp till 3 turneringar med en boks odds — 1 anrop. */
export async function getOddsByTournaments(tournamentIds: number[], bookmaker = oddspapiBookmaker()): Promise<OpFixtureOdds[]> {
  const r = await oddspapiGet<OpFixtureOdds[] | OpFixtureOdds | Record<string, OpFixtureOdds>>("/odds-by-tournaments", {
    tournamentIds: tournamentIds.slice(0, 3).join(","),
    bookmaker,
    oddsFormat: "decimal",
  });
  return normalizeList(r);
}

/** Historiska odds för en match — gratis. Max 3 böcker per anrop. */
export function getHistoricalOdds(fixtureId: string, bookmakers: string[] = [oddspapiBookmaker()]) {
  return oddspapiGet<OpHistoricalOdds>("/historical-odds", { fixtureId, bookmakers: bookmakers.slice(0, 3).join(",") });
}

/** Docs är otydliga om svaret är en lista, ett objekt eller en map — ta emot alla tre. */
export function normalizeList(r: unknown): OpFixtureOdds[] {
  if (!r) return [];
  if (Array.isArray(r)) return r as OpFixtureOdds[];
  const o = r as Record<string, unknown>;
  if (typeof o.fixtureId === "string") return [o as unknown as OpFixtureOdds];
  return Object.values(o).filter((v): v is OpFixtureOdds => !!v && typeof v === "object" && typeof (v as OpFixtureOdds).fixtureId === "string");
}

/** Kvar av månadens kvot, eller null om kontot inte svarar. */
export async function quotaLeft(): Promise<{ used: number; limit: number } | null> {
  try {
    const a = await getAccount();
    const s = a.subscriptions?.find((x) => x.is_active) ?? a.subscriptions?.[0];
    if (!s || s.request_limit == null) return null;
    return { used: s.request_count ?? 0, limit: s.request_limit };
  } catch {
    return null;
  }
}
