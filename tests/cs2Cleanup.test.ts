import { describe, it, expect } from "vitest";
import { selectCleanup, type CleanupLine } from "../lib/cs2/cleanup";

const t0 = new Date("2026-11-18T22:58:44Z");
const L = (id: number, matchId: number, line: number, extra: Partial<CleanupLine> = {}): CleanupLine => ({
  id,
  matchId,
  market: "match_handicap",
  scope: "match",
  playerId: null,
  player2Id: null,
  teamId: 9,
  line,
  bookmaker: "Unibet",
  overOdds: 1.5,
  underOdds: 2.5,
  createdAt: t0,
  ...extra,
});

describe("rensning av felrader", () => {
  it("rundstegen bort, riktiga karthandikapp kvar", () => {
    const formats = new Map([[1, "bo3"], [2, "bo5"], [3, "bo1"], [4, "bo5"]]);
    const r = selectCleanup(
      [
        L(1, 1, -1.5), // Bo3 ±1,5: riktig
        L(2, 1, -2.5), // Bo3 ±2,5: rundor
        L(3, 2, 2.5), // Bo5 ±2,5 i samma hämtning som rundstegen: rundor
        L(4, 2, -4.5), // Bo5 ±4,5: rundor
        L(5, 3, -2.5), // Bo1: allt är rundor
        L(6, 4, 2.5), // Bo5 ±2,5 utan rundsteg: riktig
      ],
      formats
    );
    expect(r.roundHandicap.sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it("Bo5 ±2,5 långt ifrån rundstegen i tid räknas som riktig", () => {
    const r = selectCleanup([L(1, 2, -2.5), L(2, 2, -4.5, { createdAt: new Date(t0.getTime() + 60_000) })], new Map([[2, "bo5"]]));
    expect(r.roundHandicap).toEqual([2]);
  });

  it("exakt samma odds i nästa version är en dubblett, ändrade odds inte", () => {
    const k = { market: "kills", teamId: null, playerId: 7 } as const;
    const r = selectCleanup([L(10, 1, 15.5, k), L(11, 1, 15.5, k), L(12, 1, 15.5, { ...k, overOdds: 1.9 }), L(13, 1, 15.5, { ...k, overOdds: 1.5 })], new Map([[1, "bo3"]]));
    expect(r.duplicates).toEqual([11]);
  });

  it("samma linje hos olika böcker är ingen dubblett", () => {
    const k = { market: "kills", teamId: null, playerId: 7 } as const;
    const r = selectCleanup([L(10, 1, 15.5, k), L(11, 1, 15.5, { ...k, bookmaker: "Bet365" })], new Map([[1, "bo3"]]));
    expect(r.duplicates).toEqual([]);
  });
});
