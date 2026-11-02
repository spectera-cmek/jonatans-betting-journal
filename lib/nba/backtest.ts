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
import { bucketRecords, clvCheck, clvPoints, gradePick, modelLine, pickFromLine, type BucketRecord, type ClvCheck, type GradedPick, type PickMarket } from "./picks";
import { fitTeamRatings, type RatingTable } from "./teamRatings";
import { fitRapm, type RapmFit, type StintRow } from "./rapm";
import { DEFAULT_NBA_BLEND_W, DEFAULT_NBA_PARAMS, isFlagged, type NbaModelParams } from "./params";
import { modelProb, settle, type NbaMarket } from "./pricing";
import { firstBefore, leagueAverages, type History, type League, type PlayerGameRow } from "./ratings";
import { projectGame } from "./project";

export interface BacktestGame {
  id: number;
  t: number;
  homeId: number;
  awayId: number;
  neutral: boolean;
  seasonType?: number;
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
  /** maeModelSame = modellens MAE på exakt de matcher som har en marknadslinje (rättvis jämförelse). */
  margin: { maeModel: number; maeModelSame: number | null; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  total: { maeModel: number; maeModelSame: number | null; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  markets: Partial<Record<NbaMarket, MarketMetrics>>;
  /** Picks i poäng mot stängningslinjen, per edge-hink (alla, 3+, 6+). */
  ats: Partial<Record<PickMarket, BucketRecord[]>>;
  /** Bara med closeLines: CLV per sida mot att alltid spela sida 1. */
  clv?: Partial<Record<PickMarket, ClvCheck>>;
  /** Med betQuotes: hur många picks som spelades hos varje bolag. */
  betBooks?: Record<string, number>;
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
  opts: {
    params?: NbaModelParams;
    sims?: number;
    /** Stängningslinjer för CLV när `closing` är priser före stängning (speltid). */
    closeLines?: Map<number, ClosingQuote[]>;
    /** Stintar för RAPM (används när params.rapmK > 0). RAPM räknas om en gång i veckan. */
    stints?: StintRow[];
    /**
     * Vilka spelare modellen får veta spelar:
     *   "actual" — de som faktiskt spelade (vet sena strykningar, som marknaden vid stängning)
     *   "prev"   — de som spelade lagets förra match (vad som är känt på morgonen, före dagens skadebesked)
     */
    lineup?: "actual" | "prev";
    /**
     * Spela picken hos de här bolagen i stället för mot `closing`: alla deras
     * speltidspriser per match, bästa linjen för modellens sida väljs.
     */
    betQuotes?: Map<number, ClosingQuote[]>;
    onProgress?: (done: number, total: number) => void;
  } = {}
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
  const rapmByWeek = new Map<number, RapmFit>();
  const picks: Record<PickMarket, GradedPick[]> = { spread: [], total: [] };
  const always1: Record<PickMarket, number[]> = { spread: [], total: [] };
  const betBooks: Record<string, number> = {};
  const obs: Obs[] = [];
  const books = new Set<string>();
  const m = { absModel: 0, absMarket: 0, absModelSame: 0, nMarket: 0, err: 0, sq: 0, simVar: 0 };
  const t = { absModel: 0, absMarket: 0, absModelSame: 0, nMarket: 0, err: 0, sq: 0, simVar: 0 };
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
    let rapm: RapmFit | undefined;
    if (p.rapmK > 0 && opts.stints?.length) {
      // Veckovis: RAPM rör sig långsamt och är den dyraste delen att räkna.
      const week = Math.floor(day / 7);
      rapm = rapmByWeek.get(week);
      if (!rapm) {
        rapm = fitRapm(opts.stints, week * 7 * 864e5);
        rapmByWeek.set(week, rapm);
      }
    }
    const rows = played.get(g.id) ?? [];
    const lineup = (teamId: number) => {
      let who: Set<number>;
      if (opts.lineup === "prev") {
        // Förra matchens spelare — inga besked från matchdagen.
        const teamRows = h.teams.get(teamId) ?? [];
        const prev = teamRows[firstBefore(teamRows, g.t)];
        who = new Set((prev ? played.get(prev.gameId) ?? [] : []).filter((r) => r.teamId === teamId && r.minutes > 0).map((r) => r.playerId));
      } else who = new Set(rows.filter((r) => r.teamId === teamId && r.minutes > 0).map((r) => r.playerId));
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
      const sp = closing.get(g.id)?.find((q) => q.market === "spread")?.line;
      return projectMinutes(inputs, undefined, undefined, { absSpread: sp != null ? Math.abs(sp) : null }).map((r) => ({ playerId: r.playerId, minutes: r.minutes }));
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
        seasonType: g.seasonType,
        homeLineup,
        awayLineup,
        homeBaseLineup: baseLineup(h, g.homeId, g.t),
        awayBaseLineup: baseLineup(h, g.awayId, g.t),
        rapm,
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
        m.absModelSame += Math.abs(margin - s.marginMean);
        m.nMarket++;
      }
      if (q.market === "total" && q.line != null) {
        t.absMarket += Math.abs(total - q.line);
        t.absModelSame += Math.abs(total - s.totalMean);
        t.nMarket++;
      }
      if ((q.market === "spread" || q.market === "total") && q.line != null) {
        const mk = q.market;
        const ml = modelLine(mk, s.homeMean, s.awayMean);
        const close = opts.closeLines?.get(g.id)?.find((c) => c.market === mk && c.line != null);
        // Utan betQuotes spelas picken på q (Pinnacle). Med betQuotes: bästa linjen bland dina bolag.
        const cands = opts.betQuotes ? (opts.betQuotes.get(g.id) ?? []).filter((c) => c.market === mk && c.line != null) : [q];
        const chosen = bestPick(mk, ml, cands);
        if (chosen) {
          const { c, pk } = chosen;
          if (opts.betQuotes) betBooks[c.book] = (betBooks[c.book] ?? 0) + 1;
          // Jämförelser på samma linjer: alltid sida 1, och en slumpad sida (snittet av bästa sida 1 och 2).
          let base: number | null = null;
          if (close?.line != null) {
            const best1 = Math.max(...cands.map((x) => clvPoints(mk, 1, x.line!, close.line!)));
            const best2 = Math.max(...cands.map((x) => clvPoints(mk, 2, x.line!, close.line!)));
            always1[mk].push(best1);
            base = (best1 + best2) / 2;
          }
          picks[mk].push({
            edgePts: pk.edgePts,
            side: pk.side,
            result: gradePick(mk, pk.side, c.line!, g.homeScore, g.awayScore),
            price: pk.side === 1 ? c.price1 : c.price2,
            clv: close?.line != null ? clvPoints(mk, pk.side, c.line!, close.line) : null,
            base,
          });
        }
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
    maeModelSame: x.nMarket ? x.absModelSame / x.nMarket : null,
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
    clv: opts.closeLines ? { spread: clvCheck(picks.spread, always1.spread), total: clvCheck(picks.total, always1.total) } : undefined,
    books: [...books],
    betBooks: opts.betQuotes ? betBooks : undefined,
  };
}

/** Bästa linjen för modellen bland bolagens priser: störst edge i poäng, sedan bäst pris. */
export function bestPick(market: PickMarket, model: number, cands: ClosingQuote[]) {
  let best: { c: ClosingQuote; pk: ReturnType<typeof pickFromLine>; price: number } | null = null;
  for (const c of cands) {
    if (c.line == null) continue;
    const pk = pickFromLine(market, model, c.line);
    const price = pk.side === 1 ? c.price1 : c.price2;
    if (!best || pk.edgePts > best.pk.edgePts || (pk.edgePts === best.pk.edgePts && price > best.price)) best = { c, pk, price };
  }
  return best;
}
