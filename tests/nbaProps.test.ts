import { describe, it, expect } from "vitest";
import { actualStat, histogram, overProb, simulatePlayer, summarizeSamples, DEFAULT_PROP_PARAMS } from "../lib/nba/props";
import { propEnv } from "../lib/nba/propEnv";
import { priceProp } from "../lib/nba/propsPipeline";
import { classifyBasketballProp, extractPropLines, normalizeName, propStatOf } from "../lib/oddspapi/markets";
import type { OpFixtureOdds, OpMarket } from "../lib/oddspapi";
import type { PlayerRates } from "../lib/nba/ratings";
import type { RatingTable } from "../lib/nba/teamRatings";

// En 20-poängsspelare: 0,35 2PA och 0,2 3PA per minut, 34 minuter.
const SCORER: PlayerRates = { a2: 0.35, a3: 0.2, fta: 0.15, tov: 0.08, oreb: 0.03, dreb: 0.15, ast: 0.15, pct2: 0.55, pct3: 0.37, ftPct: 0.85, sample: 1000 };

describe("prop-simuleringen", () => {
  const s = simulatePlayer(SCORER, 34, undefined, { ...DEFAULT_PROP_PARAMS, sims: 8000 }, 7);

  it("snittet matchar takterna", () => {
    // 34 min: 11,9 2PA·0,55·2 + 6,8 3PA·0,37·3 + 5,1 FTA·0,85 ≈ 13,1 + 7,5 + 4,3 = 24,9
    expect(summarizeSamples(s.pts).mean).toBeGreaterThan(23);
    expect(summarizeSamples(s.pts).mean).toBeLessThan(27);
    expect(summarizeSamples(s.reb).mean).toBeCloseTo(0.18 * 34, 0);
    expect(summarizeSamples(s.ast).mean).toBeCloseTo(0.15 * 34, 0);
  });

  it("PRA är summan och trepoängare ryms i poängen", () => {
    for (let i = 0; i < 200; i++) {
      expect(s.pra[i]).toBe(s.pts[i] + s.reb[i] + s.ast[i]);
      expect(s.pts[i]).toBeGreaterThanOrEqual(3 * s.fg3[i]);
    }
  });

  it("samma seed ger samma kvällar, 0 minuter ger 0", () => {
    const a = simulatePlayer(SCORER, 30, undefined, { ...DEFAULT_PROP_PARAMS, sims: 100 }, 3);
    const b = simulatePlayer(SCORER, 30, undefined, { ...DEFAULT_PROP_PARAMS, sims: 100 }, 3);
    expect(Array.from(a.pts)).toEqual(Array.from(b.pts));
    const z = simulatePlayer(SCORER, 0, undefined, { ...DEFAULT_PROP_PARAMS, sims: 100 }, 3);
    expect(Math.max(...Array.from(z.pra))).toBe(0);
  });

  it("snabbare match och sämre försvar ger fler poäng", () => {
    const fast = simulatePlayer(SCORER, 34, { paceFactor: 1.08, effLogit: 0.1, astFactor: 1.05 }, { ...DEFAULT_PROP_PARAMS, sims: 8000 }, 7);
    expect(summarizeSamples(fast.pts).mean).toBeGreaterThan(summarizeSamples(s.pts).mean + 1);
  });

  it("över/push och histogram", () => {
    const x = Int16Array.from([10, 20, 20, 30]);
    expect(overProb(x, 20)).toEqual({ p: 0.5, push: 0.5 });
    expect(overProb(x, 19.5).p).toBe(0.75);
    const h = histogram(Int16Array.from([0, 2, 2]));
    expect(h).toEqual([1, 0, 2]);
  });

  it("pris mot en linje: vikt 15 % mot avviggat pris", () => {
    const pr = priceProp(s.pts, 24.5, 1.91, 1.91);
    expect(pr.pMarket).toBeCloseTo(0.5, 6);
    expect(pr.pFinal).toBeCloseTo(0.15 * pr.pModel + 0.85 * 0.5, 6);
  });

  it("utfall ur boxscore", () => {
    const r = { pts: 25, oreb: 2, dreb: 6, ast: 7, fgm3: 3 };
    expect(actualStat("reb", r)).toBe(8);
    expect(actualStat("pra", r)).toBe(40);
    expect(actualStat("fg3", r)).toBe(3);
  });
});

describe("matchmiljö ur lagratingen", () => {
  const rt: RatingTable = {
    ortg: 115,
    pace: 99,
    teams: new Map([
      [1, { off: 2, def: 0, pace: 2, weight: 10 }],
      [2, { off: 0, def: 4, pace: 3, weight: 10 }],
    ]),
  };
  it("dåligt försvar och snabb motståndare ger mer", () => {
    const e = propEnv(rt, 1, 2);
    expect(e.paceFactor).toBeGreaterThan(1);
    expect(e.effLogit).toBeGreaterThan(0);
    expect(propEnv(null, 1, 2)).toEqual({ paceFactor: 1, effLogit: 0, astFactor: 1 });
  });
});

describe("namn", () => {
  it("initialer och kända smeknamn kopplas till ESPN:s namn", async () => {
    const { normalizeName } = await import("../lib/oddspapi/markets");
    expect(normalizeName("A.J. Green")).toBe(normalizeName("AJ Green"));
    expect(normalizeName("Green, A.J.")).toBe("aj green");
    expect(normalizeName("Alexandre Sarr")).toBe(normalizeName("Alex Sarr"));
    expect(normalizeName("Sarr, Alexandre")).toBe("alex sarr");
    expect(normalizeName("Luka Dončić")).toBe("luka doncic");
    expect(normalizeName("Jaren Jackson Jr.")).toBe("jaren jackson");
    expect(normalizeName("Shai Gilgeous-Alexander")).toBe("shai gilgeous alexander");
  });
});

describe("OddsPapi-props", () => {
  const mk = (id: number, name: string, hc: number, prop = true): OpMarket => ({
    marketId: id,
    marketName: name,
    playerProp: prop,
    sportId: 11,
    handicap: hc,
    period: "fulltime",
    marketType: "totals",
    outcomes: [
      { outcomeId: id, outcomeName: "Over" },
      { outcomeId: id + 1, outcomeName: "Under" },
    ],
  });

  it("känner igen statistiken ur namnet", () => {
    expect(propStatOf("Player Points")).toBe("pts");
    expect(propStatOf("Player Rebounds")).toBe("reb");
    expect(propStatOf("Player Assists")).toBe("ast");
    expect(propStatOf("Player Threes Made")).toBe("fg3");
    // Stavningar som tidigare blev "poäng" (Pinnacles trepoängare hamnade under Poäng).
    expect(propStatOf("Player 3 Point Field Goals")).toBe("fg3");
    expect(propStatOf("Player 3 Pointers Made")).toBe("fg3");
    expect(propStatOf("3-Point Field Goals Made (incl. overtime)")).toBe("fg3");
    expect(propStatOf("Player 3PM")).toBe("fg3");
    expect(propStatOf("Player Field Goals Made")).toBeNull();
    expect(propStatOf("Player Points (incl. overtime)")).toBe("pts");
    expect(propStatOf("Points + Rebounds + Assists")).toBe("pra");
    expect(propStatOf("Player Points 1st Quarter")).toBeNull();
    expect(propStatOf("Double Double")).toBeNull();
    expect(propStatOf("Points + Rebounds")).toBeNull();
  });

  it("klassar bara spelarprops för basket", () => {
    expect(classifyBasketballProp(mk(500, "Player Points", 24.5))).toMatchObject({ stat: "pts", line: 24.5 });
    expect(classifyBasketballProp(mk(500, "Player Points", 24.5, false))).toBeNull();
  });

  it("parar över och under per spelare", () => {
    const markets = { "500": classifyBasketballProp(mk(500, "Player Points", 24.5))! };
    const fx = {
      fixtureId: "x",
      participant1Id: 1,
      participant2Id: 2,
      sportId: 11,
      tournamentId: 132,
      statusId: 0,
      startTime: "2026-11-02T00:00:00Z",
      bookmakerOdds: {
        pinnacle: {
          markets: {
            "500": {
              outcomes: {
                "500": { players: { "11": { price: 1.9, playerName: "Luka Dončić" }, "12": { price: 2.0, playerName: "Kyrie Irving" } } },
                "501": { players: { "11": { price: 1.9, playerName: "Luka Dončić" } } },
              },
            },
          },
        },
      },
    } as unknown as OpFixtureOdds;
    const rows = extractPropLines(fx, "pinnacle", markets);
    expect(rows).toEqual([{ stat: "pts", playerName: "Luka Dončić", line: 24.5, over: 1.9, under: 1.9 }]);
  });

  it("namn utan accenter och suffix", () => {
    expect(normalizeName("Luka Dončić")).toBe("luka doncic");
    expect(normalizeName("Jaren Jackson Jr.")).toBe("jaren jackson");
    expect(normalizeName("De'Anthony Melton")).toBe("de anthony melton");
    // OddsPapi: "Efternamn, Förnamn" (nba:update 2026-11-02).
    expect(normalizeName("Reaves, Austin")).toBe(normalizeName("Austin Reaves"));
    expect(normalizeName("Barrett, RJ")).toBe("rj barrett");
    expect(normalizeName("Walker, Ja'Kobe")).toBe("ja kobe walker");
    expect(normalizeName("Jackson Jr., Jaren")).toBe("jaren jackson");
  });
});

describe("prop-minuter", () => {
  it("räknar på minuterna om han spelar: skadelistan drar inte ner dem, din ändring gäller", async () => {
    const { minutesIfPlaying } = await import("../lib/nba/minutes");
    // Day-To-Day ×0,6: 21 förväntade minuter → 35 om han spelar.
    expect(minutesIfPlaying({ minutes: 21, injuryStatus: "Day-To-Day", override: null })).toBeCloseTo(35, 6);
    expect(minutesIfPlaying({ minutes: 30, injuryStatus: null, override: null })).toBe(30);
    expect(minutesIfPlaying({ minutes: 0, injuryStatus: "Out", override: null })).toBe(0);
    expect(minutesIfPlaying({ minutes: 20, injuryStatus: "Questionable", override: 24 })).toBe(24);
    expect(minutesIfPlaying({ minutes: 30, injuryStatus: "Doubtful", override: null })).toBe(42); // tak
  });
});

describe("frånvaro i minuthistoriken", () => {
  it("bara tränarens val är en riktig nolla; kroppsdelar och sjukdom är frånvaro", async () => {
    const { isAbsence } = await import("../lib/nba/minutes");
    expect(isAbsence(true, "LOW BACK SORENESS")).toBe(true);
    expect(isAbsence(true, "LEFT ACHILLES TENDON")).toBe(true);
    expect(isAbsence(true, "INJURY/ILLNESS - LEFT KNEE")).toBe(true);
    expect(isAbsence(true, "COACH'S DECISION")).toBe(false);
    expect(isAbsence(true, "DND - COACH'S DECISION")).toBe(false);
    expect(isAbsence(true, null)).toBe(false);
    expect(isAbsence(false, "LOW BACK SORENESS")).toBe(false);
  });
});
