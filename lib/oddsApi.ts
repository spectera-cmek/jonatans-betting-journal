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

async function getWithQuota<T>(
  path: string,
  params: Record<string, string>
): Promise<{ data: T; quota: OddsApiQuota }> {
  const url = new URL(BASE + path);
  url.searchParams.set("apiKey", key());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
  }
  return { data: (await res.json()) as T, quota: readQuota(res) };
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  return (await getWithQuota<T>(path, params)).data;
}

export function getSports(): Promise<SportDef[]> {
  return get<SportDef[]>("/sports", {});
}

export function getOdds(
  sportKey: string,
  opts: { regions?: string; markets?: string } = {}
): Promise<OddsEvent[]> {
  return get<OddsEvent[]>(`/sports/${sportKey}/odds`, {
    regions: opts.regions ?? "eu,uk",
    markets: opts.markets ?? "h2h",
    oddsFormat: "decimal",
  });
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
  return getWithQuota<OddsEvent[]>(`/sports/${sportKey}/odds`, {
    regions: opts.regions ?? "eu",
    markets: opts.markets ?? "h2h",
    oddsFormat: "decimal",
  });
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
  return getWithQuota<OddsEvent>(`/sports/${sportKey}/events/${eventId}/odds`, {
    regions: opts.regions ?? "eu",
    markets: opts.markets ?? "alternate_totals",
    oddsFormat: "decimal",
  });
}

export function getScores(
  sportKey: string,
  daysFrom = 3
): Promise<ScoreEvent[]> {
  return get<ScoreEvent[]>(`/sports/${sportKey}/scores`, {
    daysFrom: String(daysFrom),
    dateFormat: "iso",
  });
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
        if (o.name !== outcomeName) continue;
        if (point != null && o.point != null && o.point !== point) continue;
        if (best == null || o.price > best) best = o.price;
      }
    }
  }
  return best;
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
