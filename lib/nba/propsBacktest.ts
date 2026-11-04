// Backtest för props mot riktiga boxscores (det finns inga historiska
// prop-linjer att jämföra mot). Varje spelare projiceras med data före
// matchen och jämförs med:
//   - naiv projektion: spelarens snitt de senaste 10 matcherna (ungefär det en
//     slarvig linje bygger på)
//   - en låtsaslinje = naiva snittet avrundat till ,5 — log loss för modellens
//     P(över) mot andelen av de 10 senaste matcherna över samma linje
//   - täckning: hur ofta utfallet hamnar mellan modellens 10:e och 90:e
//     percentil (ska vara ~80 %)

import { baseLineup, baselineMinutes, projectMinutes } from "./minutes";
import { playerPropRates, scaleRates, usageMultipliers } from "./propRates";
import { DEFAULT_NBA_PARAMS, type NbaModelParams } from "./params";
import { DEFAULT_PROP_PARAMS, PROP_STATS, overProb, simulatePlayer, summarizeSamples, type PropParams, type PropSamples, type PropStat } from "./props";
import { firstBefore, leagueAverages, playerRates, type History, type League, type PlayerGameRow, type PlayerRates } from "./ratings";
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

/** Ligasnitt och lagrating per dag (samma dag = samma värden), cachade. */
export class GameContextCache {
  private leagues = new Map<number, League>();
  private ratings = new Map<number, RatingTable>();
  constructor(
    private h: History,
    private p: NbaModelParams = DEFAULT_NBA_PARAMS
  ) {}
  at(t: number): { lg: League; rt: RatingTable } {
    const day = Math.floor(t / 864e5);
    let lg = this.leagues.get(day);
    if (!lg) this.leagues.set(day, (lg = leagueAverages(this.h, t, this.p)));
    let rt = this.ratings.get(day);
    if (!rt) this.ratings.set(day, (rt = fitTeamRatings(this.h, t, this.p)));
    return { lg, rt };
  }
}

export interface ProjectedPlayer {
  teamId: number;
  minutes: number;
  samples: PropSamples;
}

/**
 * Projicerar spelarna i en spelad match med data före den.
 *   lineup "actual": de som spelade (marknaden vet uppställningen vid stängning)
 *   lineup "prev":   lagets förra match + `expected` (spelare med prop-linjer —
 *                    en linje betyder att bolaget räknar med att han spelar)
 * Minuterna är grundminuter omfördelade till 240 (aldrig de verkliga minuterna),
 * med utklassningsrisk från `absSpread`. `only` begränsar vilka som simuleras.
 */
export function projectGamePlayers(
  h: History,
  g: BacktestGame,
  rows: PlayerGameRow[],
  lg: League,
  rt: RatingTable,
  opts: {
    params?: NbaModelParams;
    propParams?: PropParams;
    lineup?: "actual" | "prev";
    absSpread?: number | null;
    expected?: Set<number>;
    only?: Set<number>;
    minMinutes?: number;
    /** Spelarrader per match (för "prev"); byggs annars ur historiken. */
    byGame?: Map<number, PlayerGameRow[]>;
  } = {}
): Map<number, ProjectedPlayer> {
  const p = opts.params ?? DEFAULT_NBA_PARAMS;
  const pp = opts.propParams ?? { ...DEFAULT_PROP_PARAMS, sims: 1500 };
  const out = new Map<number, ProjectedPlayer>();
  for (const [teamId, oppId] of [
    [g.homeId, g.awayId],
    [g.awayId, g.homeId],
  ]) {
    let ids: number[];
    if (opts.lineup === "prev") {
      const teamRows = h.teams.get(teamId) ?? [];
      const prevGame = teamRows[firstBefore(teamRows, g.t)];
      const prevRows = prevGame ? (opts.byGame?.get(prevGame.gameId) ?? h.allPlayerRows.filter((r) => r.gameId === prevGame.gameId)) : [];
      const prev = prevRows.filter((r) => r.teamId === teamId && r.minutes > 0).map((r) => r.playerId);
      const exp = [...(opts.expected ?? [])].filter((id) => {
        const hist = h.players.get(id) ?? [];
        return hist[firstBefore(hist, g.t)]?.teamId === teamId;
      });
      ids = [...new Set([...prev, ...exp])];
    } else {
      ids = rows.filter((r) => r.teamId === teamId && r.minutes > 0).map((r) => r.playerId);
    }
    const base = new Map(baselineMinutes(h, teamId, g.t, { activeDays: 400 }).map((b) => [b.playerId, b.baseline]));
    const mins = projectMinutes(
      ids.map((id) => ({ playerId: id, name: "", position: null, baseline: Math.max(4, base.get(id) ?? 12), games: 0, injuryStatus: null, injuryDetail: null, override: null })),
      undefined,
      undefined,
      { absSpread: opts.absSpread ?? null }
    );
    const env = propEnv(rt, teamId, oppId);
    const rateCache = new Map<number, PlayerRates>();
    const rateOf = (id: number) => {
      let r = rateCache.get(id);
      if (!r) rateCache.set(id, (r = pp.rateModel ? playerPropRates(h, id, g.t, lg, pp) : playerRates(h, id, g.t, lg, p)));
      return r;
    };
    const tonight = mins.filter((m) => m.minutes > 0).map((m) => ({ playerId: m.playerId, minutes: m.minutes }));
    const mult = usageMultipliers(tonight, pp.usageBeta || pp.astBeta || pp.rebBeta ? baseLineup(h, teamId, g.t) : [], rateOf, pp);
    for (const m of mins) {
      if (m.minutes < (opts.minMinutes ?? 0) || m.minutes <= 0) continue;
      if (opts.only && !opts.only.has(m.playerId)) continue;
      const rates = scaleRates(rateOf(m.playerId), mult.get(m.playerId));
      out.set(m.playerId, { teamId, minutes: m.minutes, samples: simulatePlayer(rates, m.minutes, env, pp, (g.id * 31 + m.playerId) >>> 0) });
    }
  }
  return out;
}

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
  const ctx = new GameContextCache(h, p);
  for (const [gi, g] of games.entries()) {
    const { lg, rt } = ctx.at(g.t);
    const rows = byGame.get(g.id) ?? [];
    const proj = projectGamePlayers(h, g, rows, lg, rt, { params: p, propParams: pp, lineup: "actual", minMinutes: minMin });
    for (const [playerId, pr] of proj) {
      const actualRow = rows.find((r) => r.playerId === playerId)!;
      const hist = h.players.get(playerId) ?? [];
      const i0 = firstBefore(hist, g.t);
      const last = hist.slice(i0).filter((r) => r.minutes > 0).slice(0, 10);
      if (last.length < 5) continue;
      const sim = pr.samples;
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
