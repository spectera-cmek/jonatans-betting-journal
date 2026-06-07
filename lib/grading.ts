// Auto-grading: derive a bet Outcome from a final score.
// Supports the common structured markets (h2h, totals, spreads). Anything else
// returns null and is left for the user to settle manually.

import type { Outcome } from "./betting";

export type Market = "h2h" | "totals" | "spreads" | "other";
export type Side = "home" | "away" | "draw" | "over" | "under";

export interface ScoreInput {
  homeScore: number;
  awayScore: number;
}

export interface GradableBet {
  market: string;
  selectionSide?: string | null;
  line?: number | null;
}

/**
 * Returns the graded Outcome, or null if the market/selection cannot be graded
 * automatically (caller should fall back to manual settlement).
 */
export function gradeBet(bet: GradableBet, score: ScoreInput): Outcome | null {
  const { homeScore, awayScore } = score;
  if (
    homeScore == null ||
    awayScore == null ||
    Number.isNaN(homeScore) ||
    Number.isNaN(awayScore)
  ) {
    return null;
  }

  const side = (bet.selectionSide || "").toLowerCase() as Side;
  const market = (bet.market || "").toLowerCase() as Market;

  switch (market) {
    case "h2h":
      return gradeH2H(side, homeScore, awayScore);
    case "totals":
      return gradeTotals(side, bet.line, homeScore, awayScore);
    case "spreads":
      return gradeSpread(side, bet.line, homeScore, awayScore);
    default:
      return null; // "other" or unknown -> manual
  }
}

function gradeH2H(side: Side, home: number, away: number): Outcome | null {
  const homeWon = home > away;
  const awayWon = away > home;
  const draw = home === away;

  if (side === "home") return homeWon ? "win" : "loss";
  if (side === "away") return awayWon ? "win" : "loss";
  if (side === "draw") return draw ? "win" : "loss";
  return null;
}

function gradeTotals(
  side: Side,
  line: number | null | undefined,
  home: number,
  away: number
): Outcome | null {
  if (line == null) return null;
  const total = home + away;
  if (total === line) return "push"; // exact line -> stake returned
  const over = total > line;
  if (side === "over") return over ? "win" : "loss";
  if (side === "under") return over ? "loss" : "win";
  return null;
}

/**
 * Asian/point spread. `line` is applied to the side you backed.
 *  - home: home + line vs away
 *  - away: away + line vs home
 * Half lines (e.g. -0.5) can never push. Whole lines (e.g. -1) can push.
 * (Quarter/split lines like -0.25 are not handled here -> manual.)
 */
function gradeSpread(
  side: Side,
  line: number | null | undefined,
  home: number,
  away: number
): Outcome | null {
  if (line == null) return null;
  if (side !== "home" && side !== "away") return null;

  const margin =
    side === "home" ? home - away + line : away - home + line;

  if (margin > 0) return "win";
  if (margin < 0) return "loss";
  return "push"; // exactly on the line
}

/** Heuristic: infer a structured market + side from a free-text selection label.
 *  Used to help auto-grading when the user typed a selection but no explicit side.
 *  Returns partial info; never throws. */
export function inferSelection(
  selection: string,
  homeTeam?: string | null,
  awayTeam?: string | null
): { market?: Market; side?: Side; line?: number } {
  const s = (selection || "").trim().toLowerCase();
  if (!s) return {};

  // Totals
  const over = s.match(/^o(?:ver)?\s*([\d.]+)/);
  if (over) return { market: "totals", side: "over", line: parseFloat(over[1]) };
  const under = s.match(/^u(?:nder)?\s*([\d.]+)/);
  if (under) return { market: "totals", side: "under", line: parseFloat(under[1]) };

  // Draw
  if (s === "draw" || s === "x" || s === "tie") return { market: "h2h", side: "draw" };

  // Team match
  if (homeTeam && s === homeTeam.trim().toLowerCase())
    return { market: "h2h", side: "home" };
  if (awayTeam && s === awayTeam.trim().toLowerCase())
    return { market: "h2h", side: "away" };

  return {};
}
