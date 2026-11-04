// Sega linjer: ett bolags pris mot Pinnacles rättvisa pris vid samma tidpunkt.
//
// Pinnacles pris utan marginal är marknadens bästa gissning. När ett annat
// bolag inte hunnit flytta sin linje (eller prisar annorlunda) kan dess odds
// vara bättre än det rättvisa priset — en edge utan någon modell.
//
// Olika linjer (bolaget −4, Pinnacle −5,5) räknas om med en normalfördelning
// kring Pinnacles implicita väntevärde: marginalen ~ N(μ, 14), totalen ~ N(μ, 18).
// Heltalslinjer får push-sannolikhet (poängen är heltal).

import { normalCdf } from "../variance";
import type { NbaMarket } from "./pricing";

/** Spridning kring marknadens linje (NBA, efter linjen): marginal och total. */
export const STALE_SIGMA = { spread: 14, total: 18 } as const;

/** Φ⁻¹ med bisektion — snabbt nog och utan approximationsfel att tala om. */
export function invNormalCdf(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Rättvis P(sida 1) med power-metoden: (1/o1)^k + (1/o2)^k = 1. Drar mer marginal
 * från underdogen än proportionell avviggning, som marknaden faktiskt prisar
 * (favorite–longshot bias) — annars ser EV på långa odds för bra ut.
 */
export function devigPower(o1: number, o2: number): number | null {
  if (!(o1 > 1) || !(o2 > 1)) return null;
  const a = 1 / o1;
  const b = 1 / o2;
  let lo = 0.2;
  let hi = 5;
  for (let i = 0; i < 80; i++) {
    const k = (lo + hi) / 2;
    if (a ** k + b ** k > 1) lo = k;
    else hi = k;
  }
  const k = (lo + hi) / 2;
  return a ** k / (a ** k + b ** k);
}

export interface Outcome {
  /** P(sida 1 vinner), P(push), P(sida 2 vinner). */
  win1: number;
  push: number;
  win2: number;
}

const isWhole = (x: number) => Math.abs(x - Math.round(x)) < 1e-9;

/**
 * Marknadens väntevärde ur Pinnacles rättvisa P(sida 1) på `refLine`, i
 * "Y-enheter": spread Y = hemmalagets marginal, total Y = totalen.
 */
export function impliedMean(market: "spread" | "total", refLine: number, pRef: number, sigma = STALE_SIGMA[market]): number {
  // Spread: hemma täcker när marginal + L > 0. Total: över när total − L > 0.
  // Skriv båda som Y − k > 0 med Y ~ N(μ, σ): spread Y = marginal, k = −L; total Y = total, k = L.
  const k = market === "spread" ? -refLine : refLine;
  return k + sigma * invNormalCdf(pRef);
}

/** Sannolikheter på linjen `line` när Y ~ N(μ, σ). Heltalslinjer får push. */
export function outcomeFromMean(market: "spread" | "total", mu: number, line: number, sigma = STALE_SIGMA[market]): Outcome {
  const kk = market === "spread" ? -line : line;
  if (isWhole(line)) {
    const win1 = 1 - normalCdf((kk + 0.5 - mu) / sigma);
    const win2 = normalCdf((kk - 0.5 - mu) / sigma);
    return { win1, push: Math.max(0, 1 - win1 - win2), win2 };
  }
  const win1 = 1 - normalCdf((kk - mu) / sigma);
  return { win1, push: 0, win2: 1 - win1 };
}

/**
 * Sannolikheter på linjen `line` utifrån Pinnacles rättvisa P(sida 1) på `refLine`.
 * Spread: hemmalagets handicap, sida 1 = hemma. Total: sida 1 = över.
 */
export function outcomeAt(market: "spread" | "total", refLine: number, pRef: number, line: number, sigma = STALE_SIGMA[market]): Outcome {
  return outcomeFromMean(market, impliedMean(market, refLine, pRef, sigma), line, sigma);
}

export interface Quote {
  line: number | null;
  price1: number;
  price2: number;
}

/** EV per satsad enhet för båda sidor hos `book`, mot Pinnacles rättvisa pris `ref`. */
export function staleEv(market: NbaMarket, ref: Quote, book: Quote): { ev1: number; ev2: number; o: Outcome } | null {
  const p = devigPower(ref.price1, ref.price2);
  if (p == null) return null;
  let o: Outcome;
  if (market === "ml") o = { win1: p, push: 0, win2: 1 - p };
  else {
    if (ref.line == null || book.line == null) return null;
    o = outcomeAt(market, ref.line, p, book.line);
  }
  return { ev1: book.price1 * o.win1 + o.push - 1, ev2: book.price2 * o.win2 + o.push - 1, o };
}
