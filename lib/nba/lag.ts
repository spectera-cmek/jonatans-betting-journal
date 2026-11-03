// Värdefönster: perioder då ett bolags pris är bättre än Pinnacles rättvisa
// pris på samma linje. Byggs ur OddsPapi-historikens tidsstämplade prisändringar.
//
// Ett fönster öppnar när bolagets EV mot Pinnacle (power-avviggat) når
// tröskeln, och stänger när EV faller under den, en marknad stängs eller
// matchen börjar. Vem som stängde det (bolaget flyttade eller Pinnacle flyttade
// tillbaka) och spelets värde mot Pinnacles stängning visar om det var äkta.

import type { OpHistoryEntry } from "../oddspapi";
import { devigPower } from "./stale";

export interface Series {
  /** Pinnacles sida 1 och 2, bolagets sida 1 och 2. */
  ref1: OpHistoryEntry[];
  ref2: OpHistoryEntry[];
  book1: OpHistoryEntry[];
  book2: OpHistoryEntry[];
}

export interface ValueWindow {
  side: 1 | 2;
  openedAt: number;
  closedAt: number;
  /** Bolagets odds och EV när fönstret öppnade. */
  price: number;
  ev: number;
  maxEv: number;
  /** Vad som stängde fönstret. */
  closedBy: "book" | "ref" | "suspended" | "start";
  /** Spelet (bolagets odds vid öppning) mot Pinnacles sista rättvisa pris före start. */
  evClose: number | null;
}

type Key = keyof Series;
const KEYS: Key[] = ["ref1", "ref2", "book1", "book2"];

const ok = (p: number) => Number.isFinite(p) && p > 1.01 && p < 100;

/**
 * Går igenom alla prisändringar i [from, start) och returnerar fönstren.
 * `priceBand`: bara fönster där Pinnacles pris på vår sida ligger inom bandet
 * (sållar bort tunna alternativa linjer långt från huvudlinjen).
 */
export function valueWindows(
  s: Series,
  opts: { from: number; start: number; minEv: number; priceBand?: [number, number] }
): ValueWindow[] {
  const events: Array<{ t: number; k: Key; price: number; active: boolean }> = [];
  for (const k of KEYS)
    for (const e of s[k]) {
      const t = Date.parse(e.createdAt);
      if (Number.isFinite(t) && t < opts.start) events.push({ t, k, price: e.price, active: e.active !== false });
    }
  events.sort((a, b) => a.t - b.t);
  const cur: Partial<Record<Key, { price: number; active: boolean }>> = {};
  const live = (k: Key) => {
    const c = cur[k];
    return c && c.active && ok(c.price) ? c.price : null;
  };
  const state = () => {
    const r1 = live("ref1");
    const r2 = live("ref2");
    const b1 = live("book1");
    const b2 = live("book2");
    if (r1 == null || r2 == null || b1 == null || b2 == null) return null;
    const p = devigPower(r1, r2);
    if (p == null) return null;
    return { p, r1, r2, ev1: b1 * p - 1, ev2: b2 * (1 - p) - 1, b1, b2 };
  };

  const out: ValueWindow[] = [];
  let open: ValueWindow | null = null;
  const closeAt = (t: number, by: ValueWindow["closedBy"]) => {
    if (!open) return;
    open.closedAt = t;
    open.closedBy = by;
    out.push(open);
    open = null;
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    cur[e.k] = { price: e.price, active: e.active };
    // Flera ändringar med samma tidsstämpel räknas som en.
    if (i + 1 < events.length && events[i + 1].t === e.t) continue;
    if (e.t < opts.from) continue;
    const st = state();
    if (open) {
      const w: ValueWindow = open;
      if (!st) {
        closeAt(e.t, "suspended");
      } else {
        const ev = w.side === 1 ? st.ev1 : st.ev2;
        if (ev < opts.minEv) closeAt(e.t, e.k.startsWith("book") ? "book" : "ref");
        else w.maxEv = Math.max(w.maxEv, ev);
      }
    }
    if (!open && st) {
      const side: 1 | 2 = st.ev1 >= st.ev2 ? 1 : 2;
      const ev = side === 1 ? st.ev1 : st.ev2;
      const refPrice = side === 1 ? st.r1 : st.r2;
      const inBand = !opts.priceBand || (refPrice >= opts.priceBand[0] && refPrice <= opts.priceBand[1]);
      if (ev >= opts.minEv && inBand) {
        open = { side, openedAt: e.t, closedAt: e.t, price: side === 1 ? st.b1 : st.b2, ev, maxEv: ev, closedBy: "start", evClose: null };
      }
    }
  }
  closeAt(opts.start, "start");

  // Spelets värde mot Pinnacles sista rättvisa pris före start.
  const lastRef = (arr: OpHistoryEntry[]) => {
    let best: { t: number; price: number; active: boolean } | null = null;
    for (const e of arr) {
      const t = Date.parse(e.createdAt);
      if (Number.isFinite(t) && t < opts.start && (!best || t > best.t)) best = { t, price: e.price, active: e.active !== false };
    }
    return best && ok(best.price) ? best.price : null;
  };
  const c1 = lastRef(s.ref1);
  const c2 = lastRef(s.ref2);
  const pClose = c1 != null && c2 != null ? devigPower(c1, c2) : null;
  for (const w of out) if (pClose != null) w.evClose = w.price * (w.side === 1 ? pClose : 1 - pClose) - 1;
  return out;
}
