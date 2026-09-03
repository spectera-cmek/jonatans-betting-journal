// Leak/edge rules derived from the journal itself, replacing a set of constants
// frozen at a one-off 2026-06-11 analysis.
//
// Those constants had drifted badly. Against the same journal a year later, six
// of thirteen were wrong or reversed: the code warned that "Kort & fouls" ran at
// −17 % ROI when it was running at +4,8 %, and that odds ≥ 3 had leaked money
// when the 3–5 band was the second most profitable one. Advice frozen in source
// gets worse every month it isn't rewritten, and nobody rewrites it.
//
// So the rules are recomputed from settled history over a rolling window, using
// the same segmentation the leak/edge panel already uses. A segment becomes a
// rule only when it clears both a sample-size floor and an ROI threshold —
// otherwise it is variance wearing a number.
//
// Pure & dependency-free (besides the market normalizer) so it stays trivially
// unit-testable.

import {
  breakdownBy,
  hasRealOdds,
  isSettled,
  oddsBandKey,
  round2,
  type BetLike,
  type Outcome,
} from "./betting";
import { normalizeMarket } from "./categorize";

export interface DisciplineInput {
  sport?: string | null; // display name, e.g. "Basketball"
  selection?: string | null; // free text, e.g. "Bridges över 13.5 skott"
  market?: string | null; // raw code (h2h/totals/spreads/other) or category
  marketCategory?: string | null; // semantic category when already resolved
  odds?: number | null;
  stakeUnits?: number | null;
  betType?: string | null; // single | accumulator
}

/** The dimensions a rule can be about. */
export type RuleDim = "Marknad" | "Odds" | "Typ" | "Insats" | "Sport";

export interface DisciplineRule {
  dim: RuleDim;
  key: string; // "Kort & fouls" | "5.00+" | "Ackumulator" | "Insats > 2 u" | "Tennis"
  tone: "pos" | "neg";
  settled: number;
  profitUnits: number;
  roiPct: number;
}

export interface DisciplineRuleSet {
  rules: DisciplineRule[];
  /** Start of the window the rules were derived from, ISO date. Null = all history. */
  windowFrom: string | null;
  minSettled: number;
  minRoiPct: number;
  /** Settled bets inside the window — the base the rules rest on. */
  settledInWindow: number;
}

export interface DeriveOptions {
  /** How far back to look. Default 18 months; 0 or null = all history. */
  windowMonths?: number | null;
  /** Sample-size floor per segment. */
  minSettled?: number;
  /** A segment must beat this ROI (either direction) to become a rule. */
  minRoiPct?: number;
  now?: Date | number;
}

const DEFAULT_WINDOW_MONTHS = 18;
// Below this, a segment's ROI is noise. Higher than the leak panel's floor
// because these rules are shown as advice while a bet is being typed.
const DEFAULT_MIN_SETTLED = 60;
// A segment inside ±4 % is not worth steering behaviour on.
const DEFAULT_MIN_ROI_PCT = 4;
// A segment covering more of the window than this restates the portfolio rather
// than isolating a behaviour. "Singel: +6,7 %" over 87 % of all bets is just the
// overall ROI wearing a rule's clothes; "Football: +7,7 %" over 48 % made every
// football bet read as an edge and drowned out the warnings that mattered.
const MAX_SEGMENT_SHARE = 0.35;
// normalizeMarket's fallback bucket. A rule keyed on "unclassifiable" cannot
// guide a decision, however good its ROI looks.
const CATCH_ALL_CATEGORY = "Övrigt";

/** An empty rule set — what `evaluateBet` falls back to when it is given none. */
export const EMPTY_RULE_SET: DisciplineRuleSet = {
  rules: [],
  windowFrom: null,
  minSettled: DEFAULT_MIN_SETTLED,
  minRoiPct: DEFAULT_MIN_ROI_PCT,
  settledInWindow: 0,
};

export interface RuleBetInput extends BetLike {
  sport?: string | null;
  selection?: string | null;
  market?: string | null;
  marketCategory?: string | null;
  betType?: string | null;
}

/**
 * Category for a bet: the free-text selection usually carries the market
 * keywords ("skott", "hörnor", "kort"…), with the market field as fallback.
 * Returns "Övrigt" when nothing matches.
 */
export function betCategory(input: DisciplineInput): string {
  const fromSelection = normalizeMarket(input.selection);
  if (fromSelection !== "Övrigt") return fromSelection;
  return normalizeMarket(input.market);
}

/** Stake bands, shared by the rule engine and the leak/edge panel. */
export function stakeBandKey(stake: number): string {
  if (stake <= 0.5) return "Insats ≤ 0,5 u";
  if (stake <= 1) return "Insats 0,51–1 u";
  if (stake <= 2) return "Insats 1,01–2 u";
  return "Insats > 2 u";
}

export function betTypeKey(betType?: string | null): string {
  return betType && betType !== "single" ? "Ackumulator" : "Singel";
}

function categoryOf(b: RuleBetInput): string {
  return b.marketCategory ?? betCategory({ selection: b.selection, market: b.market });
}

/** Derive the rule set from settled history. */
export function deriveDisciplineRules(
  bets: RuleBetInput[],
  opts: DeriveOptions = {}
): DisciplineRuleSet {
  const minSettled = opts.minSettled ?? DEFAULT_MIN_SETTLED;
  const minRoiPct = opts.minRoiPct ?? DEFAULT_MIN_ROI_PCT;
  const windowMonths = opts.windowMonths === undefined ? DEFAULT_WINDOW_MONTHS : opts.windowMonths;

  let windowFrom: string | null = null;
  let inWindow = bets;
  if (windowMonths) {
    const from = new Date(opts.now ?? Date.now());
    from.setMonth(from.getMonth() - windowMonths);
    windowFrom = from.toISOString().slice(0, 10);
    const fromMs = from.getTime();
    inWindow = bets.filter((b) => {
      const t = new Date(b.eventAt ?? b.placedAt ?? b.createdAt ?? 0).getTime();
      return Number.isFinite(t) && t >= fromMs;
    });
  }

  // Rules describe realised performance, so only settled bets count.
  const settled = inWindow.filter((b) => isSettled(b.outcome as Outcome));

  const dims: [RuleDim, (b: RuleBetInput) => string | null, RuleBetInput[]][] = [
    ["Marknad", categoryOf, settled],
    // The odds dimension only sees real prices — 1.01 is an import placeholder.
    ["Odds", (b) => oddsBandKey(b.odds), settled.filter(hasRealOdds)],
    ["Typ", (b) => betTypeKey(b.betType), settled],
    ["Insats", (b) => stakeBandKey(b.stakeUnits), settled],
    ["Sport", (b) => b.sport ?? null, settled],
  ];

  const rules: DisciplineRule[] = [];
  for (const [dim, keyFn, rows] of dims) {
    for (const seg of breakdownBy(rows, (b) => keyFn(b as RuleBetInput))) {
      if (seg.settled < minSettled) continue;
      if (seg.roiPct == null || Math.abs(seg.roiPct) < minRoiPct) continue;
      if (dim === "Marknad" && seg.key === CATCH_ALL_CATEGORY) continue;
      if (settled.length > 0 && seg.settled / settled.length > MAX_SEGMENT_SHARE) continue;
      rules.push({
        dim,
        key: seg.key,
        tone: seg.roiPct >= 0 ? "pos" : "neg",
        settled: seg.settled,
        profitUnits: round2(seg.profitUnits),
        roiPct: round2(seg.roiPct),
      });
    }
  }

  // Strongest signal first, so a bet that trips several rules leads with the
  // one that matters most.
  rules.sort((a, b) => Math.abs(b.roiPct) - Math.abs(a.roiPct));

  return { rules, windowFrom, minSettled, minRoiPct, settledInWindow: settled.length };
}

/** The keys a bet falls under, per dimension. */
export function ruleKeysFor(input: DisciplineInput): Partial<Record<RuleDim, string | null>> {
  const odds = input.odds ?? null;
  const stake = input.stakeUnits ?? null;
  return {
    Marknad: input.marketCategory ?? betCategory(input),
    Odds: odds != null && odds > 1.01 ? oddsBandKey(odds) : null,
    Typ: input.betType ? betTypeKey(input.betType) : null,
    Insats: stake != null && stake > 0 ? stakeBandKey(stake) : null,
    Sport: input.sport ?? null,
  };
}

/** Rules that apply to a bet, strongest first. */
export function matchRules(input: DisciplineInput, ruleSet: DisciplineRuleSet): DisciplineRule[] {
  const keys = ruleKeysFor(input);
  return ruleSet.rules.filter((r) => {
    const k = keys[r.dim];
    return k != null && k.toLowerCase() === r.key.toLowerCase();
  });
}

/** Swedish one-liner for a rule: the numbers, not a lecture. */
export function ruleNote(rule: DisciplineRule): string {
  const sv = (n: number, digits: number) =>
    `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(digits).replace(".", ",")}`;
  return `${rule.key}: ${sv(rule.roiPct, 1)} % ROI över ${rule.settled.toLocaleString("sv-SE")} spel (${sv(rule.profitUnits, 1)}u)`;
}
