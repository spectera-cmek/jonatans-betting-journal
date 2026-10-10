// Server-only: hämtar en CS2-matchs marknader från Kambis öppna offering-JSON
// (samma data som unibet.se och andra Kambi-böcker visar) och gör om dem till
// samma rader som skärmdumpstolkningen i lib/cs2/propsExtract.ts. Används av
// POST /api/cs2/lines/fetch-kambi.
//
// OBS: tjänsten är inte ett officiellt API. Den är odokumenterad, kan ändras
// utan förvarning och kan strida mot bokens villkor — skärmdumpen är reserven.
// Kambi anger odds och linjer i tusendelar: 1850 → 1.85, 16500 → 16.5.

import type { ParsedPropRow } from "./propsExtract";
import { matchTeam } from "./propsMatch";

const BRAND = process.env.CS2_KAMBI_BRAND ?? "ubse";
const BASE = `https://eu-offering-api.kambicdn.com/offering/v2018/${BRAND}`;
const QUERY = "lang=sv_SE&market=SE&client_id=2&channel_id=1&ncid=1";

/** Boknamnet som sparas på linjerna. */
export const KAMBI_BOOKMAKER = process.env.CS2_KAMBI_BOOKMAKER ?? "Unibet";

// --- Kambis JSON (bara fälten vi läser) -----------------------------------

interface KambiPathEntry {
  englishName?: string;
  name?: string;
  termKey?: string;
}

export interface KambiEvent {
  id: number;
  name?: string;
  englishName?: string;
  homeName?: string;
  awayName?: string;
  start?: string;
  path?: KambiPathEntry[];
}

export interface KambiOutcome {
  label?: string;
  englishLabel?: string;
  odds?: number;
  line?: number;
  participant?: string;
  type?: string;
  status?: string;
}

export interface KambiBetOffer {
  criterion?: { label?: string; englishLabel?: string };
  betOfferType?: { name?: string; englishName?: string };
  outcomes?: KambiOutcome[];
}

// --- Hämtning -------------------------------------------------------------

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}${QUERY}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new KambiError(`Kambi svarade ${res.status}`);
  return (await res.json()) as T;
}

export class KambiError extends Error {}

/** Alla CS2-matcher Kambi har i sitt utbud just nu. */
export async function fetchCs2Events(): Promise<KambiEvent[]> {
  const json = await getJson<{ events?: Array<{ event?: KambiEvent }> }>("listView/esports/all/all/all/matches.json");
  return (json.events ?? []).map((e) => e.event).filter((e): e is KambiEvent => !!e && isCs2(e));
}

/** Alla marknader för en Kambi-match. */
export async function fetchBetOffers(eventId: number): Promise<KambiBetOffer[]> {
  const json = await getJson<{ betOffers?: KambiBetOffer[] }>(`betoffer/event/${eventId}.json`);
  return json.betOffers ?? [];
}

// --- Rena funktioner (testade) --------------------------------------------

/** Är matchen Counter-Strike? Kambi lägger spelet i event.path. */
export function isCs2(e: KambiEvent): boolean {
  return (e.path ?? []).some((p) => /counter[\s_-]?strike|^cs2?$/i.test(p.termKey ?? p.englishName ?? p.name ?? ""));
}

/**
 * Kambi-matchen som motsvarar vår match: båda lagen ska kännas igen och
 * starttiden ligga inom ett dygn. Närmast i tid vinner.
 */
export function findKambiEvent(
  match: { startAt: Date; teams: Array<{ id: number; name: string }> },
  events: KambiEvent[]
): KambiEvent | null {
  if (match.teams.length < 2) return null;
  let best: { event: KambiEvent; diff: number } | null = null;
  for (const e of events) {
    const home = matchTeam(e.homeName, match.teams);
    const away = matchTeam(e.awayName, match.teams);
    if (home == null || away == null || home === away) continue;
    const diff = e.start ? Math.abs(new Date(e.start).getTime() - match.startAt.getTime()) : 0;
    if (diff > 24 * 3600_000) continue;
    if (!best || diff < best.diff) best = { event: e, diff };
  }
  return best?.event ?? null;
}

const milli = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v / 1000 : null);
const odds = (v: number | undefined): number | null => {
  const o = milli(v);
  return o != null && o > 1 ? Math.round(o * 1000) / 1000 : null;
};

/** "Map 1", "1st map", "Maps 1-2" → scope. Inget kartnummer → hela matchen. */
export function scopeOf(label: string): ParsedPropRow["scope"] {
  const l = label.toLowerCase();
  if (/maps?\s*1\s*(?:-|–|&|and|\+|och)\s*2|kart(?:a|or)\s*1\s*(?:-|–|&|och|\+)\s*2/.test(l)) return "maps12";
  const m = l.match(/(?:map|karta)\s*([123])\b|\b([123])(?:st|nd|rd|:a|:e)?\s*(?:map|karta)\b/);
  const n = m?.[1] ?? m?.[2];
  return n === "1" ? "map1" : n === "2" ? "map2" : n === "3" ? "map3" : "match";
}

/** Vilken av modellens marknader en criterion-etikett avser. */
export function marketOf(label: string, hasPlayer: boolean): ParsedPropRow["market"] {
  const l = label.toLowerCase();
  const onMap = scopeOf(label) !== "match";
  if (/headshot/.test(l)) return hasPlayer ? "headshots" : "other";
  if (/first (?:kill|blood)|första kill|first frag/.test(l)) return hasPlayer ? "player_first_kill" : "first_kill";
  if (/\bkills?\b/.test(l)) return hasPlayer ? "kills" : "other";
  if (/pistol/.test(l)) return "pistol";
  if (/handicap|handikapp/.test(l)) return onMap ? "map_handicap" : "match_handicap";
  if (/rounds?|rundor/.test(l)) return "rounds";
  if (/\bmaps?\b.*(?:total|over|under)|(?:total|number of|antal).*\bmaps?\b|antal kartor/.test(l)) return "total_maps";
  if (/winner|match odds|moneyline|vinnare|matchodds|^\s*(?:map|karta)\s*[123]\s*$/.test(l)) return onMap ? "map_winner" : "match_winner";
  return "other";
}

const OVER = new Set(["OT_OVER", "OT_YES"]);
const UNDER = new Set(["OT_UNDER", "OT_NO"]);
const HOME = new Set(["OT_ONE"]);
const AWAY = new Set(["OT_TWO"]);

/**
 * Kambis marknader → rader i samma form som skärmdumpstolkningen. Lagmarknader
 * anges från hemmalagets sida (team = homeName, overOdds = hemmalaget). Stängda
 * utfall hoppas över; okända marknader blir "other" så att de syns men inte sparas.
 */
export function mapBetOffers(offers: KambiBetOffer[], event: Pick<KambiEvent, "homeName" | "awayName">): ParsedPropRow[] {
  const rows: ParsedPropRow[] = [];
  for (const bo of offers) {
    const label = bo.criterion?.englishLabel ?? bo.criterion?.label ?? "";
    const scope = scopeOf(label);
    const outs = (bo.outcomes ?? []).filter((o) => !o.status || o.status === "OPEN");
    // En betoffer kan innehålla flera spelare och flera linjer — gruppera.
    const groups = new Map<string, KambiOutcome[]>();
    for (const o of outs) {
      const isHandicap = /handicap|handikapp/i.test(label);
      // Handikappens linje är spegelvänd per sida (-1.5 / +1.5): gruppera på absolutvärdet.
      const lineKey = o.line == null ? "" : String(isHandicap ? Math.abs(o.line) : o.line);
      const key = `${o.participant ?? ""}|${lineKey}`;
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const group of groups.values()) {
      const player = group[0].participant ?? null;
      const market = marketOf(label, player != null);
      const find = (types: Set<string>) => group.find((o) => o.type && types.has(o.type));
      let row: ParsedPropRow;
      if (player != null) {
        const over = find(OVER) ?? (group.length === 1 ? group[0] : undefined);
        const under = find(UNDER);
        row = { market, scope, player, team: null, line: milli((over ?? under)?.line), overOdds: odds(over?.odds), underOdds: odds(under?.odds), includesOt: null };
      } else if (find(HOME) || find(AWAY)) {
        const home = find(HOME);
        const away = find(AWAY);
        row = { market, scope, player: null, team: event.homeName ?? null, line: milli(home?.line ?? (away?.line != null ? -away.line : undefined)), overOdds: odds(home?.odds), underOdds: odds(away?.odds), includesOt: null };
      } else {
        const over = find(OVER);
        const under = find(UNDER);
        row = { market, scope, player: null, team: null, line: milli((over ?? under)?.line), overOdds: odds(over?.odds), underOdds: odds(under?.odds), includesOt: null };
      }
      if (row.overOdds == null && row.underOdds == null) continue;
      rows.push(row);
    }
  }
  return rows;
}
