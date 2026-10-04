// Walk-forward-backtest av CS2-modellen: varje karta prissätts bara med data
// som fanns före den, och jämförs sedan med facit.
//
// Mäter tre saker, alla med kartan känd (vetot testas inte här — det är en
// separat osäkerhet):
//   - kartvinnare: log-loss och Brier mot myntkast (0,5)
//   - totala rundor: P(över 21,5) mot utfall, och väntevärdets fel
//   - spelarkills: P(över modellens egen fair line) mot utfall — en
//     kalibrerad modell träffar ~50 % — plus skattad dispersion φ
// Resultatet sparas i Cs2BacktestRun och visas i facit-panelen.

import { lineProbs } from "../shotModel";
import { DEFAULT_KILL_PHI, DEFAULT_LEAGUE_PRIOR, killPmfForMap, killRates, medianLine, pmfMean, type LeagueKillPrior } from "./killModel";
import { flipDistribution, mapDistribution, DEFAULT_SIGMA, type MapDistribution } from "./mapModel";
import {
  conversionRates,
  fitRatings,
  pistolObsFromMap,
  pistolWinProb,
  roundWinProb,
  sideObsFromMap,
  timeWeight,
  type RatingModel,
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
}

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
}

export function runBacktest(mapsIn: BacktestMap[], opts: BacktestOptions = {}): BacktestSummary {
  const refitMs = (opts.refitDays ?? 7) * 86_400_000;
  const warmup = opts.warmupMaps ?? 150;
  const roundsLine = opts.roundsLine ?? 21.5;
  const league = opts.league ?? DEFAULT_LEAGUE_PRIOR;
  const phi = opts.phi ?? DEFAULT_KILL_PHI;
  const sigma = opts.sigma ?? DEFAULT_SIGMA;
  const maps = [...mapsIn].sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime());

  const winS: Array<{ p: number; y: number }> = [];
  const roundS: Array<{ p: number; y: number }> = [];
  const roundErr: number[] = [];
  const killS: Array<{ p: number; y: number }> = [];
  const killErr: number[] = [];
  const killScore: number[] = [];
  // −log P(faktiskt antal) per φ-kandidat. φ skattas på hela fördelningen:
  // ett momentmått mot medelvärdet tar osäkerheten i rundor och kartutfall
  // (som modellen redan blandar in) för extra spridning och blir för lågt.
  const phiScore = new Map<number, number>(PHI_GRID.map((f) => [f, 0]));

  // Löpande HLTV-summor per spelare och karta (bara data före aktuell karta).
  const acc = new Map<number, Record<string, { kills: number; headshots: number | null; roundsWon: number; roundsLost: number }>>();

  let model: RatingModel | null = null;
  let fittedAt = -Infinity;
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    const t = m.playedAt.getTime();
    if (i >= warmup) {
      if (!model || t - fittedAt >= refitMs) {
        const past = maps.slice(0, i);
        model = fitRatings(
          past.flatMap((x) => sideObsFromMap(x, timeWeight(x.playedAt, m.playedAt))),
          past.flatMap((x) => pistolObsFromMap(x, timeWeight(x.playedAt, m.playedAt))),
          conversionRates(past.map((x) => x.roundHistory)),
          { iterations: 40 }
        );
        fittedAt = t;
      }
      const dist: MapDistribution = mapDistribution({
        pCtA: roundWinProb(model, m.mapName, m.team1Id, m.team2Id),
        pCtB: roundWinProb(model, m.mapName, m.team2Id, m.team1Id),
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
        const hist = acc.get(p.playerId);
        if (!hist) continue; // ingen historik — mäts inte
        const rates = killRates({ demo: {}, hltv: hist }, league, [m.mapName]);
        const d = p.teamId === m.team1Id ? dist : flipDistribution(dist);
        const pmf = killPmfForMap(rates[m.mapName] ?? rates.all, d, true, phi);
        const line = medianLine(pmf);
        const mean = pmfMean(pmf);
        killS.push({ p: lineProbs(pmf, line).pOverNoPush, y: p.kills > line ? 1 : 0 });
        killErr.push(mean - p.kills);
        killScore.push(-Math.log(Math.max(pmf[p.kills] ?? 0, 1e-12)));
        for (const f of PHI_GRID) {
          const alt = f === phi ? pmf : killPmfForMap(rates[m.mapName] ?? rates.all, d, true, f);
          phiScore.set(f, phiScore.get(f)! - Math.log(Math.max(alt[p.kills] ?? 0, 1e-12)));
        }
      }
    }
    // Lägg till kartan i historiken först efter att den prissatts.
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
    notes,
  };
}
