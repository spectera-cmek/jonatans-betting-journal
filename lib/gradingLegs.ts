// Grading accumulators leg by leg.
//
// A combination is only as settled as its weakest leg, so this module is built
// to refuse rather than approximate: if any leg cannot be resolved, the whole
// slip stays pending with a reason naming that leg. Settling a coupon on a
// guess is worse than not settling it at all — it writes a wrong P/L into the
// bankroll curve and nothing later notices.
//
// Legs are stored as free text ({selection, event, market, odds, outcome}, see
// lib/bet365.ts), so there are two very different cases:
//
//   - Imported slips already carry a per-leg outcome from the statement PDF
//     ("Vunnet"/"Förlorat"/"Annullerat"). Those are authoritative: the book has
//     already graded them.
//   - Hand-logged coupons carry nothing but a label, and each leg has to be
//     structured and graded like a single bet before the slip can be combined.

import { accaOdds, profitUnits, type Outcome } from "./betting";
import { gradeBet, inferSelection, type ScoreInput } from "./grading";
import { parseHomeAway } from "./eventLink";

/** A leg as it is stored in `Bet.legs`. */
export interface RawLeg {
  selection?: string;
  event?: string;
  market?: string | null;
  odds?: number | null;
  outcome?: string;
}

/** What one leg resolved to. */
export type LegOutcome = "win" | "loss" | "void";

export interface LegResult {
  index: number;
  label: string;
  odds: number | null;
  outcome: LegOutcome | null;
  /** Why the leg could not be resolved, when outcome is null. */
  reason?: string;
}

export interface AccaGrade {
  outcome: Outcome | null;
  /** Combined odds of the legs that still stand (void legs removed). */
  effectiveOdds: number | null;
  /** Profit in units, already accounting for void legs shortening the coupon. */
  profitUnits: number | null;
  legs: LegResult[];
  /** Set when the slip cannot be settled; names the leg that blocked it. */
  blockedReason?: string;
}

/** Parse the JSON blob on a bet, tolerating anything that is not a leg array. */
export function parseLegs(legs: string | null | undefined): RawLeg[] {
  if (!legs) return [];
  try {
    const arr = JSON.parse(legs);
    return Array.isArray(arr) ? (arr as RawLeg[]) : [];
  } catch {
    return [];
  }
}

/**
 * Read a bookmaker's own per-leg verdict.
 *
 * Swedish statement wording from bet365; English kept for other importers.
 * Anything unrecognised returns null so the leg falls through to real grading
 * rather than being silently treated as a loss.
 */
export function legOutcomeFromLabel(label: string | null | undefined): LegOutcome | null {
  const s = (label || "").toLowerCase().trim();
  if (!s) return null;
  if (/pågående|ej avgjort|open|pending/.test(s)) return null;
  // Checked BEFORE win/loss: "Halv vinst" contains "vinst", and a half-won leg
  // has no clean combination rule — a quarter line inside an acca changes the
  // payout, not just the outcome. Reading it as a full win overpays the coupon.
  if (/halv|half/.test(s)) return null;
  if (/annullerat|återbetald|makulerad|void|cancell|refund|push/.test(s)) return "void";
  if (/vunnet|vann|vinst\b|won|win/.test(s)) return "win";
  if (/förlorat|förlust|lost|lose|loss/.test(s)) return "loss";
  return null;
}

/** A finished match, keyed so a leg can find the one it refers to. */
export interface LegFixture {
  homeTeam: string;
  awayTeam: string;
  score: ScoreInput;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9åäöéü ]/gi, " ").replace(/\s+/g, " ").trim();

/** Does this fixture describe the match named on the leg? */
export function fixtureMatchesLeg(leg: RawLeg, fixture: LegFixture): boolean {
  const parsed = parseHomeAway(leg.event || "");
  const home = parsed?.home ?? "";
  const away = parsed?.away ?? "";
  if (!home || !away) return false;
  const fh = norm(fixture.homeTeam);
  const fa = norm(fixture.awayTeam);
  const lh = norm(home);
  const la = norm(away);
  const hit = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));
  return (hit(lh, fh) && hit(la, fa)) || (hit(lh, fa) && hit(la, fh));
}

/**
 * Resolve one leg: the book's verdict if it has one, otherwise grade it from
 * the fixture the leg names.
 */
export function gradeLeg(
  leg: RawLeg,
  index: number,
  fixtures: LegFixture[]
): LegResult {
  const label = `${leg.selection ?? ""}${leg.event ? ` (${leg.event})` : ""}`.trim() || `ben ${index + 1}`;
  const base = { index, label, odds: leg.odds ?? null };

  const fromBook = legOutcomeFromLabel(leg.outcome);
  if (fromBook) return { ...base, outcome: fromBook };
  if (leg.outcome && /pågående|open|pending/i.test(leg.outcome)) {
    return { ...base, outcome: null, reason: "benet är inte avgjort ännu" };
  }

  const fixture = fixtures.find((f) => fixtureMatchesLeg(leg, f));
  if (!fixture) {
    return { ...base, outcome: null, reason: `hittade ingen match för "${leg.event ?? "?"}"` };
  }

  // Structure the free-text selection the same way a single bet is structured.
  const inferred = inferSelection(leg.selection ?? "", fixture.homeTeam, fixture.awayTeam);
  const graded = gradeBet(
    {
      market: inferred.market ?? leg.market ?? "other",
      marketCategory: leg.market ?? null,
      selection: leg.selection ?? null,
      selectionSide: inferred.side ?? null,
      line: inferred.line ?? null,
    },
    fixture.score
  );

  if (graded === "win") return { ...base, outcome: "win" };
  if (graded === "loss") return { ...base, outcome: "loss" };
  if (graded === "push" || graded === "void") return { ...base, outcome: "void" };
  // half_win/half_loss inside a coupon changes the payout rather than the
  // outcome, and no bookmaker rule here is safe to assume.
  if (graded) {
    return { ...base, outcome: null, reason: `${graded} på ett ben kräver manuell rättning` };
  }
  return { ...base, outcome: null, reason: `kunde inte tolka "${leg.selection ?? ""}"` };
}

/**
 * Grade a whole coupon.
 *
 * Combination rules, in the order they apply:
 *   - Any leg lost  → the coupon lost, whatever the other legs did. This is
 *     decided FIRST, so an unresolvable leg alongside a lost one does not block
 *     a settlement that is already certain.
 *   - Any leg unresolved → blocked, with that leg named.
 *   - Void legs drop out and the remaining legs' odds are multiplied again.
 *     All legs void → the stake comes back.
 */
export function gradeAccumulator(
  legs: RawLeg[],
  stakeUnits: number,
  fixtures: LegFixture[] = []
): AccaGrade {
  if (legs.length === 0) {
    return {
      outcome: null,
      effectiveOdds: null,
      profitUnits: null,
      legs: [],
      blockedReason: "Kupongen saknar sparade ben.",
    };
  }

  const results = legs.map((leg, i) => gradeLeg(leg, i, fixtures));

  // A single lost leg settles the coupon regardless of the rest.
  if (results.some((r) => r.outcome === "loss")) {
    return {
      outcome: "loss",
      effectiveOdds: null,
      profitUnits: -stakeUnits,
      legs: results,
    };
  }

  const unresolved = results.find((r) => r.outcome === null);
  if (unresolved) {
    return {
      outcome: null,
      effectiveOdds: null,
      profitUnits: null,
      legs: results,
      blockedReason: `Ben ${unresolved.index + 1} (${unresolved.label}): ${unresolved.reason ?? "kunde inte rättas"}.`,
    };
  }

  const standing = results.filter((r) => r.outcome === "win");
  if (standing.length === 0) {
    // Everything was voided — the stake is returned.
    return { outcome: "void", effectiveOdds: null, profitUnits: 0, legs: results };
  }

  // A void leg is removed from the coupon, not counted as odds 1.00 — which is
  // the same arithmetic, but only because the remaining legs are re-multiplied.
  const oddsList = standing.map((r) => r.odds);
  if (oddsList.some((o) => o == null || !(o > 1))) {
    return {
      outcome: null,
      effectiveOdds: null,
      profitUnits: null,
      legs: results,
      blockedReason: "Ett vinnande ben saknar odds — kan inte räkna om kupongen.",
    };
  }

  const effective = accaOdds(oddsList as number[]);
  return {
    outcome: "win",
    effectiveOdds: Number(effective.toFixed(4)),
    profitUnits: Number(profitUnits("win", effective, stakeUnits).toFixed(4)),
    legs: results,
  };
}
