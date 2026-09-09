// Läckor & Edge: live-computed money leaks vs edges over the full history.
// Groups the settled history along four dimensions (market category, odds band,
// singles/accumulators, stake size) and surfaces the segments that have cost or
// made the most. Nothing is hardcoded — the panel always reflects current data.
//
// Pure & dependency-free (besides betting/discipline helpers) so it is
// trivially unit-testable.

import { breakdownBy, hasRealOdds, round2, type BetLike, type Breakdown } from "./betting";
import { betCategory } from "./categorize";

export interface EdgeBetInput extends BetLike {
  selection?: string | null;
  market?: string | null;
  marketCategory?: string | null;
  betType?: string | null;
  sport?: string | null;
}

export interface EdgeSegment extends Breakdown {
  dim: "Marknad" | "Sport" | "Odds" | "Typ" | "Insats";
}

export interface EdgeSegments {
  leaks: EdgeSegment[]; // most negative first
  edges: EdgeSegment[]; // most positive first
  leakUnits: number; // sum of profitUnits across leaks (≤ 0)
  edgeUnits: number; // sum of profitUnits across edges (≥ 0)
  minSettled: number; // sample-size floor used for selection
}

// Segments need a real sample before they mean anything — below this they're variance.
const MIN_SETTLED = 40;

const ODDS_BANDS = [
  { label: "Odds 1.02–1.49", min: 1.01, max: 1.5 },
  { label: "Odds 1.50–1.99", min: 1.5, max: 2.0 },
  { label: "Odds 2.00–2.99", min: 2.0, max: 3.0 },
  { label: "Odds 3.00–4.99", min: 3.0, max: 5.0 },
  { label: "Odds 5.00+", min: 5.0, max: Infinity },
] as const;

function oddsBandKey(odds: number): string | null {
  const band = ODDS_BANDS.find((b) => odds >= b.min && odds < b.max);
  return band ? band.label : null;
}

function stakeBandKey(stake: number): string {
  if (stake <= 0.5) return "Insats ≤ 0,5 u";
  if (stake <= 1) return "Insats 0,51–1 u";
  if (stake <= 2) return "Insats 1,01–2 u";
  return "Insats > 2 u";
}

/**
 * The four axes the history is sliced along. Exported so anything that needs to
 * reason about the same segments — the discipline guard derives its rules from
 * them, and adds a per-segment z-score — groups bets exactly like this panel
 * does, instead of keeping a second, drifting copy of the bands.
 */
export interface EdgeDimension {
  dim: EdgeSegment["dim"];
  keyOf: (b: EdgeBetInput) => string | null;
  fallback: string;
  /** Bets this dimension is not defined for (placeholder odds, say). */
  include?: (b: EdgeBetInput) => boolean;
}

export const EDGE_DIMENSIONS: EdgeDimension[] = [
  {
    // `||`, not `??`: an unset category reaches this as "" from the add-bet form
    // and as null from the database, and both must fall through to the
    // selection text rather than becoming an empty key nothing can match.
    dim: "Marknad",
    keyOf: (b) => b.marketCategory || betCategory({ selection: b.selection, market: b.market }),
    fallback: "Övrigt",
  },
  { dim: "Sport", keyOf: (b) => b.sport ?? null, fallback: "Okänd sport" },
  {
    // Odds dimension only sees real prices — 1.01 placeholders are import artifacts.
    dim: "Odds",
    keyOf: (b) => oddsBandKey(b.odds),
    fallback: "Unknown",
    include: hasRealOdds,
  },
  {
    // keyOf always answers, so the fallback is unreachable — but it must not
    // collide with a real key, or the discipline guard's catch-all filter would
    // drop "Singel" along with the genuine "unclassified" buckets.
    dim: "Typ",
    keyOf: (b) => (b.betType === "accumulator" ? "Ackumulator" : "Singel"),
    fallback: "Okänd typ",
  },
  { dim: "Insats", keyOf: (b) => stakeBandKey(b.stakeUnits), fallback: "Unknown" },
];

/** Every segment that clears the sample-size floor, across all four dimensions. */
export function edgeSegmentCandidates(bets: EdgeBetInput[], minSettled = MIN_SETTLED): EdgeSegment[] {
  const out: EdgeSegment[] = [];
  for (const d of EDGE_DIMENSIONS) {
    const rows = breakdownBy(
      d.include ? bets.filter((b) => d.include!(b)) : bets,
      (b) => d.keyOf(b as EdgeBetInput),
      d.fallback
    );
    for (const r of rows) if (r.settled >= minSettled) out.push({ ...r, dim: d.dim });
  }
  return out;
}

export function computeEdgeSegments(bets: EdgeBetInput[], minSettled = MIN_SETTLED): EdgeSegments {
  const candidates = edgeSegmentCandidates(bets, minSettled);

  const leaks = candidates
    .filter((s) => s.profitUnits < 0)
    .sort((a, b) => a.profitUnits - b.profitUnits)
    .slice(0, 6);
  const edges = candidates
    .filter((s) => s.profitUnits > 0)
    .sort((a, b) => b.profitUnits - a.profitUnits)
    .slice(0, 6);

  return {
    leaks,
    edges,
    leakUnits: round2(leaks.reduce((acc, s) => acc + s.profitUnits, 0)),
    edgeUnits: round2(edges.reduce((acc, s) => acc + s.profitUnits, 0)),
    minSettled,
  };
}
