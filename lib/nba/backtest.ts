// Walk-forward-backtest: varje match projiceras bara med data från före
// matchen och jämförs med slutresultatet och med stängningspriset.
//
// Minuter: historiska skadelistor finns inte, så backtesten låter modellen
// veta VILKA spelare som spelade (som skadelistan + dina ändringar ger inför
// en riktig match), men inte HUR MYCKET — minuterna är spelarnas grundminuter
// före matchen, omfördelade till 240. Det är så nära den riktiga körningen
// som går utan historiska skadelistor.

import { devigProportional } from "../fairOdds";
import { blendProb } from "../shotModel";
import { baseLineup, baselineMinutes, projectMinutes } from "./minutes";
import { bucketRecords, gradePick, modelLine, pickFromLine, type BucketRecord, type GradedPick, type PickMarket } from "./picks";
import { fitTeamRatings, type RatingTable } from "./teamRatings";
import { DEFAULT_NBA_BLEND_W, DEFAULT_NBA_PARAMS, isFlagged, type NbaModelParams } from "./params";
import { modelProb, settle, type NbaMarket } from "./pricing";
import { leagueAverages, type History, type League, type PlayerGameRow } from "./ratings";
import { projectGame } from "./project";

export interface BacktestGame {
  id: number;
  t: number;
  homeId: number;
  awayId: number;
  neutral: boolean;
  homeScore: number;
  awayScore: number;
}

export interface ClosingQuote {
  market: NbaMarket;
  line: number | null;
  price1: number;
  price2: number;
  book: string;
}

export interface MarketMetrics {
  n: number;
  logLossModel: number;
  logLossMarket: number;
  brierModel: number;
  brierMarket: number;
  /** Log loss per modellvikt w (0 = marknaden, 1 = modellen). */
  blend: Array<{ w: number; logLoss: number }>;
  bestW: number;
  /** Flat 1 enhet på varje markerat spel (edge ≥ tröskeln, odds ≤ taket), mot stängningspriset. */
  bets: number;
  roi: number | null;
}

export interface BacktestResult {
  games: number;
  margin: { maeModel: number; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  total: { maeModel: number; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  markets: Partial<Record<NbaMarket, MarketMetrics>>;
  /** Picks i poäng mot stängningslinjen, per edge-hink (alla, 3+, 6+). */
  ats: Partial<Record<PickMarket, BucketRecord[]>>;
  books: string[];
}

const LOG_EPS = 1e-6;
const ll = (p: number, y: number) => -(y * Math.log(Math.max(LOG_EPS, p)) + (1 - y) * Math.log(Math.max(LOG_EPS, 1 - p)));
const W_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

interface Obs {
  market: NbaMarket;
  pModel: number;
  pMarket: number;
  y: number;
  price1: number;
  price2: number;
  pPush: number;
}

export function runBacktest(
  h: History,
  games: BacktestGame[],
  closing: Map<number, ClosingQuote[]>,
  opts: { params?: NbaModelParams; sims?: number; onProgress?: (done: number, total: number) => void } = {}
): BacktestResult {
  const p = { ...(opts.params ?? DEFAULT_NBA_PARAMS), sims: opts.sims ?? 4000 };
  const played = new Map<number, PlayerGameRow[]>();
  for (const r of h.allPlayerRows) {
    const l = played.get(r.gameId);
    if (l) l.push(r);
    else played.set(r.gameId, [r]);
  }
  const leagueByDay = new Map<number, League>();
  const ratingsByDay = new Map<number, RatingTable>();
  const picks: Record<PickMarket, GradedPick[]> = { spread: [], total: [] };
  const obs: Obs[] = [];
  const books = new Set<string>();
  const m = { absModel: 0, absMarket: 0, nMarket: 0, err: 0, sq: 0, simVar: 0 };
  const t = { absModel: 0, absMarket: 0, nMarket: 0, err: 0, sq: 0, simVar: 0 };
  let n = 0;

  for (const [i, g] of games.entries()) {
    const day = Math.floor(g.t / 864e5);
    let league = leagueByDay.get(day);
    if (!league) {
      league = leagueAverages(h, g.t, p);
      leagueByDay.set(day, league);
    }
    let ratings = ratingsByDay.get(day);
    if (!ratings && p.ratingMix > 0) {
      ratings = fitTeamRatings(h, g.t, p);
      ratingsByDay.set(day, ratings);
    }
    const rows = played.get(g.id) ?? [];
    const lineup = (teamId: number) => {
      const who = new Set(rows.filter((r) => r.teamId === teamId && r.minutes > 0).map((r) => r.playerId));
      const base = new Map(baselineMinutes(h, teamId, g.t, { activeDays: 400 }).map((b) => [b.playerId, b.baseline]));
      const inputs = [...who].map((playerId) => ({
        playerId,
        name: "",
        position: null,
        baseline: Math.max(4, base.get(playerId) ?? 12),
        games: 0,
        injuryStatus: null,
        injuryDetail: null,
        override: null,
      }));
      return projectMinutes(inputs).map((r) => ({ playerId: r.playerId, minutes: r.minutes }));
    };
    const homeLineup = lineup(g.homeId);
    const awayLineup = lineup(g.awayId);
    if (homeLineup.length < 5 || awayLineup.length < 5) continue;
    const proj = projectGame(
      h,
      {
        homeId: g.homeId,
        awayId: g.awayId,
        t: g.t,
        neutral: g.neutral,
        homeLineup,
        awayLineup,
        homeBaseLineup: baseLineup(h, g.homeId, g.t),
        awayBaseLineup: baseLineup(h, g.awayId, g.t),
      },
      p,
      league,
      ratings
    );
    const s = proj.summary;
    const margin = g.homeScore - g.awayScore;
    const total = g.homeScore + g.awayScore;
    n++;
    m.absModel += Math.abs(margin - s.marginMean);
    m.err += margin - s.marginMean;
    m.sq += (margin - s.marginMean) ** 2;
    m.simVar += s.marginSd ** 2;
    t.absModel += Math.abs(total - s.totalMean);
    t.err += total - s.totalMean;
    t.sq += (total - s.totalMean) ** 2;
    t.simVar += s.totalSd ** 2;

    for (const q of closing.get(g.id) ?? []) {
      books.add(q.book);
      if (q.market === "spread" && q.line != null) {
        m.absMarket += Math.abs(margin + q.line);
        m.nMarket++;
      }
      if (q.market === "total" && q.line != null) {
        t.absMarket += Math.abs(total - q.line);
        t.nMarket++;
      }
      if ((q.market === "spread" || q.market === "total") && q.line != null) {
        const ml = modelLine(q.market, s.homeMean, s.awayMean);
        const pk = pickFromLine(q.market, ml, q.line);
        picks[q.market].push({
          edgePts: pk.edgePts,
          result: gradePick(q.market, pk.side, q.line, g.homeScore, g.awayScore),
          price: pk.side === 1 ? q.price1 : q.price2,
        });
      }
      const y = settle(q.market, q.line, g.homeScore, g.awayScore);
      const dv = devigProportional(q.price1, [q.price2]);
      if (!dv) continue;
      const mp = modelProb(proj.sim, q.market, q.line);
      obs.push({ market: q.market, pModel: mp.p, pMarket: dv.p, y, price1: q.price1, price2: q.price2, pPush: mp.push });
    }
    opts.onProgress?.(i + 1, games.length);
  }

  const markets: Partial<Record<NbaMarket, MarketMetrics>> = {};
  for (const mk of ["ml", "spread", "total"] as NbaMarket[]) {
    const all = obs.filter((o) => o.market === mk);
    const o = all.filter((x) => x.y !== 0.5);
    if (!o.length) continue;
    const mean = (f: (x: Obs) => number) => o.reduce((a, x) => a + f(x), 0) / o.length;
    const blend = W_GRID.map((w) => ({ w, logLoss: mean((x) => ll(blendProb(x.pModel, x.pMarket, w), x.y)) }));
    const best = blend.reduce((a, b) => (b.logLoss < a.logLoss ? b : a));
    // Spelsimulering mot stängningspriset med dagens standardvikt.
    let staked = 0;
    let profit = 0;
    for (const x of all) {
      const pf = blendProb(x.pModel, x.pMarket, DEFAULT_NBA_BLEND_W[mk]);
      const live = 1 - x.pPush;
      const e1 = x.price1 * pf * live + x.pPush - 1;
      const e2 = x.price2 * (1 - pf) * live + x.pPush - 1;
      const side = e1 >= e2 ? 1 : 2;
      if (!isFlagged(Math.max(e1, e2), side === 1 ? x.price1 : x.price2)) continue;
      staked++;
      if (x.y === 0.5) continue;
      const won = side === 1 ? x.y === 1 : x.y === 0;
      profit += won ? (side === 1 ? x.price1 : x.price2) - 1 : -1;
    }
    markets[mk] = {
      n: o.length,
      logLossModel: mean((x) => ll(x.pModel, x.y)),
      logLossMarket: mean((x) => ll(x.pMarket, x.y)),
      brierModel: mean((x) => (x.pModel - x.y) ** 2),
      brierMarket: mean((x) => (x.pMarket - x.y) ** 2),
      blend,
      bestW: best.w,
      bets: staked,
      roi: staked ? profit / staked : null,
    };
  }

  const fin = (x: typeof m) => ({
    maeModel: n ? x.absModel / n : 0,
    maeMarket: x.nMarket ? x.absMarket / x.nMarket : null,
    bias: n ? x.err / n : 0,
    residualSd: n ? Math.sqrt(x.sq / n) : 0,
    simSd: n ? Math.sqrt(x.simVar / n) : 0,
  });
  return {
    games: n,
    margin: fin(m),
    total: fin(t),
    markets,
    ats: { spread: bucketRecords(picks.spread), total: bucketRecords(picks.total) },
    books: [...books],
  };
}
