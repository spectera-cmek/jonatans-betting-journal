import { describe, it, expect } from "vitest";
import { buildHistory, type TeamGameRow } from "../lib/nba/ratings";
import { expectedOrtg, fitTeamRatings, ratingOf } from "../lib/nba/teamRatings";
import { bucketRecords, clvPoints, gradePick, modelLine, pickFromLine } from "../lib/nba/picks";
import { DEFAULT_NBA_PARAMS } from "../lib/nba/params";

const day = 864e5;
const t0 = Date.UTC(2026, 0, 1);

/** Lagrad med ~100 possessions och givna poäng. */
function row(gameId: number, t: number, teamId: number, oppId: number, home: boolean, pts: number, oppDreb = 33): TeamGameRow {
  return { gameId, t, teamId, oppId, home, pts, fga2: 50, fgm2: 26, fga3: 35, fgm3: 13, fta: 22, ftm: 17, oreb: 10, dreb: 33, tov: 14, oppDreb, periods: 4 };
}

describe("lagrating", () => {
  // Lag 1 gör alltid 10 poäng mer än lag 2, som gör 10 mer än lag 3. Alla möter alla.
  const rows: TeamGameRow[] = [];
  const pts: Record<number, number> = { 1: 120, 2: 110, 3: 100 };
  let id = 0;
  for (let k = 0; k < 20; k++) {
    for (const [a, b] of [
      [1, 2],
      [2, 3],
      [3, 1],
    ]) {
      const t = t0 + (k * 3 + id) * day;
      id++;
      rows.push(row(id, t, a, b, true, pts[a]), row(id, t, b, a, false, pts[b]));
    }
  }
  const h = buildHistory([], rows);
  // Strax efter sista matchen — gamla matcher väger nästan inget (halveringstid).
  const asOf = t0 + 120 * day;
  const r = fitTeamRatings(h, asOf, { ...DEFAULT_NBA_PARAMS, homeRtg: 0, ratingRidgeGames: 0.5 });

  it("rangordnar anfallen och snittlaget är 0", () => {
    const o = [1, 2, 3].map((t) => ratingOf(r, t).off);
    expect(o[0]).toBeGreaterThan(o[1]);
    expect(o[1]).toBeGreaterThan(o[2]);
    expect(o[0] + o[1] + o[2]).toBeCloseTo(0, 6);
  });

  it("förväntad ORtg följer skillnaden mellan lagen", () => {
    const e12 = expectedOrtg(r, 1, 2);
    const e21 = expectedOrtg(r, 2, 1);
    expect(e12 - e21).toBeGreaterThan(5);
  });

  it("framtida matcher påverkar inte", () => {
    const early = fitTeamRatings(h, t0, DEFAULT_NBA_PARAMS);
    expect(early.teams.size).toBe(0);
  });

  it("okänt lag får snittet", () => {
    expect(ratingOf(r, 999)).toMatchObject({ off: 0, def: 0, pace: 0 });
  });
});

describe("picks i poäng", () => {
  it("modellens linjer ur projicerat resultat", () => {
    // Bortalaget BOS 116,5, hemma ORL 109,3 → hemma +7,2.
    expect(modelLine("spread", 109.3, 116.5)).toBe(7.2);
    expect(modelLine("total", 109.3, 116.5)).toBe(225.8);
  });

  it("väljer sida och edge som Sams kort: modell BOS −7,2 mot −6,5 → BOS −6,5 (0,7)", () => {
    // Hemma ORL: marknad +6,5, modell +7,2 → modellen tror mindre på ORL → borta.
    expect(pickFromLine("spread", 7.2, 6.5)).toEqual({ side: 2, edgePts: 0.7 });
    expect(pickFromLine("spread", -9, -6.5)).toEqual({ side: 1, edgePts: 2.5 });
    expect(pickFromLine("total", 230, 225.5)).toEqual({ side: 1, edgePts: 4.5 });
    expect(pickFromLine("total", 220, 225.5)).toEqual({ side: 2, edgePts: 5.5 });
  });

  it("rättar vinst, förlust och push", () => {
    // BOS (borta) −6,5 = hemma +6,5. BOS vinner med 7 → vinst för borta.
    expect(gradePick("spread", 2, 6.5, 100, 107)).toBe("W");
    expect(gradePick("spread", 2, 6.5, 100, 106)).toBe("L");
    expect(gradePick("spread", 1, -3, 103, 100)).toBe("P");
    expect(gradePick("total", 1, 220.5, 110, 111)).toBe("W");
    expect(gradePick("total", 2, 220.5, 110, 111)).toBe("L");
  });

  it("CLV i poäng: positivt när stängningen gick mot oss", () => {
    // Hemma −6,5 låst, stängde −7,5 → vi fick en poäng bättre.
    expect(clvPoints("spread", 1, -6.5, -7.5)).toBe(1);
    expect(clvPoints("spread", 2, -6.5, -7.5)).toBe(-1);
    expect(clvPoints("total", 1, 220, 222)).toBe(2);
    expect(clvPoints("total", 2, 220, 222)).toBe(-2);
  });

  it("facit per edge-hink", () => {
    const b = bucketRecords([
      { edgePts: 1, result: "W", price: 1.91 },
      { edgePts: 4, result: "L", price: 1.91 },
      { edgePts: 7, result: "W", price: 2.0, clv: 1 },
      { edgePts: 7, result: "P", price: 1.91, clv: -0.5 },
    ]);
    expect(b.map((x) => [x.minEdge, x.w, x.l, x.p])).toEqual([
      [0, 2, 1, 1],
      [3, 1, 1, 1],
      [6, 1, 0, 1],
    ]);
    expect(b[0].hit).toBeCloseTo(2 / 3, 6);
    expect(b[2].roi).toBeCloseTo(1 / 2, 6);
    expect(b[2].clv).toBeCloseTo(0.25, 6);
  });
});
