// Backtest för props mot RIKTIGA linjer (OddsPapi-historiken: Pinnacle,
// Unibet/Kambi, Betsson). Två steg:
//
//   1. buildLineRecords — varje spelare med linjer projiceras med data före
//      matchen; varje linje får modellens P(över) och utfallet.
//   2. Analyser (rena funktioner på posterna):
//      - devigCalibration: vilket sätt att ta bort Pinnacles marginal stämmer
//      - blendStudy: modell mot Pinnacle på Pinnacles stängningslinje, vikt w,
//        trimmad på första delen av datumen och rapporterad på resten
//      - softBookEv: mjuka böckers pris mot Pinnacles rättvisa pris vid
//        speltillfället → värde mot Pinnacles stängning och mot utfallet
//      - betTimeSkill: förutsäger modellens edge vid speltillfället hur
//        Pinnacle rör sig till stängningen?
//      - biasByTier: modellens snittfel per poängnivå
//
// Utfallet används bara för att mäta; kopplingen och urvalet använder det aldrig.

import type { PropStat } from "./props";
import { overProb } from "./props";
import type { PlayerGameRow } from "./ratings";
import { devigTwoWay, DEVIG_METHODS, type DevigMethod } from "./devig";
import { blendLogit, shapeOf, translate } from "./propPricing";
import { rowStat } from "./propsMapping";

export interface SnapQuote {
  book: string;
  at: string;
  tSec: number;
  line: number;
  over: number;
  under: number;
  maxStake: number | null;
  /** Hela stegen vid tidpunkten [linje, över, under] (bara när fler än en). */
  rungs?: Array<[number, number, number]>;
}

export interface RungEval {
  line: number;
  over: number;
  under: number;
  pModel: number;
  pPush: number;
}

export interface LineRecord {
  gameId: number;
  t: number;
  seasonType: number;
  playerId: number;
  stat: PropStat;
  /** Utfallet (spelaren spelade). */
  actual: number;
  minutes: number;
  mean: number;
  vmr: number;
  /** Per bok och tidpunkt: alla steg med modellens P(över). */
  quotes: Array<Omit<SnapQuote, "rungs"> & { rungs: RungEval[] }>;
}

export function evalQuotes(samples: Int16Array, quotes: SnapQuote[]): LineRecord["quotes"] {
  return quotes.map((q) => {
    const rs = q.rungs?.length ? q.rungs : [[q.line, q.over, q.under] as [number, number, number]];
    return {
      book: q.book,
      at: q.at,
      tSec: q.tSec,
      line: q.line,
      over: q.over,
      under: q.under,
      maxStake: q.maxStake,
      rungs: rs.map(([line, over, under]) => {
        const m = overProb(samples, line);
        return { line, over, under, pModel: m.p, pPush: m.push };
      }),
    };
  });
}

export function makeRecord(base: Omit<LineRecord, "mean" | "vmr" | "quotes" | "actual">, samples: Int16Array, quotes: SnapQuote[], actualRow: PlayerGameRow): LineRecord {
  const sh = shapeOf(samples);
  return { ...base, actual: rowStat(actualRow, base.stat), mean: sh.mean, vmr: sh.vmr, quotes: evalQuotes(samples, quotes) };
}

// ---------------------------------------------------------------------------
// Statistik-hjälpare
// ---------------------------------------------------------------------------

const EPS = 1e-4;
export const logLoss = (p: number, y: number) => -(y * Math.log(Math.max(EPS, p)) + (1 - y) * Math.log(Math.max(EPS, 1 - p)));
const clampP = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));

/** Snitt och klustrad standardavvikelse (kluster = match) → t-värde. */
export function clusteredMean(xs: Array<{ x: number; g: number }>): { n: number; mean: number; se: number; t: number } {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, se: 0, t: 0 };
  const mean = xs.reduce((a, b) => a + b.x, 0) / n;
  const byG = new Map<number, number>();
  for (const { x, g } of xs) byG.set(g, (byG.get(g) ?? 0) + (x - mean));
  let v = 0;
  for (const s of byG.values()) v += s * s;
  const G = byG.size;
  const se = G > 1 ? Math.sqrt((v * G) / (G - 1)) / n : 0;
  return { n, mean, se, t: se > 0 ? mean / se : 0 };
}

/** Datumgräns: första `frac` av matchdagarna = träning. */
export function splitTime(recs: LineRecord[], frac: number): number {
  const ts = [...new Set(recs.map((r) => Math.floor(r.t / 864e5)))].sort((a, b) => a - b);
  if (!ts.length) return Infinity;
  return ts[Math.min(ts.length - 1, Math.floor(ts.length * frac))] * 864e5;
}

const quoteAt = (r: LineRecord, book: string, at: string) => r.quotes.find((q) => q.book === book && q.at === at);
const rungAt = (q: LineRecord["quotes"][number] | undefined, line: number) => q?.rungs.find((x) => x.line === line);

/** Utfallet mot linjen: 1 över, 0 under, null push. */
export const outcome = (actual: number, line: number): 0 | 1 | null => (actual > line ? 1 : actual < line ? 0 : null);

// ---------------------------------------------------------------------------
// D1: devig-metod
// ---------------------------------------------------------------------------

export interface CalibRow {
  stat: string;
  book: string;
  n: number;
  logLoss: Record<DevigMethod, number>;
  brier: Record<DevigMethod, number>;
  /** Reliability (10 korgar, P(över) enligt `prop`): [snitt p, andel över, n]. */
  bins: Array<[number, number, number]>;
}

export function devigCalibration(recs: LineRecord[], book = "pinnacle", at = "close"): CalibRow[] {
  const acc = new Map<string, { n: number; ll: Record<string, number>; br: Record<string, number>; bins: Array<[number, number, number]> }>();
  for (const r of recs) {
    const q = quoteAt(r, book, at);
    if (!q) continue;
    const y = outcome(r.actual, q.line);
    if (y == null) continue;
    for (const key of [r.stat, "alla"]) {
      const a = acc.get(key) ?? { n: 0, ll: {}, br: {}, bins: Array.from({ length: 10 }, () => [0, 0, 0] as [number, number, number]) };
      a.n++;
      for (const m of DEVIG_METHODS) {
        const p = devigTwoWay(q.over, q.under, m)!;
        a.ll[m] = (a.ll[m] ?? 0) + logLoss(p, y);
        a.br[m] = (a.br[m] ?? 0) + (p - y) ** 2;
      }
      const p = devigTwoWay(q.over, q.under, "prop")!;
      const b = a.bins[Math.min(9, Math.floor(p * 10))];
      b[0] += p;
      b[1] += y;
      b[2]++;
      acc.set(key, a);
    }
  }
  return [...acc.entries()].map(([stat, a]) => ({
    stat,
    book,
    n: a.n,
    logLoss: Object.fromEntries(DEVIG_METHODS.map((m) => [m, a.ll[m] / a.n])) as Record<DevigMethod, number>,
    brier: Object.fromEntries(DEVIG_METHODS.map((m) => [m, a.br[m] / a.n])) as Record<DevigMethod, number>,
    bins: a.bins.filter((b) => b[2] > 0).map(([sp, sy, n]) => [sp / n, sy / n, n] as [number, number, number]),
  }));
}

// ---------------------------------------------------------------------------
// D2: modell mot Pinnacle på Pinnacles linje
// ---------------------------------------------------------------------------

export interface BlendRow {
  stat: string;
  nTrain: number;
  nTest: number;
  /** Testdelen: log loss för marknaden, modellen och bästa w (trimmad på träning). */
  llMarket: number;
  llModel: number;
  bestW: number;
  llBlend: number;
  /** Δ = blend − marknad på testdelen, med 95 % konfidensintervall (bootstrap per match). */
  delta: number;
  ci: [number, number];
  /** Kurvan på träningsdelen: [w, log loss]. */
  curve: Array<[number, number]>;
}

const W_GRID = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1];

export function blendStudy(recs: LineRecord[], opts: { book?: string; at?: string; method?: DevigMethod; frac?: number; boot?: number; seed?: number } = {}): BlendRow[] {
  const book = opts.book ?? "pinnacle";
  const at = opts.at ?? "close";
  const method = opts.method ?? "power";
  const cut = splitTime(recs, opts.frac ?? 0.6);
  type Pt = { pM: number; pK: number; y: number; g: number; train: boolean };
  const by = new Map<string, Pt[]>();
  for (const r of recs) {
    const q = quoteAt(r, book, at);
    const rung = rungAt(q, q?.line ?? NaN);
    if (!q || !rung) continue;
    const y = outcome(r.actual, q.line);
    if (y == null) continue;
    const pK = devigTwoWay(q.over, q.under, method);
    if (pK == null) continue;
    const pt = { pM: rung.pModel, pK, y, g: r.gameId, train: r.t < cut };
    for (const key of [r.stat, "alla"]) { const l_ = by.get(key); if (l_) l_.push(pt); else by.set(key, [pt]); }
  }
  const out: BlendRow[] = [];
  for (const [stat, pts] of by) {
    const train = pts.filter((p) => p.train);
    const test = pts.filter((p) => !p.train);
    if (train.length < 50 || test.length < 50) continue;
    const ll = (xs: Pt[], w: number) => xs.reduce((a, p) => a + logLoss(blendLogit(p.pM, p.pK, w), p.y), 0) / xs.length;
    const curve = W_GRID.map((w) => [w, ll(train, w)] as [number, number]);
    const bestW = curve.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
    // Bootstrap per match på testdelen.
    const games = [...new Set(test.map((p) => p.g))];
    const byG = new Map<number, Pt[]>();
    for (const p of test) { const l_ = byG.get(p.g); if (l_) l_.push(p); else byG.set(p.g, [p]); }
    let s = opts.seed ?? 7;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
    const deltas: number[] = [];
    for (let b = 0; b < (opts.boot ?? 500); b++) {
      let d = 0;
      let n = 0;
      for (let i = 0; i < games.length; i++) {
        for (const p of byG.get(games[Math.floor(rand() * games.length)])!) {
          d += logLoss(blendLogit(p.pM, p.pK, bestW), p.y) - logLoss(p.pK, p.y);
          n++;
        }
      }
      deltas.push(d / Math.max(1, n));
    }
    deltas.sort((a, b) => a - b);
    out.push({
      stat,
      nTrain: train.length,
      nTest: test.length,
      llMarket: ll(test, 0),
      llModel: ll(test, 1),
      bestW,
      llBlend: ll(test, bestW),
      delta: ll(test, bestW) - ll(test, 0),
      ci: [deltas[Math.floor(deltas.length * 0.025)], deltas[Math.floor(deltas.length * 0.975)]],
      curve,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mjuka böcker mot Pinnacles rättvisa pris
// ---------------------------------------------------------------------------

export interface EvBet {
  gameId: number;
  playerId: number;
  t: number;
  stat: PropStat;
  book: string;
  at: string;
  side: "over" | "under";
  line: number;
  price: number;
  sameLine: boolean;
  /** Värde vid speltillfället mot Pinnacles rättvisa pris (översatt till linjen). */
  evBet: number;
  /** Samma med modellen inblandad (vikt w). */
  evBlend: number;
  /** Värde mot Pinnacles rättvisa stängning på samma linje. */
  evClose: number | null;
  /** Utfall i enheter (1 insats), null = push. */
  profit: number | null;
  pinMaxStake: number | null;
}

/**
 * Alla mjuka steg vid tidpunkten `at` som har ett Pinnacle-pris vid samma
 * tidpunkt: ankaret = Pinnacles rättvisa P översatt till stegets linje med
 * modellens spridning. evClose räknas likadant mot Pinnacles stängning.
 */
export function softBookBets(recs: LineRecord[], opts: { books?: string[]; ats?: string[]; method?: DevigMethod; w?: Partial<Record<string, number>> } = {}): EvBet[] {
  const books = opts.books ?? ["unibet.se", "betsson"];
  const ats = opts.ats ?? ["open", "-6h", "-3h", "-1h"];
  const method = opts.method ?? "power";
  const out: EvBet[] = [];
  for (const r of recs) {
    const close = quoteAt(r, "pinnacle", "close");
    const pClose = close ? devigTwoWay(close.over, close.under, method) : null;
    for (const at of ats) {
      const pin = quoteAt(r, "pinnacle", at);
      if (!pin) continue;
      const pPin = devigTwoWay(pin.over, pin.under, method);
      if (pPin == null) continue;
      for (const book of books) {
        const q = quoteAt(r, book, at);
        if (!q) continue;
        for (const rung of q.rungs) {
          const anc = translate(pPin, pin.line, rung.line, r.vmr);
          const cl = pClose != null && close ? translate(pClose, close.line, rung.line, r.vmr) : null;
          const w = opts.w?.[r.stat] ?? 0;
          const pB = blendLogit(rung.pModel, anc.p, w);
          for (const side of ["over", "under"] as const) {
            const price = side === "over" ? rung.over : rung.under;
            const pa = side === "over" ? anc.p : 1 - anc.p;
            const pb = side === "over" ? pB : 1 - pB;
            const y = outcome(r.actual, rung.line);
            out.push({
              gameId: r.gameId,
              playerId: r.playerId,
              t: r.t,
              stat: r.stat,
              book,
              at,
              side,
              line: rung.line,
              price,
              sameLine: rung.line === pin.line,
              evBet: price * pa * (1 - anc.push) + anc.push - 1,
              evBlend: price * pb * (1 - anc.push) + anc.push - 1,
              evClose: cl ? price * (side === "over" ? cl.p : 1 - cl.p) * (1 - cl.push) + cl.push - 1 : null,
              profit: y == null ? null : (side === "over" ? y === 1 : y === 0) ? price - 1 : -1,
              pinMaxStake: pin.maxStake,
            });
          }
        }
      }
    }
  }
  return out;
}

export interface EvSummary {
  key: string;
  n: number;
  evBet: number;
  evClose: ReturnType<typeof clusteredMean>;
  roi: ReturnType<typeof clusteredMean>;
}

export function summarizeBets(bets: EvBet[], key: (b: EvBet) => string, select: (b: EvBet) => boolean): EvSummary[] {
  const groups = new Map<string, EvBet[]>();
  for (const b of bets) {
    if (!select(b)) continue;
    const k = key(b);
    { const l_ = groups.get(k); if (l_) l_.push(b); else groups.set(k, [b]); }
  }
  return [...groups.entries()]
    .map(([k, bs]) => ({
      key: k,
      n: bs.length,
      evBet: bs.reduce((a, b) => a + b.evBet, 0) / bs.length,
      evClose: clusteredMean(bs.filter((b) => b.evClose != null).map((b) => ({ x: b.evClose!, g: b.gameId }))),
      roi: clusteredMean(bs.filter((b) => b.profit != null).map((b) => ({ x: b.profit!, g: b.gameId }))),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Bästa sidan per (match, spelare, stat, bok, tidpunkt) — en insats per prop, inte en per steg. */
export function bestPerProp(bets: EvBet[], score: (b: EvBet) => number): EvBet[] {
  const best = new Map<string, EvBet>();
  for (const b of bets) {
    const k = `${b.gameId}|${b.playerId}|${b.stat}|${b.book}|${b.at}`;
    const cur = best.get(k);
    if (!cur || score(b) > score(cur)) best.set(k, b);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// D3: förutsäger modellen Pinnacles rörelse?
// ---------------------------------------------------------------------------

export interface SkillRow {
  stat: string;
  at: string;
  n: number;
  /** Korrelation mellan modellens edge (logit pModel − logit pPin) och Pinnacles rörelse (logit). */
  corr: number;
  /** Lutning: rörelse per enhet edge, med klustrat t. */
  slope: number;
  t: number;
}

export function betTimeSkill(recs: LineRecord[], opts: { ats?: string[]; method?: DevigMethod } = {}): SkillRow[] {
  const method = opts.method ?? "power";
  const out: SkillRow[] = [];
  for (const at of opts.ats ?? ["open", "-6h", "-3h"]) {
    const by = new Map<string, Array<{ e: number; m: number; g: number }>>();
    for (const r of recs) {
      const q = quoteAt(r, "pinnacle", at);
      const c = quoteAt(r, "pinnacle", "close");
      if (!q || !c) continue;
      const rung = rungAt(q, q.line);
      const pT = devigTwoWay(q.over, q.under, method);
      const pC0 = devigTwoWay(c.over, c.under, method);
      if (!rung || pT == null || pC0 == null) continue;
      const pC = translate(pC0, c.line, q.line, r.vmr).p;
      const pt = { e: logit(rung.pModel) - logit(pT), m: logit(pC) - logit(pT), g: r.gameId };
      for (const k of [r.stat, "alla"]) { const l_ = by.get(k); if (l_) l_.push(pt); else by.set(k, [pt]); }
    }
    for (const [stat, pts] of by) {
      if (pts.length < 30) continue;
      const me = pts.reduce((a, p) => a + p.e, 0) / pts.length;
      const mm = pts.reduce((a, p) => a + p.m, 0) / pts.length;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (const p of pts) {
        sxy += (p.e - me) * (p.m - mm);
        sxx += (p.e - me) ** 2;
        syy += (p.m - mm) ** 2;
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      // Klustrat t för lutningen: residualer·x per match.
      const byG = new Map<number, number>();
      for (const p of pts) {
        const res = p.m - mm - slope * (p.e - me);
        byG.set(p.g, (byG.get(p.g) ?? 0) + res * (p.e - me));
      }
      let v = 0;
      for (const s of byG.values()) v += s * s;
      const se = sxx > 0 ? Math.sqrt(v) / sxx : 0;
      out.push({ stat, at, n: pts.length, corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0, slope, t: se > 0 ? slope / se : 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bias per nivå
// ---------------------------------------------------------------------------

export interface TierRow {
  stat: string;
  tier: string;
  n: number;
  /** Utfall − modellens medel. */
  biasModel: number;
  /** Utfall − Pinnacles stängningslinje. */
  biasLine: number;
  /** Modellens medel − Pinnacles stängningslinje. */
  modelMinusLine: number;
}

export function biasByTier(recs: LineRecord[]): TierRow[] {
  const tierOf = (r: LineRecord) => {
    const ptsMean = r.stat === "pts" ? r.mean : null;
    if (ptsMean == null) return r.mean < 3 ? "låg" : r.mean < 7 ? "mellan" : "hög";
    return ptsMean < 10 ? "< 10" : ptsMean < 20 ? "10–20" : "20+";
  };
  const acc = new Map<string, { n: number; bm: number; bl: number; ml: number }>();
  for (const r of recs) {
    const c = quoteAt(r, "pinnacle", "close");
    if (!c) continue;
    const k = `${r.stat}|${tierOf(r)}`;
    const a = acc.get(k) ?? { n: 0, bm: 0, bl: 0, ml: 0 };
    a.n++;
    a.bm += r.actual - r.mean;
    a.bl += r.actual - c.line;
    a.ml += r.mean - c.line;
    acc.set(k, a);
  }
  return [...acc.entries()].map(([k, a]) => {
    const [stat, tier] = k.split("|");
    return { stat, tier, n: a.n, biasModel: a.bm / a.n, biasLine: a.bl / a.n, modelMinusLine: a.ml / a.n };
  });
}
