// Leak/edge verdict for a single bet, evaluated against a rule set derived from
// the journal itself (see ./disciplineRules).
//
// This module used to carry the rules as hardcoded constants from a one-off
// 2026-06-11 analysis — literal kr and ROI figures baked into source. A year on,
// six of thirteen were wrong or reversed, so the modal was warning against
// markets that had become profitable. Nothing is hardcoded here any more; with
// no rule set the verdict is simply empty, because advice with no data behind it
// is what caused the problem.
//
// Pure & dependency-free so it is trivially unit-testable and reusable from both
// the add-bet modal and scripts.

import {
  EMPTY_RULE_SET,
  matchRules,
  ruleNote,
  type DisciplineInput,
  type DisciplineRuleSet,
} from "./disciplineRules";

// Re-exported so existing importers (lib/edge, the insights page) keep working.
export { betCategory } from "./disciplineRules";
export type { DisciplineInput, DisciplineRule, DisciplineRuleSet } from "./disciplineRules";

export interface DisciplineNote {
  tone: "pos" | "neg";
  text: string;
}

export interface DisciplineVerdict {
  level: "edge" | "warn" | "mixed" | "none";
  notes: DisciplineNote[];
}

/** How many notes to surface. More than this and it stops being readable. */
const MAX_NOTES = 4;

/**
 * Evaluate a bet (typically mid-entry) against the derived leak/edge rules.
 * Without a rule set the verdict is "none" — there is nothing to say yet.
 */
export function evaluateBet(
  input: DisciplineInput,
  ruleSet: DisciplineRuleSet = EMPTY_RULE_SET
): DisciplineVerdict {
  const matched = matchRules(input, ruleSet).slice(0, MAX_NOTES);
  const notes: DisciplineNote[] = matched.map((r) => ({ tone: r.tone, text: ruleNote(r) }));

  const hasWarn = notes.some((n) => n.tone === "neg");
  const hasEdge = notes.some((n) => n.tone === "pos");
  const level = hasWarn && hasEdge ? "mixed" : hasWarn ? "warn" : hasEdge ? "edge" : "none";
  return { level, notes };
}
