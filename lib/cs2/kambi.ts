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
  /** "COUNTER_STRIKE" för CS2. */
  sport?: string;
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
  const json = await getJson<{ events?: Array<{ event?: KambiEvent }> }>("listView/esports/cs2/all/all/matches.json");
  return (json.events ?? []).map((e) => e.event).filter((e): e is KambiEvent => !!e && isCs2(e));
}

/** Alla marknader för en Kambi-match. */
export async function fetchBetOffers(eventId: number): Promise<KambiBetOffer[]> {
  const json = await getJson<{ betOffers?: KambiBetOffer[] }>(`betoffer/event/${eventId}.json`);
  return json.betOffers ?? [];
}

// --- Rena funktioner (testade) --------------------------------------------

/** Är matchen Counter-Strike? Kambi anger sport och spel (termKey "cs2") i path. */
export function isCs2(e: KambiEvent): boolean {
  if (e.sport) return e.sport === "COUNTER_STRIKE";
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

/** Spelarmarknad? Kambi sätter `participant` även på lagens utfall, så det avgör inte. */
export function isPlayerOffer(bo: KambiBetOffer): boolean {
  const label = bo.criterion?.englishLabel ?? bo.criterion?.label ?? "";
  return /player/i.test(bo.betOfferType?.englishName ?? "") || /by the player|av spelaren/i.test(label);
}

/**
 * Vilken av modellens marknader en criterion-etikett avser. Kambis etiketter
 * för CS2: "Map 1 - Total Kills by the Player", "Map 1 - Total Headshots by
 * the Player", "Map 1 - Round Handicap", "Map 1 - Total Rounds", "Map 1 -
 * Round 1" (pistolrundan), "Map 1" (kartvinnare), "Match Odds", "Map
 * Handicap", "Total Maps".
 */
export function marketOf(label: string, isPlayer: boolean): ParsedPropRow["market"] {
  const l = label.toLowerCase().replace(/\s+/g, " ").trim();
  const rest = l.replace(/^(?:map|karta) [123](?: ?[-–] ?)?/, "").trim();
  const onMap = scopeOf(label) !== "match";
  if (isPlayer) {
    if (/headshot|huvudskott/.test(l)) return "headshots";
    if (/first (?:kill|blood)|första kill/.test(l)) return "player_first_kill";
    if (/\bkills?\b/.test(l)) return "kills";
    return "other";
  }
  // Udda/jämnt, exakt resultat, övertid och "först till N rundor" finns inte i modellen.
  if (/odd\/even|udda|correct|korrekt|overtime|förlängning|first to \d|först till/.test(l)) return "other";
  if (/first (?:kill|blood)|första kill/.test(l)) return onMap ? "first_kill" : "other";
  if (/\bkills?\b|headshot/.test(l)) return "other";
  if (/pistol/.test(l) || /^(?:round|runda) 1$/.test(rest)) return onMap ? "pistol" : "other";
  if (/handicap|handikapp/.test(l)) return onMap ? "map_handicap" : "match_handicap";
  if (/total rounds|antal rundor/.test(l)) return onMap ? "rounds" : "other";
  if (/total maps|antal kartor/.test(l)) return "total_maps";
  if (rest === "" || /match odds|matchodds|winner|vinnare|moneyline/.test(l)) return onMap ? "map_winner" : "match_winner";
  return "other";
}

const OVER = new Set(["OT_OVER", "OT_YES"]);
const UNDER = new Set(["OT_UNDER", "OT_NO"]);

/**
 * Kambis marknader → rader i samma form som skärmdumpstolkningen. Lagmarknader
 * anges från lag 1:s sida (OT_ONE: team, line och overOdds; OT_TWO: underOdds).
 * Stängda utfall hoppas över; okända marknader blir "other" så att de syns men
 * inte sparas.
 */
export function mapBetOffers(offers: KambiBetOffer[], event: Pick<KambiEvent, "homeName" | "awayName">): ParsedPropRow[] {
  const rows: ParsedPropRow[] = [];
  for (const bo of offers) {
    const label = bo.criterion?.englishLabel ?? bo.criterion?.label ?? "";
    const scope = scopeOf(label);
    const isPlayer = isPlayerOffer(bo);
    const market = marketOf(label, isPlayer);
    const handicap = market === "map_handicap" || market === "match_handicap";
    const outs = (bo.outcomes ?? []).filter((o) => !o.status || o.status === "OPEN");
    // En betoffer kan innehålla flera spelare och flera linjer — gruppera.
    // Handikappens linje är spegelvänd per sida (-1.5 / +1.5): gruppera på absolutvärdet.
    const groups = new Map<string, KambiOutcome[]>();
    for (const o of outs) {
      const lineKey = o.line == null ? "" : String(handicap ? Math.abs(o.line) : o.line);
      const key = isPlayer ? `${o.participant ?? ""}|${lineKey}` : lineKey;
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const group of groups.values()) {
      const find = (...types: string[]) => group.find((o) => o.type && types.includes(o.type));
      let row: ParsedPropRow;
      if (find("OT_ONE") || find("OT_TWO")) {
        const one = find("OT_ONE");
        const two = find("OT_TWO");
        const line = one?.line ?? (two?.line != null ? -two.line : undefined);
        row = { market, scope, player: null, team: one?.participant ?? event.homeName ?? null, line: milli(line), overOdds: odds(one?.odds), underOdds: odds(two?.odds), includesOt: null };
      } else {
        const over = group.find((o) => o.type && OVER.has(o.type));
        const under = group.find((o) => o.type && UNDER.has(o.type));
        const player = isPlayer ? group[0].participant ?? null : null;
        row = { market, scope, player, team: null, line: milli((over ?? under)?.line), overOdds: odds(over?.odds), underOdds: odds(under?.odds), includesOt: null };
      }
      if (row.overOdds == null && row.underOdds == null) continue;
      rows.push(row);
    }
  }
  return rows;
}
