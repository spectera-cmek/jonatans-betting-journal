// Auto-grading: derive a bet Outcome from a final score.
//
// `Bet.market` is a four-value enum (h2h/totals/spreads/other) that says how to
// compute a result; `Bet.marketCategory` says what was actually bet on. Neither
// alone is enough to grade: a corners over/under is stored as market "totals"
// with category "Hörnor", and grading it against the goal total would be
// confidently wrong. resolveGradingMarket combines the two.
//
// Anything that cannot be computed from the numbers supplied returns null and
// is left for the user. A missing statistic must never become a guess.

import type { Outcome } from "./betting";

export type Market = "h2h" | "totals" | "spreads" | "other";
export type Side = "home" | "away" | "draw" | "over" | "under";

/** What grading actually computes, once the semantic category is folded in. */
export type ResolvedMarket =
  | "h2h"
  | "totals"
  | "spreads"
  | "btts"
  | "double_chance"
  | "dnb"
  | "corners"
  | "cards"
  | "first_half_h2h"
  | "first_half_totals";

export interface ScoreInput {
  homeScore: number;
  awayScore: number;
  /** Corner counts — needed for "Hörnor" markets, absent otherwise. */
  homeCorners?: number | null;
  awayCorners?: number | null;
  /** Card counts for "Kort & fouls". */
  homeCards?: number | null;
  awayCards?: number | null;
  /** Half-time score for "Halvlek" markets. */
  homeHalfScore?: number | null;
  awayHalfScore?: number | null;
}

export interface GradableBet {
  market: string;
  selectionSide?: string | null;
  line?: number | null;
  /** Semantic market ("Hörnor", "BTTS", "Dubbelchans" …). */
  marketCategory?: string | null;
  /** Free-text label — the only place a double chance or BTTS side is written. */
  selection?: string | null;
}

const norm = (s: string | null | undefined) => (s || "").toLowerCase().trim();

/**
 * Which computation this bet needs.
 *
 * The category wins over the grading enum whenever it names a different
 * quantity: "Hörnor" with market "totals" is a corner line, not a goal line.
 */
export function resolveGradingMarket(bet: GradableBet): ResolvedMarket | null {
  const market = norm(bet.market) as Market;
  const cat = norm(bet.marketCategory);
  const sel = norm(bet.selection);

  if (cat.includes("hörn") || cat.includes("corner")) return "corners";
  if (cat.includes("kort") || cat.includes("foul") || cat.includes("card")) return "cards";
  if (cat.includes("btts") || /både|båda lagen|both teams/.test(cat)) return "btts";
  if (cat.includes("dubbelchans") || cat.includes("double chance")) return "double_chance";
  if (/draw no bet|dnb|oavgjort insats åter/.test(cat) || /draw no bet|\bdnb\b/.test(sel)) {
    return "dnb";
  }
  if (cat.includes("halvlek") || cat.includes("first half") || cat.includes("halftime")) {
    // A half-time bet is still either a winner or a line.
    return market === "totals" ? "first_half_totals" : "first_half_h2h";
  }

  // No category, or one that agrees with the enum — fall back to the enum.
  if (market === "h2h" || market === "totals" || market === "spreads") {
    // BTTS and double chance are often logged with no category at all; the
    // selection text is then the only signal there is.
    if (/båda lagen|btts|\bgg\b|both teams/.test(sel)) return "btts";
    if (doubleChancePick(sel)) return "double_chance";
    return market;
  }

  // market "other": the category above was the only chance.
  if (/båda lagen|btts|\bgg\b|both teams/.test(sel)) return "btts";
  if (doubleChancePick(sel)) return "double_chance";
  return null;
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

  const side = norm(bet.selectionSide) as Side;
  const resolved = resolveGradingMarket(bet);

  switch (resolved) {
    case "h2h":
      return gradeH2H(side, homeScore, awayScore);
    case "totals":
      return gradeTotals(side, bet.line, homeScore, awayScore);
    case "spreads":
      return gradeSpread(side, bet.line, homeScore, awayScore);
    case "btts":
      return gradeBtts(bet, homeScore, awayScore);
    case "double_chance":
      return gradeDoubleChance(bet, homeScore, awayScore);
    case "dnb":
      return gradeDnb(bet, homeScore, awayScore);
    case "corners":
      return gradePairTotal(bet, side, score.homeCorners, score.awayCorners);
    case "cards":
      return gradePairTotal(bet, side, score.homeCards, score.awayCards);
    case "first_half_h2h":
      return pairPresent(score.homeHalfScore, score.awayHalfScore)
        ? gradeH2H(side, score.homeHalfScore!, score.awayHalfScore!)
        : null;
    case "first_half_totals":
      return pairPresent(score.homeHalfScore, score.awayHalfScore)
        ? gradeTotals(side, bet.line, score.homeHalfScore!, score.awayHalfScore!)
        : null;
    default:
      return null;
  }
}

function pairPresent(a: number | null | undefined, b: number | null | undefined): boolean {
  return (
    typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)
  );
}

/**
 * Over/under against a statistic other than goals (corners, cards).
 *
 * Identical arithmetic to gradeTotals, but the numbers come from match stats
 * that are frequently absent — and when they are, the answer is null, not a
 * total of zero.
 */
function gradePairTotal(
  bet: GradableBet,
  side: Side,
  home: number | null | undefined,
  away: number | null | undefined
): Outcome | null {
  if (!pairPresent(home, away)) return null;
  return gradeTotals(side, bet.line, home!, away!);
}

/** Both teams to score. "Yes" is stored as side "over" or written in the label. */
function gradeBtts(bet: GradableBet, home: number, away: number): Outcome | null {
  const side = norm(bet.selectionSide);
  const sel = norm(bet.selection);
  const both = home > 0 && away > 0;

  const yes = side === "over" || /\bja\b|\byes\b|\bgg\b/.test(sel);
  const no = side === "under" || /\bnej\b|\bno\b|\bng\b/.test(sel);
  if (yes === no) return null; // neither or both matched — do not guess

  return yes ? (both ? "win" : "loss") : both ? "loss" : "win";
}

export type DoubleChancePick = "1X" | "12" | "X2";

/**
 * Read a double chance off the label.
 *
 * There is nowhere else to read it from: `selectionSide` is a single side and
 * cannot express "home or draw". Deliberately strict — an unrecognised label
 * returns null and the bet stays manual.
 */
export function doubleChancePick(selection: string | null | undefined): DoubleChancePick | null {
  const s = norm(selection).replace(/\s+/g, " ");
  if (!s) return null;

  if (/\b1x\b|\bx1\b/.test(s)) return "1X";
  if (/\bx2\b|\b2x\b/.test(s)) return "X2";
  if (/\b12\b/.test(s)) return "12";

  const home = /hemma|home/.test(s);
  const away = /borta|away/.test(s);
  const draw = /oavgjort|draw/.test(s);
  const or = /\beller\b|\bor\b|\/|\+/.test(s);
  if (!or) return null;
  if (home && draw) return "1X";
  if (away && draw) return "X2";
  if (home && away) return "12";
  return null;
}

function gradeDoubleChance(bet: GradableBet, home: number, away: number): Outcome | null {
  const pick = doubleChancePick(bet.selection);
  if (!pick) return null;
  const homeWon = home > away;
  const awayWon = away > home;
  const draw = home === away;

  if (pick === "1X") return homeWon || draw ? "win" : "loss";
  if (pick === "X2") return awayWon || draw ? "win" : "loss";
  return homeWon || awayWon ? "win" : "loss";
}

/** Draw no bet: a draw returns the stake. */
function gradeDnb(bet: GradableBet, home: number, away: number): Outcome | null {
  const side = norm(bet.selectionSide);
  if (home === away) return "void";
  if (side === "home") return home > away ? "win" : "loss";
  if (side === "away") return away > home ? "win" : "loss";
  return null;
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
