import { describe, it, expect } from "vitest";
import { injuryFactor, projectMinutes, baselineMinutes, type MinutesInput } from "../lib/nba/minutes";
import { mulberry32, simulateGame, summarize, spreadProb, totalProb, moneylineProb, type TeamSimInput } from "../lib/nba/sim";
import { buildHistory, leagueAverages, playerRates, possessions, teamProfile, type PlayerGameRow, type TeamGameRow } from "../lib/nba/ratings";
import { fairLine, priceMarket, settle } from "../lib/nba/pricing";
import { adjustForDefense, projectGame } from "../lib/nba/project";
import { DEFAULT_NBA_PARAMS } from "../lib/nba/params";

const AVG: TeamSimInput = { pTov: 0.124, pFt: 0.086, p3: 0.328, p2: 0.461, pct2: 0.545, pct3: 0.36, ftPct: 0.78, orebPct: 0.26, shotLogit: 0 };
const base = { possMean: 99, possSd: 4, nightSigma: 0.03, sharedSigma: 0.04, rubberBand: 0.07, ftsPerTrip: 1 / 0.44, sims: 6000 };

describe("minuter", () => {
  const inp = (id: number, baseline: number, extra: Partial<MinutesInput> = {}): MinutesInput => ({
    playerId: id,
    name: `P${id}`,
    position: "G",
    baseline,
    games: 10,
    injuryStatus: null,
    injuryDetail: null,
    override: null,
    ...extra,
  });

  it("skadestatus ger rätt andel", () => {
    expect(injuryFactor("Out")).toBe(0);
    expect(injuryFactor("Questionable")).toBe(0.5);
    expect(injuryFactor("Day-To-Day")).toBe(0.6);
    expect(injuryFactor(null)).toBe(1);
  });

  it("laget får 240 minuter och en skadad spelare 0", () => {
    const rows = projectMinutes([inp(1, 36), inp(2, 34, { injuryStatus: "Out" }), inp(3, 30), inp(4, 28), inp(5, 26), inp(6, 22), inp(7, 18), inp(8, 14), inp(9, 10)]);
    const sum = rows.reduce((a, r) => a + r.minutes, 0);
    expect(sum).toBeCloseTo(240, 0);
    expect(rows.find((r) => r.playerId === 2)!.minutes).toBe(0);
    // Hans minuter går till de andra: alla friska får mer än sina grundminuter.
    expect(rows.find((r) => r.playerId === 3)!.minutes).toBeGreaterThan(30);
  });

  it("manuell ändring vinner och respekteras exakt", () => {
    const rows = projectMinutes([inp(1, 36, { override: 20 }), inp(2, 34, { injuryStatus: "Out", override: 30 }), inp(3, 30), inp(4, 28), inp(5, 26), inp(6, 22), inp(7, 18), inp(8, 14)]);
    expect(rows.find((r) => r.playerId === 1)!.minutes).toBe(20);
    expect(rows.find((r) => r.playerId === 2)!.minutes).toBe(30);
    expect(rows.reduce((a, r) => a + r.minutes, 0)).toBeCloseTo(240, 0);
  });

  it("ingen spelare får mer än taket", () => {
    const rows = projectMinutes([inp(1, 40), inp(2, 38), inp(3, 36), inp(4, 10), inp(5, 8), inp(6, 5)]);
    expect(Math.max(...rows.map((r) => r.minutes))).toBeLessThanOrEqual(42);
  });
});

describe("simulering", () => {
  it("samma seed ger samma resultat", () => {
    const a = simulateGame({ home: AVG, away: AVG, ...base, seed: 7 });
    const b = simulateGame({ home: AVG, away: AVG, ...base, seed: 7 });
    expect(Array.from(a.home.slice(0, 50))).toEqual(Array.from(b.home.slice(0, 50)));
    expect(mulberry32(1)()).toBe(mulberry32(1)());
  });

  it("två lika lag på neutral plan ger ~50 % och rimliga NBA-siffror", () => {
    const s = summarize(simulateGame({ home: AVG, away: AVG, ...base, sims: 20000, seed: 3 }));
    expect(s.pHomeWin).toBeGreaterThan(0.48);
    expect(s.pHomeWin).toBeLessThan(0.52);
    expect(s.totalMean).toBeGreaterThan(205);
    expect(s.totalMean).toBeLessThan(245);
    // NBA: marginalens spridning runt 12–14, totalens runt 18–21.
    expect(s.marginSd).toBeGreaterThan(11);
    expect(s.marginSd).toBeLessThan(15);
    expect(s.totalSd).toBeGreaterThan(16);
    expect(s.totalSd).toBeLessThan(23);
    expect(s.otRate).toBeGreaterThan(0.01);
    expect(s.otRate).toBeLessThan(0.1);
  });

  it("bättre skytte ger favorit och spridningen dras inte mot noll", () => {
    const fav = { ...AVG, pct2: 0.57, pct3: 0.38 };
    const noRb = summarize(simulateGame({ home: fav, away: AVG, ...base, rubberBand: 0, seed: 5 }));
    const rb = summarize(simulateGame({ home: fav, away: AVG, ...base, seed: 5 }));
    expect(rb.marginMean).toBeGreaterThan(3);
    // Rubber band krymper spridningen men inte favoritens förväntade marginal.
    expect(Math.abs(rb.marginMean - noRb.marginMean)).toBeLessThan(0.8);
    expect(rb.marginSd).toBeLessThan(noRb.marginSd);
  });

  it("push-sannolikhet bara på hela linjer", () => {
    const r = simulateGame({ home: AVG, away: AVG, ...base, seed: 9 });
    expect(spreadProb(r, -3.5).push).toBe(0);
    expect(spreadProb(r, -3).push).toBeGreaterThan(0.01);
    expect(totalProb(r, 224.5).push).toBe(0);
    expect(totalProb(r, 224).push).toBeGreaterThan(0);
    // Hemma −0,5 täcker exakt när hemma vinner (ingen oavgjort i NBA).
    expect(spreadProb(r, -0.5).p).toBeCloseTo(moneylineProb(r), 6);
  });
});

describe("prissättning", () => {
  const r = simulateGame({ home: { ...AVG, shotLogit: 0.05 }, away: AVG, ...base, seed: 11 });

  it("utan marknadspris är slutsannolikheten modellens", () => {
    const p = priceMarket(r, { market: "ml", line: null, price1: null, price2: null });
    expect(p.pMarket).toBeNull();
    expect(p.pFinal).toBeCloseTo(p.pModel, 6);
    expect(p.fairOver).toBeCloseTo(1 / p.pModel, 6);
  });

  it("vägs mot marknaden och räknar edge mot priset", () => {
    const p = priceMarket(r, { market: "total", line: 224.5, price1: 1.91, price2: 1.91, book: "pinnacle" }, 0.3);
    expect(p.pMarket).toBeCloseTo(0.5, 6);
    expect(p.pFinal).toBeCloseTo(0.3 * p.pModel + 0.7 * 0.5, 6);
    expect(p.edgeOver).toBeCloseTo(1.91 * p.pFinal - 1, 6);
    expect(p.book).toBe("pinnacle");
  });

  it("modellens linje ligger nära snittet", () => {
    const s = summarize(r);
    expect(Math.abs(fairLine(r, "spread") + s.marginMean)).toBeLessThan(1.5);
    expect(Math.abs(fairLine(r, "total") - s.totalMean)).toBeLessThan(1.5);
  });

  it("facit", () => {
    expect(settle("ml", null, 110, 100)).toBe(1);
    expect(settle("spread", -10, 110, 100)).toBe(0.5);
    expect(settle("spread", -9.5, 110, 100)).toBe(1);
    expect(settle("spread", 4.5, 100, 110)).toBe(0);
    expect(settle("total", 210.5, 110, 100)).toBe(0);
    expect(settle("total", 209.5, 110, 100)).toBe(1);
  });
});

describe("ratings och matchbygge", () => {
  // Två lag, tio matcher mot varandra: lag 1 skjuter bättre än lag 2.
  const players: PlayerGameRow[] = [];
  const teams: TeamGameRow[] = [];
  const day = 864e5;
  const t0 = Date.UTC(2026, 0, 1);
  for (let g = 0; g < 10; g++) {
    const t = t0 + g * 2 * day;
    for (const [teamId, oppId, good] of [
      [1, 2, true],
      [2, 1, false],
    ] as const) {
      const box = { fga2: 50, fgm2: good ? 29 : 25, fga3: 36, fgm3: good ? 15 : 12, fta: 22, ftm: 17, oreb: 10, dreb: 34, tov: 13 };
      teams.push({ gameId: g, t, teamId, oppId, home: teamId === 1, pts: (box.fgm2 * 2 + box.fgm3 * 3 + box.ftm), ...box, oppDreb: 34, periods: 4 });
      for (let p = 0; p < 8; p++) {
        const share = 1 / 8;
        players.push({
          gameId: g,
          t,
          playerId: teamId * 100 + p,
          teamId,
          position: p < 3 ? "G" : p < 6 ? "F" : "C",
          minutes: 30,
          fga2: box.fga2 * share,
          fgm2: box.fgm2 * share,
          fga3: box.fga3 * share,
          fgm3: box.fgm3 * share,
          fta: box.fta * share,
          ftm: box.ftm * share,
          oreb: box.oreb * share,
          tov: box.tov * share,
          dnp: false,
          dnpReason: null,
        });
      }
    }
  }
  const h = buildHistory(players, teams);
  const asOf = t0 + 25 * day;

  it("possessions enligt 0,44-regeln", () => {
    expect(possessions({ fga2: 50, fga3: 36, fta: 22, oreb: 10, tov: 13 })).toBeCloseTo(98.68, 2);
  });

  it("framtida matcher påverkar inte", () => {
    const early = playerRates(h, 100, t0, leagueAverages(h, t0));
    expect(early.sample).toBe(0);
    const later = playerRates(h, 100, asOf, leagueAverages(h, asOf));
    expect(later.sample).toBeGreaterThan(0);
  });

  it("grundminuter tas från lagets spelare", () => {
    const b = baselineMinutes(h, 1, asOf);
    expect(b).toHaveLength(8);
    expect(b[0].baseline).toBeCloseTo(30, 6);
  });

  it("försvarsjustering behåller andelar som summerar till 1", () => {
    const lg = leagueAverages(h, asOf);
    const tp = teamProfile(h, 2, asOf, lg);
    const adj = adjustForDefense(lg, tp.allowed, lg);
    expect(adj.pTov + adj.pFt + adj.p3 + adj.p2).toBeCloseTo(1, 9);
  });

  it("laget som skjuter bättre blir favorit", () => {
    const lineup = (teamId: number) => Array.from({ length: 8 }, (_, p) => ({ playerId: teamId * 100 + p, minutes: 30 }));
    const proj = projectGame(h, { homeId: 2, awayId: 1, t: asOf, neutral: true, homeLineup: lineup(2), awayLineup: lineup(1) }, { ...DEFAULT_NBA_PARAMS, sims: 4000 });
    expect(proj.summary.pHomeWin).toBeLessThan(0.45);
    expect(proj.summary.marginMean).toBeLessThan(0);
  });
});
