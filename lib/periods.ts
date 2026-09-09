// Trailing-window selectors, shared by the dashboard's curve and the analysis
// surfaces. A journal that spans several seasons contains more than one era; an
// average over all of it describes none of them, so every surface that draws
// conclusions from the history gets to say which stretch it means.
//
// Pure & dependency-free.

import type { BetLike } from "./betting";

export interface Period {
  key: string;
  label: string;
  /** Trailing window in days; null = the whole history. */
  days: number | null;
}

/** Dashboard curve: short windows, for "how is it going right now". */
export const CHART_PERIODS: Period[] = [
  { key: "all", label: "Allt", days: null },
  { key: "1y", label: "1 år", days: 365 },
  { key: "90d", label: "90 d", days: 90 },
  { key: "30d", label: "30 d", days: 30 },
  { key: "7d", label: "7 d", days: 7 },
];

/**
 * Analysis surfaces: long enough windows that a segment can still clear a
 * sample-size floor inside them.
 */
export const ANALYSIS_PERIODS: Period[] = [
  { key: "all", label: "Allt", days: null },
  { key: "12m", label: "12 mån", days: 365 },
  { key: "6m", label: "6 mån", days: 182 },
  { key: "3m", label: "3 mån", days: 91 },
];

export function periodByKey(periods: Period[], key: string): Period {
  return periods.find((p) => p.key === key) ?? periods[0];
}

function timeOf(b: BetLike): number {
  const raw = b.eventAt ?? b.placedAt ?? b.createdAt;
  if (!raw) return NaN;
  return raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
}

/**
 * Bets inside a trailing window. Undated rows are kept: dropping them would
 * silently shrink the sample for imports that never carried an event time.
 */
export function filterByPeriod<T extends BetLike>(bets: T[], days: number | null, now = Date.now()): T[] {
  if (!days) return bets;
  const cutoff = now - days * 864e5;
  return bets.filter((b) => {
    const t = timeOf(b);
    return Number.isNaN(t) || t >= cutoff;
  });
}

/**
 * Sample-size floor for a window: a segment needs fewer settled bets to be worth
 * showing over three months than over the whole history, or a short window would
 * always come up empty.
 */
export function minSettledFor(days: number | null): number {
  if (!days) return 40;
  if (days >= 365) return 40;
  if (days >= 182) return 25;
  return 15;
}
