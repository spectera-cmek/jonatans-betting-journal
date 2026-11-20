// Engångsrensningen 2026-11-20 (scripts/cs2/cleanup-2026-11-20.ts): vilka
// sparade linjer som är fel. Ren logik, testad i tests/cs2Cleanup.test.ts.
//
// 1. Rundhandikapp över hela matchen sparades som karthandikapp
//    (match_handicap) innan kambi.ts skilde dem åt. En karthandikapp kan inte
//    vara större än serien tillåter (maxMatchHandicap). Bo5 ±2,5 är både en
//    riktig karthandikapp och ett steg i rundstegen — den räknas som rundor
//    bara om den sparades i samma hämtning som ett tydligt rundsteg (±3,5+).
// 2. Exakta dubbletter: samma linje och bok sparad igen med samma odds som
//    versionen före — två hämtningar som gick samtidigt.

import { lineKey, maxMatchHandicap, type LineIdentity } from "./lineInput";

export type CleanupLine = LineIdentity & {
  id: number;
  matchId: number;
  bookmaker: string | null;
  overOdds: number | null;
  underOdds: number | null;
  createdAt: Date;
};

/** Hur nära i tid en Bo5-rad på ±2,5 ska ligga ett rundsteg för att höra till samma hämtning. */
const SAME_CAPTURE_MS = 10_000;

export function selectCleanup(lines: CleanupLine[], formats: Map<number, string>): { roundHandicap: number[]; duplicates: number[] } {
  const roundHandicap: number[] = [];
  const handicaps = lines.filter((l) => l.market === "match_handicap" && l.line != null);
  for (const l of handicaps) {
    const format = formats.get(l.matchId) ?? "bo3";
    const abs = Math.abs(l.line!);
    if (abs > maxMatchHandicap(format)) {
      roundHandicap.push(l.id);
    } else if (format === "bo5" && abs === 2.5) {
      const ladderNearby = handicaps.some(
        (o) => o.matchId === l.matchId && Math.abs(o.line!) > maxMatchHandicap("bo5") && Math.abs(o.createdAt.getTime() - l.createdAt.getTime()) <= SAME_CAPTURE_MS
      );
      if (ladderNearby) roundHandicap.push(l.id);
    }
  }

  const duplicates: number[] = [];
  const versions = new Map<string, CleanupLine[]>();
  for (const l of lines) {
    const k = `${l.matchId}|${(l.bookmaker ?? "").trim().toLowerCase()}|${lineKey(l)}`;
    versions.set(k, [...(versions.get(k) ?? []), l]);
  }
  for (const vs of versions.values()) {
    vs.sort((a, b) => a.id - b.id);
    for (let i = 1; i < vs.length; i++) {
      if (vs[i].overOdds === vs[i - 1].overOdds && vs[i].underOdds === vs[i - 1].underOdds) duplicates.push(vs[i].id);
    }
  }
  return { roundHandicap, duplicates };
}
