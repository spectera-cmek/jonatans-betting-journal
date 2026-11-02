// Från simulerad poängfördelning till fair odds och edge mot ett pris.
//
// Samma väg som CS2 och skottmodellen: modellens sannolikhet (betingad på
// ingen push) vägs mot bokens avviggade pris med priceTwoWay, och edge är EV
// per satsad enhet med insatsen tillbaka vid push. Sida 1 = hemma/över.

import { priceTwoWay, type Price } from "../cs2/pricing";
import { DEFAULT_NBA_BLEND_W } from "./params";
import { moneylineProb, spreadProb, totalProb, type SimResult } from "./sim";
import { netPrice, SMARKETS_BOOK, SMARKETS_COMMISSION } from "../smarkets";

/** Provision på nettovinst för börser. Edge räknas på vad du faktiskt får ut. */
export function commissionOf(book: string | null | undefined): number {
  return book === SMARKETS_BOOK ? SMARKETS_COMMISSION : 0;
}

export type NbaMarket = "ml" | "spread" | "total";

export interface MarketQuote {
  market: NbaMarket;
  /** Spread: hemmalagets handicap. Total: totalen. ml: null. */
  line: number | null;
  price1: number | null;
  price2: number | null;
  book?: string | null;
}

export interface MarketPrice extends Price {
  market: NbaMarket;
  line: number | null;
  blendW: number;
  book: string | null;
  price1: number | null;
  price2: number | null;
}

/** Modellens P(sida 1 | ingen push) och P(push) för en marknad. */
export function modelProb(sim: SimResult, market: NbaMarket, line: number | null): { p: number; push: number } {
  if (market === "ml") return { p: moneylineProb(sim), push: 0 };
  if (line == null) throw new Error(`${market} kräver en linje`);
  return market === "spread" ? spreadProb(sim, line) : totalProb(sim, line);
}

export function priceMarket(sim: SimResult, q: MarketQuote, blendW = DEFAULT_NBA_BLEND_W[q.market]): MarketPrice {
  const m = modelProb(sim, q.market, q.line);
  const c = commissionOf(q.book);
  const net = (x: number | null) => (x != null && c > 0 ? netPrice(x, c) : x);
  const price = priceTwoWay(m.p, m.push, net(q.price1), net(q.price2), blendW);
  // Visa bolagets riktiga odds; edgen ovan är redan räknad efter provision.
  const bestOdds = price.bestSide === "over" ? q.price1 : price.bestSide === "under" ? q.price2 : null;
  return { ...price, bestOdds, market: q.market, line: q.line, blendW, book: q.book ?? null, price1: q.price1, price2: q.price2 };
}

/**
 * Modellens egen linje: den spread/total (på halvpoäng) där P(sida 1) ligger
 * närmast 50 %. Visas bredvid marknadens linje.
 */
export function fairLine(sim: SimResult, market: "spread" | "total"): number {
  const n = sim.sims;
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = market === "spread" ? sim.away[i] - sim.home[i] : sim.home[i] + sim.away[i];
  vals.sort();
  const median = vals[Math.floor(n / 2)];
  return Math.round(median * 2) / 2;
}

/** Utfall för facit: 1 = sida 1 vann, 0 = sida 2, 0,5 = push. */
export function settle(market: NbaMarket, line: number | null, homeScore: number, awayScore: number): number {
  if (market === "ml") return homeScore > awayScore ? 1 : 0;
  const x = market === "spread" ? homeScore - awayScore + (line ?? 0) : homeScore + awayScore - (line ?? 0);
  return x > 0 ? 1 : x < 0 ? 0 : 0.5;
}
