// Disciplinregler ur din egen data.
//
// The guard in the add-bet modal used to quote numbers hardcoded from one
// analysis run: by the time the same history had grown by another season,
// several of those verdicts had reversed and the modal was warning about the
// wrong things. These rules are derived instead — same four dimensions the
// "Läckor & Edge" panel slices along (lib/edge), over a trailing window, and
// only for segments that are both big enough and far enough from the no-edge
// baseline to be worth saying out loud.
//
// Pure & dependency-free so it is trivially unit-testable and can run either on
// the server (in /api/metrics) or in a script.

import { EDGE_DIMENSIONS, edgeSegmentCandidates, type EdgeBetInput, type EdgeSegment } from "./edge";
import { varianceByKey } from "./variance";
import { filterByPeriod } from "./periods";
import { round2 } from "./betting";

export interface DisciplineRule {
  dim: EdgeSegment["dim"];
  key: string;
  settled: number;
  profitUnits: number;
  roiPct: number | null;
  /** No-edge z for the segment; sign follows the money. */
  z: number | null;
  tone: "pos" | "neg";
}

export interface DisciplineRuleSet {
  rules: DisciplineRule[];
  /** Human label for the window the rules were derived from. */
  windowLabel: string;
  /** Settled bets the window contained — shown when the guard has too little to say. */
  settled: number;
  minSettled: number;
}

export interface DeriveOptions {
  /** Trailing window in days; null = the whole history. */
  sinceDays?: number | null;
  /** Sample-size floor per segment. */
  minSettled?: number;
  /** How far from the no-edge baseline a segment must sit to become a rule. */
  minAbsZ?: number;
  now?: number;
}

const DEFAULTS = { sinceDays: 365, minSettled: 40, minAbsZ: 1 };

export function windowLabelFor(sinceDays: number | null): string {
  if (!sinceDays) return "hela historiken";
  if (sinceDays % 365 === 0) {
    const y = sinceDays / 365;
    return y === 1 ? "senaste året" : `senaste ${y} åren`;
  }
  const months = Math.round(sinceDays / 30);
  return `senaste ${months} mån`;
}

export function deriveDisciplineRules(
  bets: EdgeBetInput[],
  options: DeriveOptions = {}
): DisciplineRuleSet {
  const sinceDays = options.sinceDays === undefined ? DEFAULTS.sinceDays : options.sinceDays;
  const minSettled = options.minSettled ?? DEFAULTS.minSettled;
  const minAbsZ = options.minAbsZ ?? DEFAULTS.minAbsZ;
  const windowBets = filterByPeriod(bets, sinceDays, options.now ?? Date.now());

  // z per (dimension, key), grouped exactly as the segments are.
  const zByDim = new Map<string, Map<string, number>>();
  for (const d of EDGE_DIMENSIONS) {
    const source = d.include ? windowBets.filter((b) => d.include!(b)) : windowBets;
    const zs = new Map<string, number>();
    // minN=1: the sample gate is minSettled on the segment itself, applied below.
    for (const v of varianceByKey(source, (b) => d.keyOf(b as EdgeBetInput) ?? d.fallback, 1)) {
      if (v.z != null) zs.set(v.key, v.z);
    }
    zByDim.set(d.dim, zs);
  }

  // "Övrigt" / "Okänd sport" are where everything unclassified lands. They are
  // real segments and the Läckor & Edge panel is right to show them, but as a
  // warning while typing ("Övrigt: +18 % ROI") they say nothing actionable.
  const catchAll = new Set(EDGE_DIMENSIONS.map((d) => `${d.dim}:${d.fallback}`));

  const rules: DisciplineRule[] = [];
  for (const seg of edgeSegmentCandidates(windowBets, minSettled)) {
    if (catchAll.has(`${seg.dim}:${seg.key}`)) continue;
    const z = zByDim.get(seg.dim)?.get(seg.key) ?? null;
    if (z == null || Math.abs(z) < minAbsZ) continue;
    rules.push({
      dim: seg.dim,
      key: seg.key,
      settled: seg.settled,
      profitUnits: round2(seg.profitUnits),
      roiPct: seg.roiPct,
      z: round2(z),
      tone: seg.profitUnits >= 0 ? "pos" : "neg",
    });
  }
  // Strongest signal first, so a modal that only has room for a few shows those.
  rules.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));

  const settled = windowBets.filter((b) => b.outcome !== "pending").length;
  return { rules, windowLabel: windowLabelFor(sinceDays), settled, minSettled };
}

/* ------------------------- Spel på samma match ---------------------------- */

export interface OpenEventCount {
  event: string;
  bets: number;
  stakeUnits: number;
}

/** Normalised match key — "Arsenal vs Chelsea " and "arsenal  vs chelsea" are one match. */
export function eventKey(event: string | null | undefined): string {
  return (event ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Roll every pending bet up per match. Counts are uncapped on purpose: the
 *  dashboard's own open list is truncated, and this is what the guard counts. */
export function openEventCounts(
  bets: { event: string; stakeUnits: number; outcome: string }[]
): OpenEventCount[] {
  const map = new Map<string, OpenEventCount>();
  for (const b of bets) {
    if (b.outcome !== "pending") continue;
    const key = eventKey(b.event);
    if (!key) continue;
    const row = map.get(key) ?? { event: key, bets: 0, stakeUnits: 0 };
    row.bets += 1;
    row.stakeUnits += b.stakeUnits;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.bets - a.bets);
}

export function countOnEvent(event: string | null | undefined, counts: OpenEventCount[]): OpenEventCount | null {
  const key = eventKey(event);
  if (!key) return null;
  return counts.find((c) => c.event === key) ?? null;
}
