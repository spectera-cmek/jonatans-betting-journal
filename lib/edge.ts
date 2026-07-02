// Läckor & Edge: live-computed money leaks vs edges over the full history.
// Groups the settled history along four dimensions (market category, odds band,
// singles/accumulators, stake size) and surfaces the segments that have cost or
// made the most. Nothing is hardcoded — the panel always reflects current data.
//
// Pure & dependency-free (besides betting/discipline helpers) so it is
// trivially unit-testable.

import { breakdownBy, hasRealOdds, round2, type BetLike, type Breakdown } from "./betting";
import { betCategory } from "./discipline";

export interface EdgeBetInput extends BetLike {
  selection?: string | null;
  market?: string | null;
  marketCategory?: string | null;
  betType?: string | null;
}

export interface EdgeSegment extends Breakdown {
  dim: "Marknad" | "Odds" | "Typ" | "Insats";
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

export function computeEdgeSegments(bets: EdgeBetInput[], minSettled = MIN_SETTLED): EdgeSegments {
  const withDim = (rows: Breakdown[], dim: EdgeSegment["dim"]): EdgeSegment[] =>
    rows.map((r) => ({ ...r, dim }));

  const byMarket = withDim(
    breakdownBy(
      bets,
      (b) => {
        const e = b as EdgeBetInput;
        return e.marketCategory ?? betCategory({ selection: e.selection, market: e.market });
      },
      "Övrigt"
    ),
    "Marknad"
  );
  // Odds dimension only sees real prices — 1.01 placeholders are import artifacts.
  const byOdds = withDim(breakdownBy(bets.filter(hasRealOdds), (b) => oddsBandKey(b.odds)), "Odds");
  const byType = withDim(
    breakdownBy(bets, (b) => ((b as EdgeBetInput).betType === "accumulator" ? "Ackumulator" : "Singel")),
    "Typ"
  );
  const byStake = withDim(breakdownBy(bets, (b) => stakeBandKey(b.stakeUnits)), "Insats");

  const candidates = [...byMarket, ...byOdds, ...byType, ...byStake].filter(
    (s) => s.settled >= minSettled
  );

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
