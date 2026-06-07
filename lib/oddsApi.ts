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

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path);
  url.searchParams.set("apiKey", key());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
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
