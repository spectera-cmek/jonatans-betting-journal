// Smarkets öppna API (ingen nyckel): NBA-matcher, marknader och orderböcker.
//
// Smarkets har ingen prishistorik och finns inte i OddsPapi, så priserna
// samlas in framåt (npm run nba:smarkets) och sparas i NbaSmarketsQuote.
//
// Priser anges som sannolikhet i baspunkter: 5000 = 50 % = 2,00.
// Back = köpa kontraktet till lägsta säljbudet ("offers").
// Lay  = sälja till högsta köpbudet ("bids").
// Provisionen (2 % på nettovinst) dras inte här — se netPrice().

const BASE = "https://api.smarkets.com/v3";
const THROTTLE_MS = 400;
/** Smarkets provision på nettovinsten. */
export const SMARKETS_COMMISSION = 0.02;
export const SMARKETS_BOOK = "smarkets";

export interface SmEvent {
  id: string;
  name: string;
  full_slug: string;
  start_datetime: string;
  state: string;
  parent_id?: string | null;
  type?: string;
}

export interface SmMarket {
  id: string;
  name: string;
  event_id: string;
  market_type: { name: string; param?: string };
  state: string;
}

export interface SmContract {
  id: string;
  name: string;
  market_id: string;
  contract_type: { name: string; param?: string };
}

export type SmQuotes = Record<string, { bids?: Array<{ price: number; quantity: number }>; offers?: Array<{ price: number; quantity: number }> }>;

let last = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function smGet<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(BASE + path, { headers: { Accept: "application/json", "User-Agent": "betting-tracker/1.0 (personal use)" }, cache: "no-store" });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`Smarkets ${res.status}`), { retry: true });
      if (!res.ok) throw new Error(`Smarkets ${path.split("?")[0]} (${res.status}): ${/cloudflare/i.test(text) ? "blockerad av Cloudflare" : text.slice(0, 200)}`);
      return JSON.parse(text) as T;
    } catch (e) {
      const retry = (e as { retry?: boolean }).retry || (e instanceof TypeError && /fetch failed/i.test(e.message));
      if (!retry || attempt >= 3) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

/** Kommande och pågående NBA-matcher (bläddrar igenom basketlistan). */
export async function getNbaEvents(maxPages = 8): Promise<SmEvent[]> {
  const out: SmEvent[] = [];
  let next: string | null = "?type_domain=basketball&type_scope=single_event&state=upcoming&state=live&sort=start_datetime,id&limit=50";
  for (let i = 0; next && i < maxPages; i++) {
    const r: { events?: SmEvent[]; pagination?: { next_page?: string | null } } = await smGet(`/events/${next}`);
    out.push(...(r.events ?? []).filter(isNbaEvent));
    next = r.pagination?.next_page ?? null;
  }
  return out;
}

export function isNbaEvent(e: Pick<SmEvent, "full_slug" | "type">): boolean {
  return /\/basketball\/nba\//.test(e.full_slug ?? "") && (e.type == null || e.type === "basketball_match");
}

const MAIN_TYPES = new Set(["WINNER_2_WAY", "HANDICAP", "OVER_UNDER"]);

/** Huvudmarknaderna (vinnare, handicap, total — inklusive förlängning) med kontrakt och orderböcker. */
export async function getMainMarkets(eventIds: string[]): Promise<{ markets: SmMarket[]; contracts: SmContract[]; quotes: SmQuotes }> {
  const markets: SmMarket[] = [];
  for (let i = 0; i < eventIds.length; i += 5) {
    const r = await smGet<{ markets?: SmMarket[] }>(`/events/${eventIds.slice(i, i + 5).join(",")}/markets/`);
    markets.push(...(r.markets ?? []).filter((m) => MAIN_TYPES.has(m.market_type?.name) && m.state === "open"));
  }
  const contracts: SmContract[] = [];
  const quotes: SmQuotes = {};
  for (let i = 0; i < markets.length; i += 20) {
    const ids = markets.slice(i, i + 20).map((m) => m.id).join(",");
    contracts.push(...((await smGet<{ contracts?: SmContract[] }>(`/markets/${ids}/contracts/`)).contracts ?? []));
    Object.assign(quotes, await smGet<SmQuotes>(`/markets/${ids}/quotes/`));
  }
  return { markets, contracts, quotes };
}

/** Baspunkter → decimalodds. */
export const bpToDecimal = (bp: number) => Math.round((10000 / bp) * 1000) / 1000;

/** Vad ett vunnet spel faktiskt ger efter provisionen, som decimalodds. */
export function netPrice(price: number, commission = SMARKETS_COMMISSION): number {
  return 1 + (price - 1) * (1 - commission);
}

export type SmKind = "ml" | "spread" | "total";

/** En rad i stegen: en linje med bästa back och lay för båda sidor. Sida 1 = hemma/över. */
export interface SmLine {
  eventId: string;
  kind: SmKind;
  /** Spread: hemmalagets handicap. Total: totalen. Moneyline: null. */
  line: number | null;
  back1: number | null;
  back2: number | null;
  lay1: number | null;
  lay2: number | null;
}

function best(q: SmQuotes[string] | undefined) {
  const back = q?.offers?.length ? Math.min(...q.offers.map((o) => o.price)) : null;
  const lay = q?.bids?.length ? Math.max(...q.bids.map((o) => o.price)) : null;
  return { back: back ? bpToDecimal(back) : null, lay: lay ? bpToDecimal(lay) : null };
}

/** Plattar ut marknaderna till stegar per match: en rad per linje. */
export function toLines(markets: SmMarket[], contracts: SmContract[], quotes: SmQuotes): SmLine[] {
  const byMarket = new Map<string, SmContract[]>();
  for (const c of contracts) byMarket.set(String(c.market_id), [...(byMarket.get(String(c.market_id)) ?? []), c]);
  const out: SmLine[] = [];
  for (const m of markets) {
    const t = m.market_type?.name;
    const kind: SmKind | null = t === "WINNER_2_WAY" ? "ml" : t === "HANDICAP" ? "spread" : t === "OVER_UNDER" ? "total" : null;
    if (!kind) continue;
    const cs = byMarket.get(String(m.id)) ?? [];
    const side1 = cs.find((c) => c.contract_type?.name === (kind === "total" ? "OVER" : "HOME"));
    const side2 = cs.find((c) => c.contract_type?.name === (kind === "total" ? "UNDER" : "AWAY"));
    if (!side1 || !side2) continue;
    // param är hemmalagets handicap ("-6.5" = hemma −6,5) respektive totalen.
    const line = kind === "ml" ? null : Number(m.market_type.param);
    if (kind !== "ml" && !Number.isFinite(line)) continue;
    const a = best(quotes[side1.id]);
    const b = best(quotes[side2.id]);
    out.push({ eventId: String(m.event_id), kind, line, back1: a.back, back2: b.back, lay1: a.lay, lay2: b.lay });
  }
  return out;
}

/**
 * Huvudlinjen per match och marknad: den linje där back-priserna på båda
 * sidor ligger jämnast. Moneyline har bara en.
 */
export function mainLines(lines: SmLine[]): SmLine[] {
  const groups = new Map<string, SmLine[]>();
  for (const l of lines) {
    if (l.back1 == null || l.back2 == null) continue;
    const k = `${l.eventId}|${l.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const out: SmLine[] = [];
  for (const g of groups.values()) {
    out.push(g.reduce((a, b) => (Math.abs(1 / b.back1! - 1 / b.back2!) < Math.abs(1 / a.back1! - 1 / a.back2!) ? b : a)));
  }
  return out;
}

/** "Oklahoma City Thunder at Cleveland Cavaliers" → { away, home }. */
export function splitEventName(name: string): { away: string; home: string } | null {
  const m = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(name.trim());
  return m ? { away: m[1], home: m[2] } : null;
}
