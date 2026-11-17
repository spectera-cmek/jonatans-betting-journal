// Prop-priser ur OddsPapi-historiken: varje bok, spelare (OddsPapi-id),
// statistik och linje som en tidsserie relativt avspark. Rena funktioner —
// skriptet nba:props-history läser cachen och sparar ett kompakt dataset.
//
// Historikens prop-marknader är en stege: ett marknads-id per statistik och
// linje (111684 = poäng 7,5). Katalogen i ids.json tolkas ALLTID om med
// reclassifyPropMarkets — där ligger "3 Point FG"-stegen som poäng.

import type { OpHistoricalOdds } from "../oddspapi";
import type { PropMarketSpec, PropStatKey } from "../oddspapi/markets";

/** [sekunder relativt avspark (negativt = före), pris, maxinsats eller null, aktiv 0/1] */
export type HistEntry = [number, number, number | null, 0 | 1];

export interface RungSeries {
  o: HistEntry[];
  u: HistEntry[];
}

/** linje (som text) → serie */
export type StatRungs = Record<string, RungSeries>;
/** bok → OddsPapi-spelar-id → statistik → linje → serie */
export type PropSeriesByBook = Record<string, Record<string, Partial<Record<PropStatKey, StatRungs>>>>;

export interface PriceAt {
  price: number;
  maxStake: number | null;
}

/** Senaste händelsen vid eller före t. Stängd (active 0) = inget pris — ta inte ett äldre. */
export function priceAt(entries: HistEntry[] | undefined, tSec: number): PriceAt | null {
  if (!entries?.length) return null;
  let last: HistEntry | null = null;
  for (const e of entries) {
    if (e[0] > tSec) break;
    last = e;
  }
  if (!last || last[3] !== 1 || !(last[1] > 1)) return null;
  return { price: last[1], maxStake: last[2] };
}

export interface RungQuote {
  line: number;
  over: number;
  under: number;
  /** Lägsta maxinsatsen av sidorna (Pinnacle), annars null. */
  maxStake: number | null;
}

/** Alla linjer som gick att spela (båda sidor öppna) vid t. */
export function snapshotAt(rungs: StatRungs | undefined, tSec: number): RungQuote[] {
  const out: RungQuote[] = [];
  for (const [line, s] of Object.entries(rungs ?? {})) {
    const o = priceAt(s.o, tSec);
    const u = priceAt(s.u, tSec);
    if (!o || !u) continue;
    const stakes = [o.maxStake, u.maxStake].filter((x): x is number => x != null);
    out.push({ line: Number(line), over: o.price, under: u.price, maxStake: stakes.length ? Math.min(...stakes) : null });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Huvudlinjen: den mest jämna (samma regel som pickMainLines för matchlinjer). */
export function mainRung(quotes: RungQuote[]): RungQuote | null {
  if (!quotes.length) return null;
  const evenness = (q: RungQuote) => Math.abs(1 / q.over - 1 / q.under);
  return quotes.reduce((a, b) => (evenness(b) < evenness(a) ? b : a));
}

/** Första tidpunkten då någon linje gick att spela, eller null. */
export function firstOpen(rungs: StatRungs | undefined): number | null {
  const times = new Set<number>();
  for (const s of Object.values(rungs ?? {})) for (const e of [...s.o, ...s.u]) times.add(e[0]);
  for (const t of [...times].sort((a, b) => a - b)) if (snapshotAt(rungs, t).length) return t;
  return null;
}

/**
 * Prop-serierna för en match. Med `windowSec` sparas bara händelser i
 * [start − window, start) plus den sista före fönstret (tillståndet när det öppnar).
 */
export function extractPropSeries(
  h: OpHistoricalOdds | null,
  propMarkets: Record<string, PropMarketSpec>,
  books: string[],
  startMs: number,
  windowSec = 36 * 3600
): PropSeriesByBook {
  const out: PropSeriesByBook = {};
  if (!h?.bookmakers) return out;
  for (const book of books) {
    const b = h.bookmakers[book];
    if (!b) continue;
    for (const [marketId, mk] of Object.entries(b.markets ?? {})) {
      const spec = propMarkets[marketId];
      if (!spec || spec.line == null) continue;
      const lineKey = String(spec.line);
      for (const [outcomeId, oc] of Object.entries(mk.outcomes ?? {})) {
        const side = spec.sides[outcomeId];
        if (!side) continue;
        for (const [pid, series] of Object.entries(oc.players ?? {})) {
          if (pid === "0" || !Array.isArray(series) || !series.length) continue;
          const all: HistEntry[] = [];
          for (const e of series) {
            const t = Date.parse(e.createdAt);
            if (!Number.isFinite(t) || !(e.price > 0)) continue;
            all.push([Math.round((t - startMs) / 1000), e.price, typeof e.limit === "number" ? e.limit : null, e.active === false ? 0 : 1]);
          }
          all.sort((a, b) => a[0] - b[0]);
          const from = -windowSec;
          let i0 = all.findIndex((e) => e[0] >= from);
          if (i0 === -1) i0 = all.length;
          const kept = [...(i0 > 0 ? [[from, ...all[i0 - 1].slice(1)] as HistEntry] : []), ...all.slice(i0).filter((e) => e[0] < 0)];
          if (!kept.length) continue;
          const byPid = (out[book] ??= {});
          const byStat = (byPid[pid] ??= {});
          const rungs = (byStat[spec.stat] ??= {});
          const rs = (rungs[lineKey] ??= { o: [], u: [] });
          if (side === 1) rs.o = kept;
          else rs.u = kept;
        }
      }
    }
  }
  return out;
}

/** Marknads-id med spelarnycklar som katalogen inte känner till (för täckningsrapporten). */
export function unknownPlayerMarkets(h: OpHistoricalOdds | null, known: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of Object.values(h?.bookmakers ?? {})) {
    for (const [marketId, mk] of Object.entries(b.markets ?? {})) {
      if (known[marketId]) continue;
      const players = new Set<string>();
      for (const oc of Object.values(mk.outcomes ?? {})) for (const pid of Object.keys(oc.players ?? {})) if (pid !== "0") players.add(pid);
      if (players.size) out.set(marketId, (out.get(marketId) ?? 0) + players.size);
    }
  }
  return out;
}

/** Tidpunkterna i datasetet (sekunder före avspark). close = 1 min före. */
export const SNAPSHOT_TIMES: Record<string, number> = { "-6h": -6 * 3600, "-3h": -3 * 3600, "-1h": -3600, close: -60 };
