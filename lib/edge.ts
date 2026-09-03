// Läckor & Edge: live-computed money leaks vs edges over the full history.
// Groups the settled history along four dimensions (market category, odds band,
// singles/accumulators, stake size) and surfaces the segments that have cost or
// made the most. Nothing is hardcoded — the panel always reflects current data.
//
// Pure & dependency-free (besides betting/discipline helpers) so it is
// trivially unit-testable.

import { breakdownBy, hasRealOdds, oddsBandKey, round2, type BetLike, type Breakdown } from "./betting";
import { betCategory, stakeBandKey } from "./disciplineRules";

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
