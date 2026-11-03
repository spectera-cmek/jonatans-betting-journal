// Live-priser för NBA från Kambi (Unibet, Paf, …) och Pinnacle via deras
// öppna webb-API:er — samma data som sajterna visar. Ingen nyckel.
// Används av nba:live-watch för att hitta sega linjer i realtid.

export type LiveKind = "ml" | "spread" | "total";

/** Sida 1 = hemma/över. line: hemmalagets handicap, totalen, null för vinnare. */
export interface LiveMarket {
  kind: LiveKind;
  line: number | null;
  price1: number;
  price2: number;
  /** Pinnacle: alternativ linje (inte huvudlinjen). */
  alt?: boolean;
}

export interface LiveEvent {
  id: string;
  home: string;
  away: string;
  start: number;
  markets: LiveMarket[];
}

const UA = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (betting-tracker, personal use)" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hämtar JSON. Tillfälliga fel (401/429/5xx, tomt svar, nätet) försöks igen två gånger. */
async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, cache: "no-store" });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { retry: res.status === 401 || res.status === 429 || res.status >= 500 });
      if (!text) throw Object.assign(new Error(`${new URL(url).host}: tomt svar`), { retry: true });
      return JSON.parse(text) as T;
    } catch (e) {
      const retry = (e as { retry?: boolean }).retry || e instanceof TypeError;
      if (!retry || attempt >= 2) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Kambi
// ---------------------------------------------------------------------------

interface KambiOutcome {
  type: string;
  odds?: number;
  line?: number;
  status?: string;
}
interface KambiBetOffer {
  criterion?: { englishLabel?: string; lifetime?: string };
  betOfferType?: { englishName?: string };
  outcomes?: KambiOutcome[];
  tags?: string[];
}
interface KambiListView {
  events?: Array<{ event: { id: number; homeName?: string; awayName?: string; start: string; state?: string }; betOffers?: KambiBetOffer[] }>;
}

/** Kambi-varumärken: ubse = Unibet SE, pafse = Paf SE (fler: se kambiBrandUrl). */
export const KAMBI_BRANDS: Record<string, { name: string; url: (eventId: string) => string }> = {
  ubse: { name: "Unibet", url: (id) => `https://www.unibet.se/betting/sports/event/${id}` },
  pafse: { name: "Paf", url: (id) => `https://www.paf.se/betting#/event/${id}` },
};

export function parseKambi(json: KambiListView): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const e of json.events ?? []) {
    const ev = e.event;
    if (!ev?.homeName || !ev.awayName || (ev.state && ev.state !== "NOT_STARTED")) continue;
    const markets: LiveMarket[] = [];
    for (const b of e.betOffers ?? []) {
      // Bara hela matchen inklusive förlängning.
      if (b.criterion?.lifetime && b.criterion.lifetime !== "FULL_TIME_OVERTIME") continue;
      const type = b.betOfferType?.englishName;
      const kind: LiveKind | null = type === "Match" ? "ml" : type === "Handicap" ? "spread" : type === "Over/Under" ? "total" : null;
      if (!kind) continue;
      const o1 = b.outcomes?.find((o) => o.type === (kind === "total" ? "OT_OVER" : "OT_ONE"));
      const o2 = b.outcomes?.find((o) => o.type === (kind === "total" ? "OT_UNDER" : "OT_TWO"));
      if (!o1?.odds || !o2?.odds || o1.status !== "OPEN" || o2.status !== "OPEN") continue;
      // Kambi: odds och linjer ×1000. OT_ONE = hemmalaget; spreadens linje gäller utfallet.
      const line = kind === "ml" ? null : (o1.line ?? NaN) / 1000;
      if (kind !== "ml" && !Number.isFinite(line)) continue;
      markets.push({ kind, line, price1: o1.odds / 1000, price2: o2.odds / 1000 });
    }
    out.push({ id: String(ev.id), home: ev.homeName, away: ev.awayName, start: Date.parse(ev.start), markets });
  }
  return out;
}

export async function fetchKambiNba(brand = "ubse"): Promise<LiveEvent[]> {
  const url = `https://eu-offering-api.kambicdn.com/offering/v2018/${brand}/listView/basketball/nba/all/all/matches.json?lang=sv_SE&market=SE&useCombined=true`;
  return parseKambi(await getJson<KambiListView>(url));
}

// ---------------------------------------------------------------------------
// Pinnacle
// ---------------------------------------------------------------------------

interface PinMatchup {
  id: number;
  type: string;
  parentId?: number | null;
  startTime: string;
  isLive?: boolean;
  participants?: Array<{ alignment: string; name: string }>;
}
interface PinMarket {
  matchupId: number;
  type: string;
  period: number;
  isAlternate?: boolean;
  status?: string;
  prices?: Array<{ designation?: string; price: number; points?: number }>;
}

/** Amerikanska odds → decimal. */
export const americanToDecimal = (a: number) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));

export const PINNACLE_NBA_LEAGUE = 487;

export function parsePinnacle(matchups: PinMatchup[], markets: PinMarket[]): LiveEvent[] {
  const byId = new Map<number, LiveEvent>();
  for (const m of matchups) {
    if (m.type !== "matchup" || m.parentId || m.isLive) continue;
    const home = m.participants?.find((p) => p.alignment === "home")?.name;
    const away = m.participants?.find((p) => p.alignment === "away")?.name;
    if (!home || !away) continue;
    byId.set(m.id, { id: String(m.id), home, away, start: Date.parse(m.startTime), markets: [] });
  }
  for (const k of markets) {
    const ev = byId.get(k.matchupId);
    if (!ev || k.period !== 0 || (k.status && k.status !== "open")) continue;
    const kind: LiveKind | null = k.type === "moneyline" ? "ml" : k.type === "spread" ? "spread" : k.type === "total" ? "total" : null;
    if (!kind) continue;
    const p1 = k.prices?.find((p) => p.designation === (kind === "total" ? "over" : "home"));
    const p2 = k.prices?.find((p) => p.designation === (kind === "total" ? "under" : "away"));
    if (!p1 || !p2) continue;
    const line = kind === "ml" ? null : p1.points ?? null;
    if (kind !== "ml" && line == null) continue;
    ev.markets.push({ kind, line, price1: americanToDecimal(p1.price), price2: americanToDecimal(p2.price), alt: !!k.isAlternate });
  }
  return [...byId.values()];
}

export async function fetchPinnacleNba(leagueId = PINNACLE_NBA_LEAGUE): Promise<LiveEvent[]> {
  const base = `https://guest.api.arcadia.pinnacle.com/0.1/leagues/${leagueId}`;
  // Ett anrop i taget — parallella anrop har gett tillfälliga 401.
  const matchups = await getJson<PinMatchup[]>(`${base}/matchups?brandId=0`);
  const markets = await getJson<PinMarket[]>(`${base}/markets/straight`);
  return parsePinnacle(matchups, markets);
}
