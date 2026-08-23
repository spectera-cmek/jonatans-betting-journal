// Thin client for The Odds API (https://the-odds-api.com/).
// Free tier (~500 req/month) returns current odds + scores. Used for event
// search, closing-line capture (CLV) and auto-grading.

const BASE = "https://api.the-odds-api.com/v4";

export function hasOddsApiKey(): boolean {
  return !!process.env.ODDS_API_KEY;
}

function key(): string {
  const k = process.env.ODDS_API_KEY;
  if (!k) throw new Error("ODDS_API_KEY is not set in .env.local");
  return k;
}

export interface SportDef {
  key: string;
  group: string;
  title: string;
  active: boolean;
  has_outrights: boolean;
}

export interface OddsOutcome {
  name: string;
  price: number; // decimal odds
  point?: number; // line for spreads/totals
}
export interface OddsMarket {
  key: string; // h2h | spreads | totals
  outcomes: OddsOutcome[];
}
export interface OddsBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsMarket[];
}
export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

/** What the free /events endpoint returns: a fixture with no prices. */
export interface EventStub {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

export interface ScoreEntry {
  name: string;
  score: string;
}
export interface ScoreEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: ScoreEntry[] | null;
  last_update: string | null;
}

/**
 * Kvotläget efter ett anrop, ur svarshuvudena.
 *
 * The Odds API tar en kredit per region OCH marknad, så ett anrop med tre
 * marknader i en region kostar tre. Kvoten är liten nog att det märks, och
 * `last` är enda sättet att se vad ett anrop faktiskt kostade i stället för
 * vad man trodde att det skulle kosta.
 */
export interface OddsApiQuota {
  remaining: number | null;
  used: number | null;
  last: number | null;
}

function readQuota(res: Response): OddsApiQuota {
  const num = (name: string) => {
    const raw = res.headers.get(name);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    remaining: num("x-requests-remaining"),
    used: num("x-requests-used"),
    last: num("x-requests-last"),
  };
}

/**
 * Log what a call cost, without dragging Prisma into this module.
 *
 * The import is dynamic and fire-and-forget on purpose: lib/oddsApi.ts is pure
 * and unit-tested without a database, and only a real HTTP call should ever
 * reach the usage table. A failure here must never fail the odds call.
 */
function logQuota(
  endpoint: string,
  quota: OddsApiQuota,
  sportKey?: string
): void {
  if (quota.last == null) return;
  void import("./oddsApiUsage")
    .then((m) =>
      m.recordOddsApiUsage(endpoint as Parameters<typeof m.recordOddsApiUsage>[0], quota, sportKey)
    )
    .catch(() => {});
}

async function getWithQuota<T>(
  path: string,
  params: Record<string, string>,
  meta?: { endpoint: string; sportKey?: string }
): Promise<{ data: T; quota: OddsApiQuota }> {
  const url = new URL(BASE + path);
  url.searchParams.set("apiKey", key());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
  }
  const quota = readQuota(res);
  if (meta) logQuota(meta.endpoint, quota, meta.sportKey);
  return { data: (await res.json()) as T, quota };
}

async function get<T>(
  path: string,
  params: Record<string, string>,
  meta?: { endpoint: string; sportKey?: string }
): Promise<T> {
  return (await getWithQuota<T>(path, params, meta)).data;
}

export function getSports(): Promise<SportDef[]> {
  return get<SportDef[]>("/sports", {}, { endpoint: "sports" });
}

/**
 * Fixtures for a sport — id, teams and kickoff, no prices.
 *
 * **Costs 0 credits.** That is the whole point: linking a bet to an event only
 * ever needed the fixture list, and doing it through `getOdds` billed a credit
 * per region per market for data that was thrown away.
 */
export function getEvents(sportKey: string): Promise<EventStub[]> {
  return get<EventStub[]>(`/sports/${sportKey}/events`, { dateFormat: "iso" }, {
    endpoint: "events",
    sportKey,
  });
}

export function getOdds(
  sportKey: string,
  opts: { regions?: string; markets?: string; bookmakers?: string } = {}
): Promise<OddsEvent[]> {
  const params: Record<string, string> = {
    regions: opts.regions ?? "eu,uk",
    markets: opts.markets ?? "h2h",
    oddsFormat: "decimal",
  };
  if (opts.bookmakers) params.bookmakers = opts.bookmakers;
  return get<OddsEvent[]>(`/sports/${sportKey}/odds`, params, {
    endpoint: "odds",
    sportKey,
  });
}

/**
 * Odds for one event (markets × regions credits). Prefer this when capturing
 * closing for a handful of linked bets instead of polling whole sport boards.
 */
export function getEventOdds(
  sportKey: string,
  eventId: string,
  opts: { regions?: string; markets?: string; bookmakers?: string } = {}
): Promise<OddsEvent> {
  const params: Record<string, string> = {
    regions: opts.regions ?? "eu",
    markets: opts.markets ?? "h2h,spreads,totals",
    oddsFormat: "decimal",
  };
  if (opts.bookmakers) params.bookmakers = opts.bookmakers;
  return get<OddsEvent>(`/sports/${sportKey}/events/${eventId}/odds`, params, {
    endpoint: "event-odds",
    sportKey,
  });
}

/**
 * Envelope the /historical endpoints wrap their payload in.
 *
 * `timestamp` is the snapshot actually served — the API returns the closest
 * snapshot at or before the requested `date`, so it is never safe to assume you
 * got the minute you asked for. `previous_timestamp`/`next_timestamp` let a
 * caller walk the timeline without guessing the interval.
 */
export interface HistoricalEnvelope<T> {
  timestamp: string;
  previous_timestamp: string | null;
  next_timestamp: string | null;
  data: T;
}

/**
 * Odds for ONE event as they stood at `dateIso` — the closing line when you
 * pass the event's kickoff time.
 *
 * This is the honest source for CLV: a price captured before kickoff is a guess
 * at the close, this is the close. Snapshots run at 5-minute intervals (10 min
 * before September 2022).
 *
 * **Paid plans only, and costs 10 × markets × regions.** Ask for exactly the
 * markets the bets on this event need, in one region — the difference between
 * one market and three is 10 credits versus 30.
 */
export function getHistoricalEventOdds(
  sportKey: string,
  eventId: string,
  dateIso: string,
  opts: { regions?: string; markets?: string; bookmakers?: string } = {}
): Promise<{ envelope: HistoricalEnvelope<OddsEvent>; quota: OddsApiQuota }> {
  const params: Record<string, string> = {
    date: dateIso,
    regions: opts.regions ?? "eu",
    markets: opts.markets ?? "h2h",
    oddsFormat: "decimal",
  };
  if (opts.bookmakers) params.bookmakers = opts.bookmakers;
  return getWithQuota<HistoricalEnvelope<OddsEvent>>(
    `/historical/sports/${sportKey}/events/${eventId}/odds`,
    params,
    { endpoint: "historical-event-odds", sportKey }
  ).then(({ data, quota }) => ({ envelope: data, quota }));
}

/**
 * Fixtures as they stood at `dateIso`. Only needed for bets that were never
 * linked to an Odds API event — a linked bet already carries the event id, so
 * the snapshot call can go straight to `getHistoricalEventOdds`.
 */
export function getHistoricalEvents(
  sportKey: string,
  dateIso: string
): Promise<{ envelope: HistoricalEnvelope<EventStub[]>; quota: OddsApiQuota }> {
  return getWithQuota<HistoricalEnvelope<EventStub[]>>(
    `/historical/sports/${sportKey}/events`,
    { date: dateIso, dateFormat: "iso" },
    { endpoint: "historical-events", sportKey }
  ).then(({ data, quota }) => ({ envelope: data, quota }));
}

/**
 * Som `getOdds`, men rapporterar även kvotläget.
 *
 * Oddsjämförelsen hämtar en hel liga per anrop och behöver veta vad varje
 * körning kostade — utan det syns det inte att kvoten tar slut förrän den gör
 * det mitt i en inläsning.
 */
export function getOddsWithQuota(
  sportKey: string,
  opts: { regions?: string; markets?: string } = {}
): Promise<{ data: OddsEvent[]; quota: OddsApiQuota }> {
  return getWithQuota<OddsEvent[]>(
    `/sports/${sportKey}/odds`,
    {
      regions: opts.regions ?? "eu",
      markets: opts.markets ?? "h2h",
      oddsFormat: "decimal",
    },
    { endpoint: "odds", sportKey }
  );
}

/**
 * Odds för EN match, med marknader som inte finns på bulk-endpointen.
 *
 * `alternate_totals` är skälet den behövs: bulk ger varje bok dess EGEN
 * huvudlinje, och när Pinnacle ligger på 2,75 medan åtta böcker ligger på 2,5
 * blir de åtta oanvändbara — det finns ingen referens på deras linje. Med
 * alternativa linjer får referensen ett pris på varje linje i stället.
 *
 * Kostar en kredit per unik marknad OCH region, per match.
 */
export function getEventOddsWithQuota(
  sportKey: string,
  eventId: string,
  opts: { regions?: string; markets?: string } = {}
): Promise<{ data: OddsEvent; quota: OddsApiQuota }> {
  return getWithQuota<OddsEvent>(
    `/sports/${sportKey}/events/${eventId}/odds`,
    {
      regions: opts.regions ?? "eu",
      markets: opts.markets ?? "alternate_totals",
      oddsFormat: "decimal",
    },
    { endpoint: "event-odds", sportKey }
  );
}

/**
 * Final scores. `daysFrom` reaches back over completed events and is capped at
 * 3 by the API; passing it costs 2 credits instead of 1.
 */
export function getScores(
  sportKey: string,
  daysFrom = 3
): Promise<ScoreEvent[]> {
  return get<ScoreEvent[]>(
    `/sports/${sportKey}/scores`,
    { daysFrom: String(Math.min(3, Math.max(1, daysFrom))), dateFormat: "iso" },
    { endpoint: "scores", sportKey }
  );
}

function outcomeMatches(
  o: OddsOutcome,
  outcomeName: string,
  point?: number
): boolean {
  if (o.name !== outcomeName) return false;
  if (point == null) return true;
  if (o.point == null) return false;
  return Math.abs(o.point - point) < 0.001;
}

/** Best (max) decimal price for a named outcome across all bookmakers in an event. */
export function bestPriceFor(
  event: OddsEvent,
  marketKey: string,
  outcomeName: string,
  point?: number
): number | null {
  let best: number | null = null;
  for (const bk of event.bookmakers || []) {
    for (const m of bk.markets || []) {
      if (m.key !== marketKey) continue;
      for (const o of m.outcomes || []) {
        if (!outcomeMatches(o, outcomeName, point)) continue;
        if (best == null || o.price > best) best = o.price;
      }
    }
  }
  return best;
}

const DEFAULT_CLV_BOOKS = ["pinnacle", "bet365", "unibet", "williamhill"];

/**
 * Prefer sharp/common books for CLV; fall back to best available price.
 * Returns null when the outcome/line is missing.
 */
export function preferredPriceFor(
  event: OddsEvent,
  marketKey: string,
  outcomeName: string,
  point?: number,
  preferredBookKeys: string[] = DEFAULT_CLV_BOOKS
): { price: number; bookmaker: string } | null {
  const want = new Set(preferredBookKeys.map((k) => k.toLowerCase()));

  for (const key of preferredBookKeys) {
    const bk = (event.bookmakers || []).find(
      (b) => b.key.toLowerCase() === key.toLowerCase()
    );
    if (!bk) continue;
    for (const m of bk.markets || []) {
      if (m.key !== marketKey) continue;
      for (const o of m.outcomes || []) {
        if (!outcomeMatches(o, outcomeName, point)) continue;
        if (o.price > 1) return { price: o.price, bookmaker: bk.key };
      }
    }
  }

  // Any remaining bookmaker (not already preferred) — take best price.
  let best: { price: number; bookmaker: string } | null = null;
  for (const bk of event.bookmakers || []) {
    if (want.has(bk.key.toLowerCase())) continue;
    for (const m of bk.markets || []) {
      if (m.key !== marketKey) continue;
      for (const o of m.outcomes || []) {
        if (!outcomeMatches(o, outcomeName, point)) continue;
        if (o.price > 1 && (!best || o.price > best.price)) {
          best = { price: o.price, bookmaker: bk.key };
        }
      }
    }
  }
  if (best) return best;

  // Preferred books missing line — fall back to absolute best across all.
  const fallback = bestPriceFor(event, marketKey, outcomeName, point);
  if (fallback == null) return null;
  return { price: fallback, bookmaker: "best" };
}

/** Parse a ScoreEvent into numeric home/away scores, or null if unavailable. */
export function parseScores(
  ev: ScoreEvent
): { homeScore: number; awayScore: number } | null {
  if (!ev.completed || !ev.scores) return null;
  const home = ev.scores.find((s) => s.name === ev.home_team);
  const away = ev.scores.find((s) => s.name === ev.away_team);
  if (!home || !away) return null;
  const hs = Number(home.score);
  const as = Number(away.score);
  if (Number.isNaN(hs) || Number.isNaN(as)) return null;
  return { homeScore: hs, awayScore: as };
}
