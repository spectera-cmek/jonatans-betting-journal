// OddsPapi-marknader för basket: vilka marketId som är moneyline, spread och
// total, och hur oddsen i ett svar blir rader med pris för sida 1 och 2.
//
// OddsPapi ger varje linje ett eget marketId (t.ex. "Totals 224.5"), och
// linjen står i katalogens `handicap`. Katalogen (/v4/markets) hämtas en gång
// av `npm run oddspapi:discover` och sparas i lib/oddspapi/ids.json, så att
// den dagliga körningen inte bränner kvot på den.
//
// Konvention här: sida 1 = participant1 (spread/ml) eller över (total). För
// spread är linjen participant1:s handicap. Orienteringen mot ESPN:s hemmalag
// görs i orientRows.

import fs from "node:fs";
import path from "node:path";
import type { OpFixtureOdds, OpHistoricalOdds, OpMarket } from "../oddspapi";

export type NbaMarketKind = "ml" | "spread" | "total";

export interface MarketSpec {
  kind: NbaMarketKind;
  /** Linjen ur katalogen: participant1:s handicap eller totalen. null för ml. */
  line: number | null;
  /** outcomeId → sida. */
  sides: Record<string, 1 | 2>;
  name?: string;
}

export interface OddspapiIds {
  generatedAt: string;
  bookmaker: string;
  nba: { tournamentId: number; tournamentName: string } | null;
  /** marketId → spec, bara basketmarknader för hela matchen inkl. förlängning. */
  basketballMarkets: Record<string, MarketSpec>;
  /** marketId → spec för spelarprops (poäng, returer, assist, trepoängare, PRA). */
  basketballPropMarkets?: Record<string, PropMarketSpec>;
  /** Om boken har props i din plan (ur /v4/account). */
  bookHasPlayerProps?: boolean;
  /** Fotbollsturneringar för nästa modell, namn → id. */
  footballTournaments?: Record<string, number>;
}

export const IDS_PATH = path.join("lib", "oddspapi", "ids.json");

/** Läser ids.json från arbetskatalogen, eller null om discover inte körts. */
export function loadIds(cwd = process.cwd()): OddspapiIds | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, IDS_PATH), "utf8")) as OddspapiIds;
  } catch {
    return null;
  }
}

const PARTIAL = /half|quarter|\b(1st|2nd|3rd|4th)\b|\bq[1-4]\b|\bh[12]\b|regulation|regular time|excl/i;
const NOT_GAME = /team total|home total|away total|player|race|\bodd\b|\beven\b|margin|exact|band|winning|3.?way|draw|both|first|last|highest|lowest|double/i;

function sideOf(name: string, index: number, kind: NbaMarketKind): 1 | 2 | null {
  const n = name.trim().toLowerCase();
  if (kind === "total") {
    if (/over|^o$/.test(n)) return 1;
    if (/under|^u$/.test(n)) return 2;
    return null;
  }
  if (/^(1|home|team ?1|p1)\b/.test(n)) return 1;
  if (/^(2|away|team ?2|p2)\b/.test(n)) return 2;
  return index === 0 ? 1 : index === 1 ? 2 : null;
}

/**
 * Klassar en katalogmarknad. Bara hela matchen (inkl. förlängning) och två
 * utfall räknas — perioder, lagtotaler, 3-vägs och props sorteras bort.
 */
export function classifyBasketballMarket(m: OpMarket): MarketSpec | null {
  if (m.sportId !== 11 || m.playerProp) return null;
  if (!m.outcomes || m.outcomes.length !== 2) return null;
  if (PARTIAL.test(m.period ?? "") || PARTIAL.test(m.marketName)) return null;
  if (NOT_GAME.test(m.marketName)) return null;
  const type = (m.marketType ?? "").toLowerCase();
  const name = m.marketName.toLowerCase();
  const outs = m.outcomes.map((o) => o.outcomeName.toLowerCase());
  let kind: NbaMarketKind | null = null;
  // Ordningen spelar roll: "moneyline" innehåller "line", så vinnarmarknaden
  // måste kännas igen före spread (OddsPapi: 111 "Winner (incl. overtime)",
  // marketType "moneyline").
  if (outs.some((o) => /over/.test(o)) && outs.some((o) => /under/.test(o))) kind = "total";
  else if (/moneyline|money line|winner|^12$|1x2|home.?away|match odds/.test(type + " " + name)) kind = "ml";
  else if (/handicap|spread|\bline\b/.test(type) || /handicap|spread/.test(name)) kind = "spread";
  if (!kind) return null;
  const hc = Number.isFinite(m.handicap) ? m.handicap : 0;
  if (kind === "ml" && hc !== 0) kind = "spread";
  const sides: Record<string, 1 | 2> = {};
  m.outcomes.forEach((o, i) => {
    const s = sideOf(o.outcomeName, i, kind!);
    if (s) sides[String(o.outcomeId)] = s;
  });
  if (Object.keys(sides).length !== 2 || new Set(Object.values(sides)).size !== 2) return null;
  return { kind, line: kind === "ml" ? null : hc, sides, name: m.marketName };
}

export function buildMarketMap(catalog: OpMarket[]): Record<string, MarketSpec> {
  const out: Record<string, MarketSpec> = {};
  for (const m of catalog) {
    const spec = classifyBasketballMarket(m);
    if (spec) out[String(m.marketId)] = spec;
  }
  return out;
}

export interface LineRow {
  kind: NbaMarketKind;
  /** Spread: sida 1:s handicap. Total: totalen. ml: null. */
  line: number | null;
  price1: number;
  price2: number;
  mainLine: boolean;
}

const okPrice = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p > 1;

/**
 * Lägsta rimliga total för en hel NBA-match. OddsPapi ger lagtotaler och
 * halvlekstotaler samma marknadsnamn som matchens total ("Over Under (incl.
 * overtime)", linjer från 100,5) — de sorteras bort här, annars kan 113,5
 * väljas som "matchens total".
 */
export const MIN_GAME_TOTAL = 150;

/** Linjen ur bokens egen outcome-id ("224.5/over"), när katalogen saknar den. */
function lineFromOutcomeId(id: string | null | undefined): number | null {
  const m = /^(-?\d+(?:\.\d+)?)\//.exec(id ?? "");
  return m ? Number(m[1]) : null;
}

/** Alla prissatta linjer för en bok i ett odds-svar. */
export function extractLines(fx: OpFixtureOdds, book: string, markets: Record<string, MarketSpec>): LineRow[] {
  const b = fx.bookmakerOdds?.[book];
  if (!b || b.suspended || b.bookmakerIsActive === false) return [];
  const out: LineRow[] = [];
  for (const [marketId, mk] of Object.entries(b.markets ?? {})) {
    const spec = markets[marketId];
    if (!spec || mk.marketActive === false) continue;
    let p1: number | null = null;
    let p2: number | null = null;
    let main = false;
    let line = spec.line;
    for (const [outcomeId, oc] of Object.entries(mk.outcomes ?? {})) {
      const side = spec.sides[outcomeId];
      const pl = oc.players?.["0"] ?? Object.values(oc.players ?? {})[0];
      if (!side || !pl || pl.active === false || !okPrice(pl.price)) continue;
      if (side === 1) p1 = pl.price;
      else p2 = pl.price;
      if (pl.mainLine) main = true;
      if (line == null && spec.kind !== "ml" && side === 1) line = lineFromOutcomeId(pl.bookmakerOutcomeId);
    }
    if (p1 == null || p2 == null) continue;
    if (spec.kind !== "ml" && line == null) continue;
    if (spec.kind === "total" && (line ?? 0) < MIN_GAME_TOTAL) continue;
    out.push({ kind: spec.kind, line, price1: p1, price2: p2, mainLine: main });
  }
  return out;
}

/**
 * Stängningspriset ur historiken: senaste aktiva pris före matchstart per
 * utfall. Historiken säger inget om huvudlinje, så pickMainLines väljer den
 * jämnaste.
 */
export function closingFromHistory(
  h: OpHistoricalOdds,
  book: string,
  markets: Record<string, MarketSpec>,
  startTime: Date,
  stats?: { suspended: number }
): LineRow[] {
  const b = h?.bookmakers?.[book];
  if (!b) return [];
  const cutoff = startTime.getTime();
  const out: LineRow[] = [];
  for (const [marketId, mk] of Object.entries(b.markets ?? {})) {
    const spec = markets[marketId];
    if (!spec) continue;
    const prices: Partial<Record<1 | 2, number>> = {};
    for (const [outcomeId, oc] of Object.entries(mk.outcomes ?? {})) {
      const side = spec.sides[outcomeId];
      const series = oc.players?.["0"] ?? Object.values(oc.players ?? {})[0];
      if (!side || !Array.isArray(series)) continue;
      // Senaste händelsen före tidpunkten. Var marknaden stängd då (active: false)
      // gick priset inte att spela — ta inte ett äldre pris i stället.
      let last: { t: number; price: number; active: boolean } | null = null;
      for (const e of series) {
        const t = Date.parse(e.createdAt);
        if (!Number.isFinite(t) || t > cutoff) continue;
        if (!last || t > last.t) last = { t, price: e.price, active: e.active !== false };
      }
      if (last && !last.active && stats) stats.suspended++;
      if (last?.active && okPrice(last.price)) prices[side] = last.price;
    }
    if (spec.kind === "total" && (spec.line ?? 0) < MIN_GAME_TOTAL) continue;
    if (prices[1] && prices[2] && (spec.kind === "ml" || spec.line != null)) {
      out.push({ kind: spec.kind, line: spec.line, price1: prices[1], price2: prices[2], mainLine: false });
    }
  }
  return out;
}

/** En linje per marknad: bokens huvudlinje, annars den mest jämna. */
export function pickMainLines(rows: LineRow[]): LineRow[] {
  const out: LineRow[] = [];
  for (const kind of ["ml", "spread", "total"] as NbaMarketKind[]) {
    const c = rows.filter((r) => r.kind === kind);
    if (!c.length) continue;
    const mains = c.filter((r) => r.mainLine);
    const pool = mains.length ? mains : c;
    const evenness = (r: LineRow) => Math.abs(1 / r.price1 - 1 / r.price2);
    out.push(pool.reduce((a, b) => (evenness(b) < evenness(a) ? b : a)));
  }
  return out;
}

/** Vänder raderna så att sida 1 = ESPN:s hemmalag. Totals påverkas inte. */
export function orientRows(rows: LineRow[], participant1IsHome: boolean): LineRow[] {
  if (participant1IsHome) return rows;
  return rows.map((r) =>
    r.kind === "total" ? r : { ...r, price1: r.price2, price2: r.price1, line: r.line == null ? null : -r.line }
  );
}

// ---------------------------------------------------------------------------
// Spelarprops (basket)
// ---------------------------------------------------------------------------

export type PropStatKey = "pts" | "reb" | "ast" | "fg3" | "pra";

export interface PropMarketSpec {
  stat: PropStatKey;
  /** Linjen ur katalogen, eller null om den står i bokens outcome-id. */
  line: number | null;
  /** outcomeId → 1 (över) / 2 (under). */
  sides: Record<string, 1 | 2>;
  name?: string;
}

/** Vilken statistik en prop-marknad gäller, ur namnet. */
export function propStatOf(name: string): PropStatKey | null {
  const n = name.toLowerCase();
  if (/double|triple|first|1st|2nd|3rd|4th|quarter|half|steal|block|turnover|made field|free throw/.test(n)) return null;
  const pts = /point|pts/.test(n);
  const reb = /rebound|reb\b/.test(n);
  const ast = /assist|ast\b/.test(n);
  if (/three|3-?point|3pt|threes/.test(n) && !reb && !ast) return "fg3";
  if (pts && reb && ast) return "pra";
  if (/\bpra\b/.test(n)) return "pra";
  if (pts && !reb && !ast) return "pts";
  if (reb && !pts && !ast) return "reb";
  if (ast && !pts && !reb) return "ast";
  return null;
}

export function classifyBasketballProp(m: OpMarket): PropMarketSpec | null {
  if (m.sportId !== 11 || !m.playerProp) return null;
  if (!m.outcomes || m.outcomes.length !== 2) return null;
  if (PARTIAL.test(m.period ?? "") || PARTIAL.test(m.marketName)) return null;
  const stat = propStatOf(m.marketName);
  if (!stat) return null;
  const sides: Record<string, 1 | 2> = {};
  for (const o of m.outcomes) {
    const n = o.outcomeName.toLowerCase();
    if (/over|^o$/.test(n)) sides[String(o.outcomeId)] = 1;
    else if (/under|^u$/.test(n)) sides[String(o.outcomeId)] = 2;
  }
  if (Object.keys(sides).length !== 2) return null;
  const hc = Number.isFinite(m.handicap) && m.handicap > 0 ? m.handicap : null;
  return { stat, line: hc, sides, name: m.marketName };
}

export function buildPropMarketMap(catalog: OpMarket[]): Record<string, PropMarketSpec> {
  const out: Record<string, PropMarketSpec> = {};
  for (const m of catalog) {
    const spec = classifyBasketballProp(m);
    if (spec) out[String(m.marketId)] = spec;
  }
  return out;
}

export interface PropLineRow {
  stat: PropStatKey;
  playerName: string;
  line: number;
  over: number;
  under: number;
}

/** Alla prop-linjer för en bok i ett odds-svar, en rad per spelare och linje. */
export function extractPropLines(fx: OpFixtureOdds, book: string, markets: Record<string, PropMarketSpec>): PropLineRow[] {
  const b = fx.bookmakerOdds?.[book];
  if (!b || b.suspended || b.bookmakerIsActive === false) return [];
  const out: PropLineRow[] = [];
  for (const [marketId, mk] of Object.entries(b.markets ?? {})) {
    const spec = markets[marketId];
    if (!spec || mk.marketActive === false) continue;
    // Spelarna står som "players" under varje utfall — para ihop över och under per spelare.
    const byPlayer = new Map<string, { name: string; over?: number; under?: number; line: number | null }>();
    for (const [outcomeId, oc] of Object.entries(mk.outcomes ?? {})) {
      const side = spec.sides[outcomeId];
      if (!side) continue;
      for (const [key, pl] of Object.entries(oc.players ?? {})) {
        if (!pl || pl.active === false || !okPrice(pl.price) || !pl.playerName) continue;
        const e = byPlayer.get(key) ?? { name: pl.playerName, line: spec.line ?? lineFromOutcomeId(pl.bookmakerOutcomeId) };
        if (side === 1) e.over = pl.price;
        else e.under = pl.price;
        byPlayer.set(key, e);
      }
    }
    byPlayer.forEach((e) => {
      if (e.over && e.under && e.line != null) out.push({ stat: spec.stat, playerName: e.name, line: e.line, over: e.over, under: e.under });
    });
  }
  return out;
}

/** "Luka Dončić Jr." → "luka doncic" — för att para OddsPapi-namn med ESPN. */
export function normalizeName(name: string): string {
  // OddsPapi skriver "Reaves, Austin" — vänd till "Austin Reaves" som ESPN.
  const m = /^\s*([^,]+),\s*(.+)$/.exec(name);
  const ordered = m ? `${m[2]} ${m[1]}` : name;
  return ordered
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`-]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
