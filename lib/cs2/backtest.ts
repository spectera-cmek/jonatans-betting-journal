// Walk-forward-backtest av CS2-modellen: varje karta prissätts bara med data
// som fanns före den, och jämförs sedan med facit.
//
// Mäter tre saker, alla med kartan känd (vetot testas inte här — det är en
// separat osäkerhet):
//   - kartvinnare: log-loss och Brier mot myntkast (0,5)
//   - totala rundor: P(över 21,5) mot utfall, och väntevärdets fel
//   - spelarkills: P(över modellens egen fair line) mot utfall — en
//     kalibrerad modell träffar ~50 % — plus skattad dispersion φ
// Kills räknas som i matchup.ts: sex månaders historik med halveringstid,
// normerad för motståndet och skalad efter kommande motståndare, demofakta
// där de finns och ligans nivå ur demos. Den gamla förenklade varianten
// (all historik, ovägd, bara HLTV) mäts bredvid som `killsSimple`.
// Resultatet sparas i Cs2BacktestRun och visas i facit-panelen.

import { lineProbs } from "../shotModel";
import type { PlayerSideFacts } from "./demo/types";
import {
  DEFAULT_KILL_PHI,
  DEFAULT_LEAGUE_PRIOR,
  demoHistory,
  killHistory,
  killPmfForMap,
  killRates,
  leaguePriorFromFacts,
  medianLine,
  pmfMean,
  teamConcession,
  vsOpponent,
  type LeagueKillPrior,
} from "./killModel";
import { flipDistribution, mapDistribution, DEFAULT_SIGMA, type MapDistribution } from "./mapModel";
import {
  conversionRates,
  fitRatings,
  lineupsFromPlayers,
  DEFAULT_TAU_PLAYER,
  DEFAULT_TAU_TEAM_WITH_PLAYERS,
  pistolObsFromMap,
  pistolWinProb,
  roundWinProb,
  sideObsFromMap,
  timeWeight,
  type RatingModel,
  type RatingOptions,
} from "./ratings";

export interface BacktestMap {
  id: number;
  mapName: string;
  playedAt: Date;
  team1Id: number;
  team2Id: number;
  team1Rounds: number;
  team2Rounds: number;
  team1CtRounds: number | null;
  team1TRounds: number | null;
  team2CtRounds: number | null;
  team2TRounds: number | null;
  roundHistory: unknown;
  players: Array<{ playerId: number; teamId: number; kills: number; headshots: number | null }>;
  /** Demofakta per spelare och sida (Cs2DemoPlayerMap). Saknas för kartor utan tolkad demo. */
  demoPlayers?: Array<{ playerId: number | null; teamId: number | null; facts: unknown }>;
}

/** Historikfönstret för kill-raterna, som i matchup.ts. */
const KILL_WINDOW_MS = 6 * 30 * 86_400_000;
/** Lika många demorader som matchup.ts tar till ligans nivå. */
const LEAGUE_DEMO_ROWS = 3000;

export interface CalibrationBucket {
  from: number;
  to: number;
  n: number;
  predicted: number;
  observed: number;
}

export interface BacktestSummary {
  maps: number;
  from: string | null;
  to: string | null;
  mapWinner: { n: number; logLoss: number; brier: number; baselineLogLoss: number; accuracy: number; calibration: CalibrationBucket[] };
  rounds: { n: number; meanError: number; mae: number; overLine: number; logLoss: number; calibration: CalibrationBucket[] };
  kills: {
    n: number;
    meanError: number;
    mae: number;
    overRate: number;
    logLoss: number;
    /** Medel av −log P(faktiskt antal kills) — mäter hela fördelningen, inte bara mitten. Lägre = bättre. */
    logScore: number;
    /** Det φ i PHI_GRID som gav bäst log-score (null vid för få spelare). */
    phi: number | null;
    calibration: CalibrationBucket[];
  };
  /** Den förenklade kills-modellen på samma spelare-kartor, för jämförelse. Saknas i äldre körningar. */
  killsSimple?: { n: number; meanError: number; mae: number; overRate: number; logScore: number };
  notes: string[];
}

const clamp = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const ll = (p: number, y: number) => -(y * Math.log(clamp(p)) + (1 - y) * Math.log(clamp(1 - p)));

export function calibrationBuckets(samples: Array<{ p: number; y: number }>, buckets = 10): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    const from = i / buckets;
    const to = (i + 1) / buckets;
    const s = samples.filter((x) => x.p >= from && (i === buckets - 1 ? x.p <= to : x.p < to));
    if (s.length === 0) continue;
    out.push({
      from,
      to,
      n: s.length,
      predicted: s.reduce((a, x) => a + x.p, 0) / s.length,
      observed: s.reduce((a, x) => a + x.y, 0) / s.length,
    });
  }
  return out;
}

/** φ-kandidater för kills-modellen. Bäst log-score vinner. */
export const PHI_GRID = [15, 25, 40, 60, 100] as const;

export interface BacktestOptions {
  /** Hur ofta ratings anpassas om (dagar). */
  refitDays?: number;
  /** Kartor att värma upp på innan något mäts. */
  warmupMaps?: number;
  roundsLine?: number;
  league?: LeagueKillPrior;
  phi?: number;
  sigma?: number;
  /** Skickas vidare till fitRatings (rundspridning, lag 1-fördel …). */
  rating?: RatingOptions;
}

export function runBacktest(mapsIn: BacktestMap[], opts: BacktestOptions = {}): BacktestSummary {
  const refitMs = (opts.refitDays ?? 7) * 86_400_000;
  const warmup = opts.warmupMaps ?? 150;
  const roundsLine = opts.roundsLine ?? 21.5;
  const simpleLeague = opts.league ?? DEFAULT_LEAGUE_PRIOR;
  const phi = opts.phi ?? DEFAULT_KILL_PHI;
  const sigma = opts.sigma ?? DEFAULT_SIGMA;
  const maps = [...mapsIn].sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime());

  const winS: Array<{ p: number; y: number }> = [];
  const roundS: Array<{ p: number; y: number }> = [];
  const roundErr: number[] = [];
  const killS: Array<{ p: number; y: number }> = [];
  const killErr: number[] = [];
  const killScore: number[] = [];
  const simpleS: Array<{ p: number; y: number }> = [];
  const simpleErr: number[] = [];
  const simpleScore: number[] = [];
  // −log P(faktiskt antal) per φ-kandidat. φ skattas på hela fördelningen:
  // ett momentmått mot medelvärdet tar osäkerheten i rundor och kartutfall
  // (som modellen redan blandar in) för extra spridning och blir för lågt.
  const phiScore = new Map<number, number>(PHI_GRID.map((f) => [f, 0]));

  // Löpande HLTV-summor per spelare och karta (bara data före aktuell karta) — den förenklade modellen.
  const acc = new Map<number, Record<string, { kills: number; headshots: number | null; roundsWon: number; roundsLost: number }>>();
  // Spelarens kartor med datum och motståndare — appens kills-modell.
  const hist = new Map<number, Array<{ playedAt: Date; mapName: string; kills: number; headshots: number | null; won: number; lost: number; opp: number }>>();
  const demoHist = new Map<number, Array<{ playedAt: Date; mapName: string; opp: number; facts: PlayerSideFacts }>>();

  let model: RatingModel | null = null;
  let fittedAt = -Infinity;
  let concession: Record<number, number> = {};
  let league: LeagueKillPrior = simpleLeague;
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    const t = m.playedAt.getTime();
    if (i >= warmup) {
      if (!model || t - fittedAt >= refitMs) {
        const past = maps.slice(0, i);
        model = fitRatings(
          past.flatMap((x) => sideObsFromMap(x, timeWeight(x.playedAt, m.playedAt), lineupsFromPlayers(x.players))),
          past.flatMap((x) => pistolObsFromMap(x, timeWeight(x.playedAt, m.playedAt))),
          conversionRates(past.map((x) => x.roundHistory)),
          { iterations: 40, tauPlayer: DEFAULT_TAU_PLAYER, tauTeam: DEFAULT_TAU_TEAM_WITH_PLAYERS, ...opts.rating }
        );
        // Släppta kills och ligans nivå som i matchup.ts, ur de senaste sex månaderna före kartan.
        const recent = past.filter((x) => t - x.playedAt.getTime() <= KILL_WINDOW_MS);
        concession = teamConcession(
          recent.map((x) => ({
            team1Id: x.team1Id,
            team2Id: x.team2Id,
            rounds: x.team1Rounds + x.team2Rounds,
            kills1: x.players.filter((p) => p.teamId === x.team1Id).reduce((a, p) => a + p.kills, 0),
            kills2: x.players.filter((p) => p.teamId === x.team2Id).reduce((a, p) => a + p.kills, 0),
          }))
        ).byTeam;
        if (!opts.league) {
          const facts: PlayerSideFacts[] = [];
          for (let j = recent.length - 1; j >= 0 && facts.length < LEAGUE_DEMO_ROWS; j--) {
            for (const d of recent[j].demoPlayers ?? []) facts.push(d.facts as PlayerSideFacts);
          }
          league = leaguePriorFromFacts(facts);
        }
        fittedAt = t;
      }
      const dist: MapDistribution = mapDistribution({
        pCtA: roundWinProb(model, m.mapName, m.team1Id, m.team2Id, m.team1Id, 1, lineupsFromPlayers(m.players)),
        pCtB: roundWinProb(model, m.mapName, m.team2Id, m.team1Id, m.team1Id, 1, lineupsFromPlayers(m.players)),
        pistolCtA: pistolWinProb(model, m.team1Id, m.team2Id),
        pistolCtB: pistolWinProb(model, m.team2Id, m.team1Id),
        conv2: model.conv2,
        conv3: model.conv3,
        pAStartsCt: 0.5,
        sigma,
      });
      winS.push({ p: dist.pAWin, y: m.team1Rounds > m.team2Rounds ? 1 : 0 });
      const total = m.team1Rounds + m.team2Rounds;
      roundS.push({ p: lineProbs(dist.roundsPmf, roundsLine).pOverNoPush, y: total > roundsLine ? 1 : 0 });
      roundErr.push(dist.expRounds - total);

      for (const p of m.players) {
        const rows = (hist.get(p.playerId) ?? []).filter((r) => t - r.playedAt.getTime() <= KILL_WINDOW_MS);
        if (rows.length === 0) continue; // ingen historik i fönstret — mäts inte
        const d = p.teamId === m.team1Id ? dist : flipDistribution(dist);
        const demo = demoHistory((demoHist.get(p.playerId) ?? []).filter((r) => t - r.playedAt.getTime() <= KILL_WINDOW_MS), m.playedAt, concession);
        const opp = p.teamId === m.team1Id ? m.team2Id : m.team1Id;
        const rates = vsOpponent(killRates({ demo, hltv: killHistory(rows, m.playedAt, concession) }, league, [m.mapName]), concession[opp] ?? 1);
        const pmf = killPmfForMap(rates[m.mapName] ?? rates.all, d, true, phi);
        const line = medianLine(pmf);
        killS.push({ p: lineProbs(pmf, line).pOverNoPush, y: p.kills > line ? 1 : 0 });
        killErr.push(pmfMean(pmf) - p.kills);
        killScore.push(-Math.log(Math.max(pmf[p.kills] ?? 0, 1e-12)));
        for (const f of PHI_GRID) {
          const alt = f === phi ? pmf : killPmfForMap(rates[m.mapName] ?? rates.all, d, true, f);
          phiScore.set(f, phiScore.get(f)! - Math.log(Math.max(alt[p.kills] ?? 0, 1e-12)));
        }

        // Samma spelare-karta med den förenklade modellen, för jämförelse.
        const simple = killRates({ demo: {}, hltv: acc.get(p.playerId) ?? {} }, simpleLeague, [m.mapName]);
        const sPmf = killPmfForMap(simple[m.mapName] ?? simple.all, d, true, phi);
        const sLine = medianLine(sPmf);
        simpleS.push({ p: lineProbs(sPmf, sLine).pOverNoPush, y: p.kills > sLine ? 1 : 0 });
        simpleErr.push(pmfMean(sPmf) - p.kills);
        simpleScore.push(-Math.log(Math.max(sPmf[p.kills] ?? 0, 1e-12)));
      }
    }
    // Lägg till kartan i historiken först efter att den prissatts.
    for (const p of m.players) {
      const won = p.teamId === m.team1Id ? m.team1Rounds : m.team2Rounds;
      const opp = p.teamId === m.team1Id ? m.team2Id : m.team1Id;
      const rows = hist.get(p.playerId) ?? [];
      rows.push({ playedAt: m.playedAt, mapName: m.mapName, kills: p.kills, headshots: p.headshots, won, lost: m.team1Rounds + m.team2Rounds - won, opp });
      hist.set(p.playerId, rows);
    }
    for (const dp of m.demoPlayers ?? []) {
      if (dp.playerId == null) continue;
      const teamId = dp.teamId ?? m.players.find((p) => p.playerId === dp.playerId)?.teamId;
      if (teamId == null) continue;
      const rows = demoHist.get(dp.playerId) ?? [];
      rows.push({ playedAt: m.playedAt, mapName: m.mapName, opp: teamId === m.team1Id ? m.team2Id : m.team1Id, facts: dp.facts as PlayerSideFacts });
      demoHist.set(dp.playerId, rows);
    }
    for (const p of m.players) {
      const rec = acc.get(p.playerId) ?? {};
      const e = (rec[m.mapName] ??= { kills: 0, headshots: 0, roundsWon: 0, roundsLost: 0 });
      e.kills += p.kills;
      e.headshots = e.headshots != null && p.headshots != null ? e.headshots + p.headshots : null;
      const won = p.teamId === m.team1Id ? m.team1Rounds : m.team2Rounds;
      e.roundsWon += won;
      e.roundsLost += m.team1Rounds + m.team2Rounds - won;
      acc.set(p.playerId, rec);
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const notes: string[] = [];
  if (maps.length < warmup + 50) notes.push(`Bara ${Math.max(0, maps.length - warmup)} kartor efter uppvärmningen — för lite för säkra slutsatser.`);
  let phiHat: number | null = null;
  if (killS.length > 100) {
    let best = Infinity;
    for (const [f, score] of phiScore) if (score < best) [best, phiHat] = [score, f];
  }
  const winLL = mean(winS.map((s) => ll(s.p, s.y)));
  if (winS.length > 50 && winLL >= Math.log(2)) notes.push("Kartvinnarmodellen slår inte myntkast på log-loss — lita inte på karthandikapp och matchvinnare.");

  return {
    maps: winS.length,
    from: maps[warmup]?.playedAt.toISOString() ?? null,
    to: maps.length ? maps[maps.length - 1].playedAt.toISOString() : null,
    mapWinner: {
      n: winS.length,
      logLoss: winLL,
      brier: mean(winS.map((s) => (s.p - s.y) ** 2)),
      baselineLogLoss: Math.log(2),
      accuracy: mean(winS.map((s) => ((s.p >= 0.5 ? 1 : 0) === s.y ? 1 : 0))),
      calibration: calibrationBuckets(winS),
    },
    rounds: {
      n: roundS.length,
      meanError: mean(roundErr),
      mae: mean(roundErr.map(Math.abs)),
      overLine: roundsLine,
      logLoss: mean(roundS.map((s) => ll(s.p, s.y))),
      calibration: calibrationBuckets(roundS),
    },
    kills: {
      n: killS.length,
      meanError: mean(killErr),
      mae: mean(killErr.map(Math.abs)),
      overRate: mean(killS.map((s) => s.y)),
      logLoss: mean(killS.map((s) => ll(s.p, s.y))),
      logScore: mean(killScore),
      phi: phiHat,
      calibration: calibrationBuckets(killS),
    },
    killsSimple: {
      n: simpleS.length,
      meanError: mean(simpleErr),
      mae: mean(simpleErr.map(Math.abs)),
      overRate: mean(simpleS.map((s) => s.y)),
      logScore: mean(simpleScore),
    },
    notes,
  };
}
