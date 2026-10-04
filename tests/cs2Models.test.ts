import { describe, it, expect } from "vitest";
import {
  conversionRates,
  fitRatings,
  pistolObsFromMap,
  pistolWinProb,
  roundWinProb,
  sideObsFromMap,
  timeWeight,
  DEFAULT_CONV2,
} from "../lib/cs2/ratings";
import { flipDistribution, handicapProbs, mapDistribution, roundsPmf, type MapInputs } from "../lib/cs2/mapModel";
import { knownVeto, seriesProbs, vetoDistribution, vetoProfile, vetoSequence } from "../lib/cs2/veto";
import { headshotPmf, killPmfForMap, killRates, medianLine, pmfMean, seriesPmf, DEFAULT_LEAGUE_PRIOR } from "../lib/cs2/killModel";
import { firstKillProb, log5, openingRates, playerFirstKillProb } from "../lib/cs2/openingModel";
import { priceTwoWay } from "../lib/cs2/pricing";
import { buildAngles } from "../lib/cs2/angles";
import { buildMatchupView, modelProb, priceLine, type MatchupContext } from "../lib/cs2/matchup";
import type { RoundOutcome } from "../lib/cs2/types";

const even: MapInputs = { pCtA: 0.53, pCtB: 0.53, pistolCtA: 0.5, pistolCtB: 0.5, conv2: 0.8, conv3: 0.7, pAStartsCt: 0.5, sigma: 0.3 };

function moments(pmf: number[]) {
  const sum = pmf.reduce((a, b) => a + (b ?? 0), 0);
  const mean = pmf.reduce((a, b, k) => a + (b ?? 0) * k, 0);
  const v = pmf.reduce((a, b, k) => a + (b ?? 0) * k * k, 0) - mean * mean;
  return { sum, mean, sd: Math.sqrt(v) };
}

describe("ratings", () => {
  it("bygger observationer ur kartor och rundhistorik", () => {
    const m = { mapName: "nuke", team1Id: 1, team2Id: 2, team1CtRounds: 8, team1TRounds: 5, team2CtRounds: 7, team2TRounds: 2 };
    expect(sideObsFromMap(m, 1)).toEqual([
      { map: "nuke", ctTeam: 1, tTeam: 2, ctWins: 8, rounds: 10, w: 1 },
      { map: "nuke", ctTeam: 2, tTeam: 1, ctWins: 7, rounds: 12, w: 1 },
    ]);
    expect(sideObsFromMap({ ...m, team1CtRounds: null }, 1)).toEqual([]);
    const hist: RoundOutcome[] = [
      { n: 1, winner: "team2", side: "t", reason: "elimination" },
      { n: 13, winner: "team1", side: "ct", reason: "elimination" },
    ];
    expect(pistolObsFromMap({ team1Id: 1, team2Id: 2, roundHistory: hist }, 1)).toEqual([
      { ctTeam: 1, tTeam: 2, ctWon: false, w: 1 },
      { ctTeam: 1, tTeam: 2, ctWon: true, w: 1 },
    ]);
    expect(timeWeight(new Date("2026-01-01"), new Date("2026-05-01"), 120)).toBeCloseTo(0.5, 1);
  });

  it("konvertering efter pistol krymps mot standardvärdet", () => {
    expect(conversionRates([]).conv2).toBeCloseTo(DEFAULT_CONV2);
    const always = Array(200).fill([
      { n: 1, winner: "team1" },
      { n: 2, winner: "team1" },
      { n: 3, winner: "team1" },
    ]);
    const c = conversionRates(always);
    expect(c.conv2).toBeGreaterThan(0.95);
    expect(c.n2).toBe(200);
  });

  it("hittar det starkare laget och kartans CT-fördel", () => {
    const obs = [];
    for (let i = 0; i < 20; i++) {
      // Lag 1 vinner 70 % som CT och 55 % som T mot lag 2 och 3.
      for (const opp of [2, 3]) {
        obs.push({ map: "nuke", ctTeam: 1, tTeam: opp, ctWins: 7, rounds: 10, w: 1 });
        obs.push({ map: "nuke", ctTeam: opp, tTeam: 1, ctWins: 9, rounds: 20, w: 1 });
      }
      obs.push({ map: "nuke", ctTeam: 2, tTeam: 3, ctWins: 6, rounds: 10, w: 1 });
      obs.push({ map: "nuke", ctTeam: 3, tTeam: 2, ctWins: 6, rounds: 10, w: 1 });
    }
    const pistols = Array.from({ length: 40 }, (_, i) => ({ ctTeam: 1, tTeam: 2, ctWon: i % 4 !== 0, w: 1 }));
    const model = fitRatings(obs, pistols, { conv2: 0.8, conv3: 0.7 });
    expect(roundWinProb(model, "nuke", 1, 2)).toBeGreaterThan(roundWinProb(model, "nuke", 2, 1));
    expect(roundWinProb(model, "nuke", 1, 2)).toBeGreaterThan(0.6);
    // Okänt lag och okänd karta faller tillbaka mot neutralt.
    expect(roundWinProb(model, "inferno", 9, 8)).toBeCloseTo(0.5, 5);
    expect(pistolWinProb(model, 1, 2)).toBeGreaterThan(0.55);
  });
});

describe("ratings återskapar en känd liga", () => {
  it("hittar sanna rundsannolikheter inom några procentenheter", () => {
    const sig = (x: number) => 1 / (1 + Math.exp(-x));
    const ctTrue: Record<number, number> = { 1: 0.4, 2: 0.2, 3: 0, 4: -0.1, 5: -0.2, 6: -0.3 };
    const tTrue: Record<number, number> = { 1: 0.3, 2: 0.1, 3: 0.1, 4: 0, 5: -0.2, 6: -0.3 };
    const mu = 0.15;
    const obs = [];
    for (let rep = 0; rep < 10; rep++)
      for (let a = 1; a <= 6; a++)
        for (let b = 1; b <= 6; b++) {
          if (a === b) continue;
          const p = sig(mu + ctTrue[a] - tTrue[b]);
          obs.push({ map: "mirage", ctTeam: a, tTeam: b, ctWins: Math.round(12 * p * 10) / 10, rounds: 12, w: 1 });
        }
    const model = fitRatings(obs, [], { conv2: 0.8, conv3: 0.7 });
    let worst = 0;
    for (let a = 1; a <= 6; a++)
      for (let b = 1; b <= 6; b++) {
        if (a === b) continue;
        worst = Math.max(worst, Math.abs(roundWinProb(model, "mirage", a, b) - sig(mu + ctTrue[a] - tTrue[b])));
      }
    // Krympningen drar något mot mitten — men inte mer än några procent.
    expect(worst).toBeLessThan(0.04);
  });

  it("pistolanpassningen konvergerar mot rätt håll", () => {
    const pistols = Array.from({ length: 200 }, (_, i) => ({ ctTeam: 1, tTeam: 2, ctWon: i % 4 !== 0, w: 1 }));
    const model = fitRatings([], pistols, { conv2: 0.8, conv3: 0.7 });
    const p = pistolWinProb(model, 1, 2);
    expect(p).toBeGreaterThan(0.65);
    expect(p).toBeLessThan(0.78);
  });
});

describe("kartmodellen", () => {
  const d = mapDistribution(even);
  it("summerar till 1 och har bara giltiga slutställningar", () => {
    expect(d.outcomes.reduce((a, o) => a + o.p, 0)).toBeCloseTo(1, 9);
    for (const o of d.outcomes) {
      const reg = o.aReg === 13 || o.bReg === 13;
      const ot = o.aReg === 12 && o.bReg === 12 && Math.abs(o.aOt - o.bOt) >= 1;
      expect(reg || ot).toBe(true);
      if (reg) expect(o.aOt + o.bOt).toBe(0);
    }
    expect(moments(d.roundsPmf).sum).toBeCloseTo(1, 9);
  });

  it("jämna lag: 50 %, rimligt antal rundor och övertid", () => {
    expect(d.pAWin).toBeCloseTo(0.5, 6);
    expect(d.expRounds).toBeGreaterThan(20);
    expect(d.expRounds).toBeLessThan(24);
    expect(d.pOt).toBeGreaterThan(0.06);
    expect(d.pOt).toBeLessThan(0.25);
    const h = handicapProbs(d, -1.5);
    const h2 = handicapProbs(flipDistribution(d), -1.5);
    expect(h.pCover).toBeCloseTo(h2.pCover, 6);
  });

  it("starkt lag vinner oftare och kartan blir kortare", () => {
    const strong = mapDistribution({ ...even, pCtA: 0.66, pCtB: 0.42 });
    expect(strong.pAWin).toBeGreaterThan(0.75);
    expect(strong.expRounds).toBeLessThan(d.expRounds);
  });

  it("formeffekten breddar fördelningen", () => {
    const narrow = mapDistribution({ ...even, sigma: 0 });
    const wide = mapDistribution({ ...even, sigma: 0.6 });
    const margin = (dist: typeof d) => {
      let v = 0;
      for (const o of dist.outcomes) v += o.p * Math.pow(o.aReg + o.aOt - o.bReg - o.bOt, 2);
      return v;
    };
    expect(margin(wide)).toBeGreaterThan(margin(narrow));
  });

  it("rundor utan övertid stannar på 24", () => {
    const pmf = roundsPmf(d, false);
    expect(pmf.length).toBe(25);
    expect(moments(pmf).sum).toBeCloseTo(1, 9);
  });
});

describe("veto och serie", () => {
  const pool = ["ancient", "anubis", "dust2", "inferno", "mirage", "nuke", "train"];
  it("följer formatens vetoordning", () => {
    expect(vetoSequence("bo3", 7).map((s) => s.action)).toEqual(["ban", "ban", "pick", "pick", "ban", "ban", "decider"]);
    expect(vetoSequence("bo1", 7).filter((s) => s.action === "ban")).toHaveLength(6);
    expect(vetoSequence("bo5", 7).filter((s) => s.action === "pick")).toHaveLength(4);
  });

  it("permaban spelas nästan aldrig och favoritpick ofta", () => {
    const now = new Date("2026-10-01");
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push({ teamId: 1, action: "ban", mapName: "anubis", at: now });
      rows.push({ teamId: 1, action: "pick", mapName: "nuke", at: now });
      rows.push({ teamId: 2, action: "ban", mapName: "train", at: now });
    }
    const v = vetoDistribution("bo3", pool, vetoProfile(rows, 1, pool, now), vetoProfile(rows, 2, pool, now));
    expect(v.paths.reduce((a, p) => a + p.p, 0)).toBeCloseTo(1, 9);
    const played = (m: string) => v.marginal[m].p1 + v.marginal[m].p2 + v.marginal[m].p3;
    expect(played("anubis")).toBeLessThan(0.1);
    expect(played("nuke")).toBeGreaterThan(0.6);
    expect(Object.values(v.marginal).reduce((a, x) => a + x.p1, 0)).toBeCloseTo(1, 9);
  });

  it("serien ur kartorna", () => {
    const v = knownVeto(["nuke", "mirage", "inferno"], pool);
    const s = seriesProbs("bo3", v, () => 0.5);
    expect(s.pA).toBeCloseTo(0.5);
    expect(s.scores["2,0"]).toBeCloseTo(0.25);
    expect(s.pMapPlayed[2]).toBeCloseTo(0.5);
    const sure = seriesProbs("bo3", v, () => 1);
    expect(sure.pA).toBe(1);
    expect(sure.pMapPlayed[2]).toBe(0);
  });
});

describe("kills och headshots", () => {
  it("krymper mot ligan utan data och mot observerat med mycket data", () => {
    const none = killRates({ demo: {}, hltv: {} }, DEFAULT_LEAGUE_PRIOR, ["nuke"]);
    expect(none.nuke.kw).toBeCloseTo(DEFAULT_LEAGUE_PRIOR.kw);
    const lots = killRates(
      { demo: { nuke: { killsWon: 1100, killsLost: 300, roundsWon: 1000, rounds: 1600, headshots: 600, kills: 1400 } }, hltv: {} },
      DEFAULT_LEAGUE_PRIOR,
      ["nuke"]
    );
    expect(lots.nuke.kw).toBeCloseTo(1.1, 1);
    expect(lots.nuke.kl).toBeCloseTo(0.5, 1);
    // Bara HLTV: kills delas upp med ligans kvot.
    const hl = killRates({ demo: {}, hltv: { nuke: { kills: 900, headshots: null, roundsWon: 500, roundsLost: 500 } } }, DEFAULT_LEAGUE_PRIOR, ["nuke"]);
    expect(hl.nuke.kw / hl.nuke.kl).toBeGreaterThan(1.5);
  });

  it("kill-fördelningens medel följer rundorna", () => {
    const d = mapDistribution(even);
    const rates = { kw: 0.9, kl: 0.4, hs: 0.5, rounds: 100 };
    const pmf = killPmfForMap(rates, d, true);
    const expected = d.outcomes.reduce((a, o) => a + o.p * ((o.aReg + o.aOt) * 0.9 + (o.bReg + o.bOt) * 0.4), 0);
    expect(moments(pmf).sum).toBeCloseTo(1, 5);
    expect(pmfMean(pmf)).toBeCloseTo(expected, 3);
    expect(pmfMean(headshotPmf(pmf, 0.5))).toBeCloseTo(expected * 0.5, 3);
  });

  it("karta 1–2 är summan av kartorna", () => {
    const d = mapDistribution(even);
    const v = knownVeto(["nuke", "mirage", "inferno"], ["nuke", "mirage", "inferno"]);
    const perMap = () => killPmfForMap({ kw: 0.9, kl: 0.4, hs: 0.5, rounds: 1 }, d, true);
    const one = pmfMean(perMap());
    expect(pmfMean(seriesPmf("maps12", v, perMap).pmf)).toBeCloseTo(2 * one, 3);
    const s3 = seriesPmf("map3", v, perMap, [1, 1, 0.4]);
    expect(s3.pPlayed).toBe(0.4);
    expect(pmfMean(seriesPmf("match", v, perMap, [1, 1, 0.5], 140, () => 0.5).pmf)).toBeCloseTo(2.5 * one, 2);
  });

  it("fair line ligger vid medianen", () => {
    const pmf = [0, 0.1, 0.2, 0.4, 0.2, 0.1];
    expect(medianLine(pmf)).toBe(2.5);
  });
});

describe("öppningar och prissättning", () => {
  it("log5 och första kill", () => {
    expect(log5(0.5, 0.5)).toBeCloseTo(0.5);
    expect(log5(0.6, 0.5)).toBeCloseTo(0.6);
    const strong = openingRates(Array(200).fill({ side: "ct", firstKillBy: "own" }), [
      { key: "1", side: "ct", openingKills: 30 },
      { key: "2", side: "ct", openingKills: 10 },
    ]);
    const neutral = openingRates([], []);
    expect(firstKillProb(strong, neutral, 1)).toBeGreaterThan(0.75);
    expect(playerFirstKillProb(strong, neutral, "1", 1)).toBeGreaterThan(playerFirstKillProb(strong, neutral, "2", 1));
  });

  it("spelarens andel summeras över kartrader", () => {
    const rows = [1, 2, 3, 4, 5].flatMap((k) =>
      Array.from({ length: 10 }, () => ({ key: String(k), side: "ct" as const, openingKills: k === 1 ? 4 : 1.5 }))
    );
    const o = openingRates([], rows);
    // Spelare 1 står för 40 av 100 öppningskills.
    expect(o.players["1"].ct).toBeCloseTo((40 + 10 * 0.2) / (100 + 10), 6);
    const total = ["1", "2", "3", "4", "5"].reduce((a, k) => a + o.players[k].ct, 0);
    expect(total).toBeGreaterThan(0.9);
  });

  it("edge, fair odds och push", () => {
    const p = priceTwoWay(0.6, 0, 2.0, null, 1);
    expect(p.fairOver).toBeCloseTo(1 / 0.6);
    expect(p.edgeOver).toBeCloseTo(0.2);
    expect(p.bestSide).toBe("over");
    // Bokens två sidor avviggas och vägs in.
    const b = priceTwoWay(0.6, 0, 1.9, 1.9, 0.5);
    expect(b.pMarket).toBeCloseTo(0.5);
    expect(b.pFinal).toBeCloseTo(0.55);
    // Push: insatsen tillbaka.
    const push = priceTwoWay(0.5, 0.2, 2.0, 2.0, 1);
    expect(push.edgeOver).toBeCloseTo(2 * 0.5 * 0.8 + 0.2 - 1);
  });
});

describe("angles", () => {
  it("lyfter kartspecifik KPR och lägger edge först", () => {
    const a = buildAngles({
      players: [
        {
          playerId: 7,
          nickname: "ZywOo",
          teamId: 1,
          teamName: "Vitality",
          kprByMap: { nuke: { kpr: 1.0, maps: 8 } },
          kprAll: 0.8,
          mapsAll: 30,
          mapsForTeam: 30,
          awpRounds: 0,
          awpEarlyKills: 0,
          openingShare: null,
          openingRounds: 0,
        },
      ],
      maps: [{ mapName: "nuke", label: "Nuke", pIn12: 0.7, expRounds: 21.5, pOt: 0.1 }],
      teams: [],
      pTeam1: 0.6,
      team1Name: "Vitality",
      team2Name: "FaZe",
      leagueRounds: 21.5,
      pricedLines: [{ label: "ZywOo kills", edge: 0.08, bestSide: "over", market: "kills", playerId: 7 }],
    });
    expect(a[0].kind).toBe("edge");
    expect(a.some((x) => x.kind === "map_kpr" && x.playerId === 7)).toBe(true);
  });
});

describe("matchup utan databas", () => {
  const pool = ["nuke", "mirage", "inferno"];
  const dists = Object.fromEntries(pool.map((m) => [m, mapDistribution({ ...even, pCtA: 0.58, pCtB: 0.48 })]));
  const veto = knownVeto(pool, pool);
  const series = seriesProbs("bo3", veto, (m) => dists[m].pAWin);
  const rates = killRates({ demo: {}, hltv: {} }, DEFAULT_LEAGUE_PRIOR, pool);
  const neutral = openingRates([], []);
  const ctx: MatchupContext = {
    match: { id: 1, startAt: new Date("2026-10-10T18:00:00Z"), status: "scheduled", eventName: "Test", lan: true },
    team1: { id: 10, name: "Alpha", rank: 1 },
    team2: { id: 20, name: "Beta", rank: 9 },
    format: "bo3",
    pool,
    veto,
    vetoKnown: true,
    dists,
    series,
    pistolCt1: 0.55,
    pistolCt2: 0.5,
    opening: { team1: neutral, team2: neutral },
    players: [10, 20].flatMap((teamId, ti) =>
      [1, 2, 3, 4, 5].map((n) => ({
        playerId: teamId * 10 + n,
        nickname: `p${teamId * 10 + n}`,
        teamId,
        side: (ti === 0 ? 1 : 2) as 1 | 2,
        role: null,
        rates,
        kprByMap: {},
        kprAll: 0.7,
        mapsAll: 20,
        mapsForTeam: 20,
        demoMaps: 0,
        awpRounds: 0,
        awpEarlyKills: 0,
        openingShare: null,
        openingRounds: 0,
      }))
    ),
    global: {
      ratings: { mapBias: {}, ct: {}, t: {}, pistolBias: 0, pistol: {}, conv2: 0.8, conv3: 0.7, rounds: {} },
      league: DEFAULT_LEAGUE_PRIOR,
      leagueRounds: 21.5,
      trainedMaps: 100,
      key: "x",
      at: 0,
    },
    teamAngles: [],
    warnings: [],
  };

  it("lagens sannolikheter är komplement", () => {
    const a = modelProb(ctx, { market: "match_winner", scope: "match", teamId: 10 })!;
    const b = modelProb(ctx, { market: "match_winner", scope: "match", teamId: 20 })!;
    expect(a.p + b.p).toBeCloseTo(1, 9);
    expect(a.p).toBeGreaterThan(0.5);
    const maps = modelProb(ctx, { market: "total_maps", scope: "match", line: 2.5 })!;
    expect(maps.p).toBeCloseTo(series.pMapPlayed[2], 9);
    const h = modelProb(ctx, { market: "match_handicap", scope: "match", teamId: 10, line: -1.5 })!;
    expect(h.p).toBeCloseTo(series.scores["2,0"], 9);
  });

  it("prissätter spelarlinjer och bygger vyn", () => {
    const priced = priceLine(ctx, { market: "kills", scope: "maps12", playerId: 101, line: 30.5, overOdds: 1.85, underOdds: 1.85 });
    expect(priced.label).toContain("p101");
    expect(priced.mean).toBeGreaterThan(25);
    expect(priced.price?.pModel).toBeGreaterThan(0);
    const view = buildMatchupView(ctx, [{ market: "kills", scope: "maps12", playerId: 101, line: 30.5, overOdds: 1.85, underOdds: 1.85 }]);
    expect(view.players).toHaveLength(10);
    expect(view.players[0].kills12?.line).toBeGreaterThan(20);
    expect(view.maps).toHaveLength(3);
    expect(view.series.pMap3).toBeCloseTo(series.pMapPlayed[2]);
    expect(view.lines[0].price).not.toBeNull();
  });
});
