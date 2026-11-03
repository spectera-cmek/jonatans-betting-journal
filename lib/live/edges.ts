// Jämför ett bolags live-priser med Pinnacles rättvisa pris och håller reda
// på vilka värdefönster som är öppna, så att varje fönster larmar en gång.

import { staleEv } from "../nba/stale";
import type { LiveEvent, LiveKind, LiveMarket } from "./books";

const nick = (name: string) => name.trim().toLowerCase().split(/\s+/).pop() ?? "";

/** Kopplar bolagets matcher till Pinnacles via lagens smeknamn och starttid (±3 h). */
export function matchEvents(book: LiveEvent[], ref: LiveEvent[]): Array<{ book: LiveEvent; ref: LiveEvent }> {
  const out: Array<{ book: LiveEvent; ref: LiveEvent }> = [];
  for (const b of book) {
    const r = ref.find((x) => nick(x.home) === nick(b.home) && nick(x.away) === nick(b.away) && Math.abs(x.start - b.start) <= 3 * 3600e3);
    if (r) out.push({ book: b, ref: r });
  }
  return out;
}

export interface Edge {
  kind: LiveKind;
  line: number | null;
  side: 1 | 2;
  price: number;
  /** Rättvisa odds för vår sida enligt Pinnacle. */
  fairPrice: number;
  ev: number;
  /** Pinnacles linje som användes (samma linje, eller huvudlinjen omräknad). */
  refLine: number | null;
  sameLine: boolean;
}

/** Pinnacles pris på vår sida inom bandet — samma sållning som backtestet. */
const BAND: Record<LiveKind, [number, number]> = { ml: [1.05, 6], spread: [1.6, 2.5], total: [1.6, 2.5] };

export function findEdges(book: LiveEvent, ref: LiveEvent, minEv: number): Edge[] {
  const out: Edge[] = [];
  for (const m of book.markets) {
    const same = ref.markets.find((r) => r.kind === m.kind && r.line === m.line);
    const main = ref.markets.find((r) => r.kind === m.kind && !r.alt);
    const r: LiveMarket | undefined = same ?? main;
    if (!r) continue;
    // Bara när bolagets linje ligger nära Pinnacles huvudlinje (annars troligen fel koppling).
    if (m.kind !== "ml" && main?.line != null && m.line != null && Math.abs(m.line - main.line) > (m.kind === "spread" ? 3 : 4)) continue;
    const e = staleEv(m.kind, r, m);
    if (!e) continue;
    const side: 1 | 2 = e.ev1 >= e.ev2 ? 1 : 2;
    const ev = side === 1 ? e.ev1 : e.ev2;
    if (ev < minEv) continue;
    const win = side === 1 ? e.o.win1 : e.o.win2;
    const fairPrice = win > 0 ? (1 - e.o.push) / win : Infinity;
    if (fairPrice < BAND[m.kind][0] || fairPrice > BAND[m.kind][1]) continue;
    out.push({ kind: m.kind, line: m.line, side, price: side === 1 ? m.price1 : m.price2, fairPrice, ev, refLine: r.line, sameLine: !!same });
  }
  return out;
}

/**
 * Värdet av ett redan taget pris mot Pinnacles nuvarande rättvisa pris
 * (samma linje om den finns, annars huvudlinjen omräknad). För att mäta larm
 * mot Pinnacles sista pris före start.
 */
export function valueAgainst(ref: LiveEvent, kind: LiveKind, line: number | null, side: 1 | 2, price: number): { fairPrice: number; ev: number } | null {
  const same = ref.markets.find((r) => r.kind === kind && r.line === line);
  const r = same ?? ref.markets.find((x) => x.kind === kind && !x.alt);
  if (!r) return null;
  // Bara vår sida spelar roll; den andra får ett låtsaspris.
  const e = staleEv(kind, r, { line, price1: side === 1 ? price : 1.01, price2: side === 2 ? price : 1.01 });
  if (!e) return null;
  const win = side === 1 ? e.o.win1 : e.o.win2;
  return { fairPrice: win > 0 ? (1 - e.o.push) / win : Infinity, ev: side === 1 ? e.ev1 : e.ev2 };
}

export interface OpenWindow {
  key: string;
  edge: Edge;
  openedAt: number;
  maxEv: number;
  /** EV vid senaste larmet (nytt larm om EV stiger tydligt). */
  notifiedEv: number;
}

/**
 * Uppdaterar öppna fönster med kvällens nya kantlista. Returnerar vilka som
 * ska larma (nya, eller EV upp minst `bump`) och vilka som stängts.
 */
export function updateWindows(
  open: Map<string, OpenWindow>,
  current: Array<{ key: string; edge: Edge }>,
  now: number,
  bump = 0.02
): { alert: OpenWindow[]; closed: OpenWindow[] } {
  const alert: OpenWindow[] = [];
  const seen = new Set<string>();
  for (const { key, edge } of current) {
    seen.add(key);
    const w = open.get(key);
    if (!w) {
      const nw: OpenWindow = { key, edge, openedAt: now, maxEv: edge.ev, notifiedEv: edge.ev };
      open.set(key, nw);
      alert.push(nw);
    } else {
      w.edge = edge;
      w.maxEv = Math.max(w.maxEv, edge.ev);
      if (edge.ev >= w.notifiedEv + bump) {
        w.notifiedEv = edge.ev;
        alert.push(w);
      }
    }
  }
  const closed: OpenWindow[] = [];
  for (const [k, w] of open) if (!seen.has(k)) {
    closed.push(w);
    open.delete(k);
  }
  return { alert, closed };
}

export const edgeKey = (brand: string, eventId: string, e: Edge) => `${brand}|${eventId}|${e.kind}|${e.line}|${e.side}`;

/** "Pistons −1,5 @ 1,92 (rättvist 1,84) +4,3 %" — kort text för notisen. */
export function describeEdge(ev: LiveEvent, e: Edge): string {
  const dec = (x: number, d = 2) => x.toFixed(d).replace(".", ",");
  const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${dec(Math.abs(x), 1)}`;
  const who =
    e.kind === "total"
      ? `${e.side === 1 ? "Över" : "Under"} ${dec(e.line!, 1)}`
      : e.kind === "ml"
        ? `${e.side === 1 ? ev.home : ev.away} vinner`
        : `${e.side === 1 ? ev.home : ev.away} ${signed(e.side === 1 ? e.line! : -e.line!)}`;
  return `${who} @ ${dec(e.price)} (rättvist ${dec(e.fairPrice)}) +${dec(e.ev * 100, 1)} %`;
}
