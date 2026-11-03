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
  // Marginal ovanpå docs cooldown: servern räknar från sin sida, inte vår.
  const cooldown = (COOLDOWN_MS[path] ?? DEFAULT_COOLDOWN_MS) + 400;
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
    const b = (body ?? {}) as { code?: unknown; message?: unknown; details?: unknown; error?: unknown };
    // Felet kan vara en sträng eller ett objekt ({ error: { code, message } } …) — skriv ut båda läsbart.
    const text = (v: unknown) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
    const inner = (b.error && typeof b.error === "object" ? (b.error as { code?: unknown; message?: unknown }) : null) ?? null;
    const code = text(b.code) ?? text(inner?.code) ?? `HTTP_${res.status}`;
    const detail = text(b.details) ?? text(b.message) ?? text(inner?.message) ?? text(b.error) ?? (text(body) || res.statusText);
    throw new OddspapiError(res.status, code, `OddsPapi ${path} (${res.status} ${code}): ${detail}`);
  }
  return body as T;
}

const NETWORK_CODES = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)$/;

/** Nätet hackade (fetch kom aldrig fram eller bröts) — inget svar från OddsPapi. */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof TypeError) || !/fetch failed/i.test(e.message)) return false;
  const cause = (e as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } }).cause;
  const codes = [cause?.code, ...(cause?.errors ?? []).map((x) => x?.code)].filter((c): c is string => typeof c === "string");
  return codes.length === 0 || codes.some((c) => NETWORK_CODES.test(c));
}

/**
 * Försök igen på 429 (inte kvot-slut), 5xx och nätverksfel — aldrig på 4xx,
 * det bränner bara kvot. Väntar 2 s, 4 s, 8 s … mellan försöken.
 */
export async function oddspapiRetry<T>(fn: () => Promise<T>, attempts = 3, onRetry?: (msg: string) => void): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const network = isNetworkError(e);
      const transient = network || (e instanceof OddspapiError && !e.quotaExceeded && (e.statusCode === 429 || e.statusCode >= 500));
      if (!transient || i === attempts - 1) {
        if (network) throw new Error(`Kom inte fram till OddsPapi (${networkCode(e)}) efter ${i + 1} försök — kolla nätet och kör igen.`, { cause: e });
        throw e;
      }
      const wait = 2000 * Math.pow(2, i);
      onRetry?.(`${network ? `nätverksfel (${networkCode(e)})` : (e as Error).message} — försöker igen om ${wait / 1000} s`);
      await sleep(wait);
    }
  }
  throw last;
}

function networkCode(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : "fetch failed";
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
