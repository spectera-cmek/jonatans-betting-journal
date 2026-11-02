// Backtest för props mot riktiga boxscores (det finns inga historiska
// prop-linjer att jämföra mot). Varje spelare projiceras med data före
// matchen och jämförs med:
//   - naiv projektion: spelarens snitt de senaste 10 matcherna (ungefär det en
//     slarvig linje bygger på)
//   - en låtsaslinje = naiva snittet avrundat till ,5 — log loss för modellens
//     P(över) mot andelen av de 10 senaste matcherna över samma linje
//   - täckning: hur ofta utfallet hamnar mellan modellens 10:e och 90:e
//     percentil (ska vara ~80 %)

import { baselineMinutes, projectMinutes } from "./minutes";
import { DEFAULT_NBA_PARAMS, type NbaModelParams } from "./params";
import { DEFAULT_PROP_PARAMS, PROP_STATS, overProb, simulatePlayer, summarizeSamples, type PropParams, type PropStat } from "./props";
import { firstBefore, leagueAverages, playerRates, type History, type League, type PlayerGameRow } from "./ratings";
import { propEnv } from "./propEnv";
import { fitTeamRatings, type RatingTable } from "./teamRatings";
import type { BacktestGame } from "./backtest";

export interface PropStatMetrics {
  n: number;
  maeModel: number;
  maeNaive: number;
  biasModel: number;
  /** Andel utfall mellan 10:e och 90:e percentilen. */
  coverage80: number;
  logLossModel: number;
  logLossNaive: number;
}

const statOf = (stat: PropStat, r: PlayerGameRow): number => {
  const pts = 2 * r.fgm2 + 3 * r.fgm3 + r.ftm;
  const reb = r.oreb + (r.dreb ?? 0);
  const ast = r.ast ?? 0;
  return stat === "pts" ? pts : stat === "reb" ? reb : stat === "ast" ? ast : stat === "fg3" ? r.fgm3 : pts + reb + ast;
};

const ll = (p: number, y: number) => -(y * Math.log(Math.max(1e-4, p)) + (1 - y) * Math.log(Math.max(1e-4, 1 - p)));

export function runPropsBacktest(
  h: History,
  games: BacktestGame[],
  opts: { params?: NbaModelParams; propParams?: PropParams; minMinutes?: number; onProgress?: (d: number, n: number) => void } = {}
): Record<PropStat, PropStatMetrics> {
  const p = opts.params ?? DEFAULT_NBA_PARAMS;
  const pp = opts.propParams ?? { ...DEFAULT_PROP_PARAMS, sims: 1500 };
  const minMin = opts.minMinutes ?? 15;
  const byGame = new Map<number, PlayerGameRow[]>();
  for (const r of h.allPlayerRows) {
    const l = byGame.get(r.gameId);
    if (l) l.push(r);
    else byGame.set(r.gameId, [r]);
  }
  const acc = Object.fromEntries(PROP_STATS.map((s) => [s, { n: 0, aeM: 0, aeN: 0, err: 0, cov: 0, llM: 0, llN: 0 }])) as Record<
    PropStat,
    { n: number; aeM: number; aeN: number; err: number; cov: number; llM: number; llN: number }
  >;
  const leagues = new Map<number, League>();
  const ratings = new Map<number, RatingTable>();
  for (const [gi, g] of games.entries()) {
    const day = Math.floor(g.t / 864e5);
    const lg = leagues.get(day) ?? leagueAverages(h, g.t, p);
    leagues.set(day, lg);
    const rt = ratings.get(day) ?? fitTeamRatings(h, g.t, p);
    ratings.set(day, rt);
    const rows = byGame.get(g.id) ?? [];
    for (const [teamId, oppId] of [
      [g.homeId, g.awayId],
      [g.awayId, g.homeId],
    ]) {
      const played = rows.filter((r) => r.teamId === teamId && r.minutes > 0);
      const base = new Map(baselineMinutes(h, teamId, g.t, { activeDays: 400 }).map((b) => [b.playerId, b.baseline]));
      const mins = projectMinutes(
        played.map((r) => ({ playerId: r.playerId, name: "", position: null, baseline: Math.max(4, base.get(r.playerId) ?? 12), games: 0, injuryStatus: null, injuryDetail: null, override: null }))
      );
      const env = propEnv(rt, teamId, oppId);
      for (const m of mins) {
        if (m.minutes < minMin) continue;
        const actualRow = played.find((r) => r.playerId === m.playerId)!;
        const hist = h.players.get(m.playerId) ?? [];
        const i0 = firstBefore(hist, g.t);
        const last = hist.slice(i0).filter((r) => r.minutes > 0).slice(0, 10);
        if (last.length < 5) continue;
        const rates = playerRates(h, m.playerId, g.t, lg, p);
        const sim = simulatePlayer(rates, m.minutes, env, pp, (g.id * 31 + m.playerId) >>> 0);
        for (const stat of PROP_STATS) {
          const y = statOf(stat, actualRow);
          const naive = last.reduce((a, r) => a + statOf(stat, r), 0) / last.length;
          const sm = summarizeSamples(sim[stat]);
          const a = acc[stat];
          a.n++;
          a.aeM += Math.abs(y - sm.mean);
          a.aeN += Math.abs(y - naive);
          a.err += y - sm.mean;
          if (y >= sm.q10 && y <= sm.q90) a.cov++;
          // Låtsaslinje på ,5 kring det naiva snittet.
          const line = Math.floor(naive) + 0.5;
          const over = y > line ? 1 : 0;
          a.llM += ll(overProb(sim[stat], line).p, over);
          const nOver = last.filter((r) => statOf(stat, r) > line).length;
          a.llN += ll((nOver + 1) / (last.length + 2), over);
        }
      }
    }
    opts.onProgress?.(gi + 1, games.length);
  }
  return Object.fromEntries(
    PROP_STATS.map((s) => {
      const a = acc[s];
      const n = a.n || 1;
      return [s, { n: a.n, maeModel: a.aeM / n, maeNaive: a.aeN / n, biasModel: a.err / n, coverage80: a.cov / n, logLossModel: a.llM / n, logLossNaive: a.llN / n }];
    })
  ) as Record<PropStat, PropStatMetrics>;
}
