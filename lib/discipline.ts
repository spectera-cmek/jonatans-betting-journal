// Disciplinvakten — the verdict shown while a bet is being typed.
//
// Every number here comes from the bet's own journal (see lib/disciplineRules,
// derived over a trailing window). It used to be a hardcoded table copied out of
// one analysis; a season later several of those verdicts had flipped sign and
// the guard was confidently warning about the wrong markets. Nothing is
// hardcoded now — if the data stops supporting a rule, the rule disappears.
//
// Pure & dependency-free (besides the market normalizer and formatting) so it is
// trivially unit-testable and reusable from both the add-bet modal and scripts.

import { isMultiBet } from "./betting";
import { betCategory } from "./categorize";
import { pctFmt, uFmt } from "./format";
import { countOnEvent, type DisciplineRule, type DisciplineRuleSet, type OpenEventCount } from "./disciplineRules";
import { EDGE_DIMENSIONS, type EdgeBetInput } from "./edge";

// Re-exported so the pages and tests that have always imported it from here
// keep working; the implementation now sits beside the market normalizer.
export { betCategory };

export interface DisciplineInput {
  sport?: string | null; // display name, e.g. "Basketball"
  selection?: string | null; // free text, e.g. "Bridges över 13.5 skott"
  market?: string | null; // raw code (h2h/totals/spreads/other) or category
  marketCategory?: string | null; // semantic market when the form already knows it
  odds?: number | null;
  stakeUnits?: number | null;
  betType?: string | null; // single | accumulator
  event?: string | null; // "Team A vs Team B" — for the same-match check
}

export interface DisciplineNote {
  tone: "pos" | "neg" | "info";
  text: string;
}

export interface DisciplineVerdict {
  level: "edge" | "warn" | "mixed" | "none";
  notes: DisciplineNote[];
}

/** The typed form as something the edge dimensions can key on. */
function asBet(input: DisciplineInput): EdgeBetInput {
  return {
    odds: input.odds ?? 0,
    stakeUnits: input.stakeUnits ?? 0,
    outcome: "pending",
    selection: input.selection,
    market: input.market,
    marketCategory: input.marketCategory ?? null,
    betType: isMultiBet(input.betType) ? "accumulator" : "single",
    sport: input.sport ?? null,
  };
}

function ruleText(rule: DisciplineRule, windowLabel: string): string {
  return `${rule.key}: ${pctFmt(rule.roiPct, true)} ROI och ${uFmt(rule.profitUnits, true)} över ${rule.settled.toLocaleString("sv-SE")} avgjorda (${windowLabel})`;
}

/**
 * Evaluate a bet mid-entry against the journal's own rules.
 *
 * Only dimensions the form has actually filled in are matched: odds and stake
 * bands are skipped while those fields are empty, so an untouched form does not
 * claim the 0-unit stake band is a leak.
 */
export function evaluateBet(
  input: DisciplineInput,
  ruleSet?: DisciplineRuleSet | null,
  openEvents?: OpenEventCount[]
): DisciplineVerdict {
  const notes: DisciplineNote[] = [];
  const bet = asBet(input);
  const hasOdds = input.odds != null && input.odds > 1;
  const hasStake = input.stakeUnits != null && input.stakeUnits > 0;

  for (const d of EDGE_DIMENSIONS) {
    if (d.dim === "Odds" && !hasOdds) continue;
    if (d.dim === "Insats" && !hasStake) continue;
    if (d.include && !d.include(bet)) continue;
    const key = d.keyOf(bet) ?? d.fallback;
    const rule = ruleSet?.rules.find((r) => r.dim === d.dim && r.key === key);
    if (rule) notes.push({ tone: rule.tone, text: ruleText(rule, ruleSet!.windowLabel) });
  }

  // Concentration on one match: not a segment in the history, but the pile-up
  // itself is the pattern worth flagging while the bet is still editable.
  const onEvent = openEvents?.length ? countOnEvent(input.event, openEvents) : null;
  if (onEvent && onEvent.bets >= 3) {
    notes.push({
      tone: "neg",
      text: `Du har redan ${onEvent.bets} öppna spel på den här matchen (${uFmt(onEvent.stakeUnits)}) — det här blir det ${onEvent.bets + 1}:e.`,
    });
  } else if (onEvent && onEvent.bets === 2) {
    notes.push({ tone: "info", text: "Du har redan 2 öppna spel på den här matchen." });
  }

  const hasWarn = notes.some((n) => n.tone === "neg");
  const hasEdge = notes.some((n) => n.tone === "pos");
  const level = hasWarn && hasEdge ? "mixed" : hasWarn ? "warn" : hasEdge ? "edge" : "none";
  return { level, notes };
}
