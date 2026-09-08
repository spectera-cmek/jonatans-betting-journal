// Datakvalitet — what in the journal can't be trusted, counted.
//
// Years of imports leave sediment: losing coupons stored at the 1.01 placeholder
// price because the statement never carried the real odds, rows that never got a
// league or a market category, bets left pending long after the match finished,
// and near-identical rows from re-importing the same PDF. Each of these quietly
// skews an analysis somewhere, and until now none of them were visible anywhere
// in the UI.
//
// Pure & dependency-free so both /api/metrics and the bets list can share one
// definition of every flag.

import { hasRealOdds, isSettled, type Outcome } from "./betting";
import { eventKey } from "./disciplineRules";

export type QualityFlag = "placeholder" | "no-league" | "no-category" | "dupe" | "stale-pending";

/**
 * Marker left in `notes` on bets that were fabricated for a demo and never
 * cleaned out. They are real rows in the table and they move the totals, so the
 * count is surfaced rather than silently filtered.
 */
export const FABRICATED_TAG = "FIKTIV";

export const QUALITY_FLAG_LABELS: Record<QualityFlag, string> = {
  placeholder: "Platshållarodds (1,01)",
  "no-league": "Saknar liga",
  "no-category": "Saknar marknadskategori",
  dupe: "Misstänkt dubblett",
  "stale-pending": "Orättade spelade matcher",
};

export const QUALITY_FLAG_HINTS: Record<QualityFlag, string> = {
  placeholder:
    "Importerade förluster där kontoutdraget saknade odds. Räknas bort ur snittodds och oddsspann, men syns i P/L.",
  "no-league": "Utan liga går spelet varken att auto-rätta mot ESPN eller följa upp per liga.",
  "no-category": "Utan marknadskategori hamnar spelet i “Övrigt” i alla marknadsanalyser.",
  dupe: "Samma match, spel, insats och odds inom ett dygn — ofta en ominläst PDF.",
  "stale-pending": "Matchen spelades för mer än två dygn sedan men spelet är fortfarande öppet.",
};

export interface QualityBet {
  id: string;
  event: string;
  selection: string;
  league?: string | null;
  marketCategory?: string | null;
  odds: number;
  stakeUnits: number;
  outcome: string;
  closingOdds?: number | null;
  boosted?: boolean | null;
  betType?: string | null;
  eventAt?: Date | string | null;
  placedAt?: Date | string | null;
}

const DUPE_WINDOW_MS = 864e5; // one day
const STALE_PENDING_MS = 2 * 864e5;

function timeOf(b: QualityBet): number {
  const raw = b.eventAt ?? b.placedAt;
  if (!raw) return NaN;
  return raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
}

/**
 * Ids of bets that look like re-imports of each other: identical match,
 * selection, stake and price, placed within a day. Every member of such a
 * cluster is returned — which of them is the original is the reader's call.
 */
export function findSuspectedDuplicates(bets: QualityBet[]): Set<string> {
  const groups = new Map<string, { id: string; t: number }[]>();
  for (const b of bets) {
    const key = `${eventKey(b.event)}|${(b.selection ?? "").toLowerCase().trim()}|${b.stakeUnits}|${b.odds}`;
    const t = timeOf(b);
    if (Number.isNaN(t)) continue;
    const arr = groups.get(key);
    if (arr) arr.push({ id: b.id, t });
    else groups.set(key, [{ id: b.id, t }]);
  }

  const dupes = new Set<string>();
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.t - b.t);
    let cluster = [rows[0]];
    const flush = () => {
      if (cluster.length >= 2) for (const r of cluster) dupes.add(r.id);
    };
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].t - cluster[cluster.length - 1].t <= DUPE_WINDOW_MS) cluster.push(rows[i]);
      else {
        flush();
        cluster = [rows[i]];
      }
    }
    flush();
  }
  return dupes;
}

/** Every flag that applies to one bet. `dupes` comes from findSuspectedDuplicates. */
export function flagsFor(bet: QualityBet, dupes: Set<string>, now = Date.now()): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (!hasRealOdds(bet)) flags.push("placeholder");
  if (!bet.league) flags.push("no-league");
  if (!bet.marketCategory) flags.push("no-category");
  if (dupes.has(bet.id)) flags.push("dupe");
  const t = timeOf(bet);
  if (!isSettled(bet.outcome as Outcome) && !Number.isNaN(t) && now - t > STALE_PENDING_MS) {
    flags.push("stale-pending");
  }
  return flags;
}

export interface DataQualitySummary extends Record<QualityFlag, number> {
  total: number;
  /** Bets carrying at least one flag. */
  flagged: number;
}

export function dataQualitySummary(bets: QualityBet[], now = Date.now()): DataQualitySummary {
  const dupes = findSuspectedDuplicates(bets);
  const out: DataQualitySummary = {
    placeholder: 0,
    "no-league": 0,
    "no-category": 0,
    dupe: 0,
    "stale-pending": 0,
    total: bets.length,
    flagged: 0,
  };
  for (const b of bets) {
    const flags = flagsFor(b, dupes, now);
    for (const f of flags) out[f] += 1;
    if (flags.length) out.flagged += 1;
  }
  return out;
}

/* ------------------------------ CLV-täckning ------------------------------ */

export interface ClvCoverage {
  /** Bets a closing price could meaningfully be recorded for. */
  eligible: number;
  withClosing: number;
  pct: number | null;
  /** Excluded from `eligible`, and why, so the UI can say so. */
  boosted: number;
  placeholder: number;
}

/**
 * How much of the journal actually has a closing price.
 *
 * Boosted prices are excluded on both sides: a boost is not a market price, so
 * comparing it to the close measures the boost, not the bet. Placeholder odds
 * are excluded for the same reason — there is no real price to compare.
 */
export function clvCoverage(bets: QualityBet[]): ClvCoverage {
  let eligible = 0;
  let withClosing = 0;
  let boosted = 0;
  let placeholder = 0;
  for (const b of bets) {
    if (b.boosted) {
      boosted += 1;
      continue;
    }
    if (!hasRealOdds(b)) {
      placeholder += 1;
      continue;
    }
    eligible += 1;
    if (b.closingOdds != null && b.closingOdds > 1) withClosing += 1;
  }
  return {
    eligible,
    withClosing,
    pct: eligible > 0 ? (withClosing / eligible) * 100 : null,
    boosted,
    placeholder,
  };
}

/** Eligible for a closing price but still missing one — the work queue. */
export function missingClosing(bet: QualityBet): boolean {
  return !bet.boosted && hasRealOdds(bet) && !(bet.closingOdds != null && bet.closingOdds > 1);
}
