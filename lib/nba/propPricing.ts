// Prop-priser förankrade i Pinnacle: Pinnacles rättvisa sannolikhet på dess
// linje flyttas till bokens linje med modellens form på fördelningen
// (negativ binomial med modellens spridning), och modellen får sedan luta.
//
//   pAnchor = P(över bokens linje) i en NB-fördelning vars medel ger Pinnacles
//             rättvisa P(över Pinnacles linje)
//   pFinal  = σ(w·logit pModel + (1−w)·logit pAnchor)

import { devigTwoWay, type DevigMethod } from "./devig";
import type { PropStatKey } from "../oddspapi/markets";

export interface CountShape {
  mean: number;
  /** Varians / medel (≥ 1 ⇒ NB, annars Poisson). */
  vmr: number;
}

/** Medel och varians/medel ur simulerade utfall. */
export function shapeOf(samples: ArrayLike<number>): CountShape {
  const n = samples.length;
  if (!n) return { mean: 0, vmr: 1 };
  let s = 0;
  for (let i = 0; i < n; i++) s += samples[i];
  const mean = s / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (samples[i] - mean) ** 2;
  v /= Math.max(1, n - 1);
  return { mean, vmr: mean > 0 ? Math.max(1, v / mean) : 1 };
}

const lgammaCache = new Map<number, number>();
function lgamma(x: number): number {
  // Lanczos (g = 7) — räcker gott för NB-sannolikheter.
  if (Number.isInteger(x) && x < 200 && lgammaCache.has(x)) return lgammaCache.get(x)!;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let r: number;
  if (x < 0.5) r = Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  else {
    const xx = x - 1;
    let a = c[0];
    const t = xx + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (xx + i);
    r = 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
  }
  if (Number.isInteger(x) && x < 200) lgammaCache.set(x, r);
  return r;
}

/** Sannolikheterna P(X = 0..kMax) för en NB med medel och varians/medel (Poisson vid vmr ≤ 1). */
export function countPmf(mean: number, vmr: number, kMax: number): number[] {
  const out = new Array<number>(kMax + 1).fill(0);
  if (!(mean > 0)) {
    out[0] = 1;
    return out;
  }
  if (vmr <= 1.0001) {
    let p = Math.exp(-mean);
    for (let k = 0; k <= kMax; k++) {
      out[k] = p;
      p *= mean / (k + 1);
    }
    return out;
  }
  // NB: r = μ/(vmr−1), p = 1/vmr  (P(k) = Γ(k+r)/(k!Γ(r)) p^r (1−p)^k)
  const r = mean / (vmr - 1);
  const p = 1 / vmr;
  const base = lgamma(r);
  for (let k = 0; k <= kMax; k++) out[k] = Math.exp(lgamma(k + r) - lgamma(k + 1) - base + r * Math.log(p) + k * Math.log(1 - p));
  return out;
}

/** P(X > line | ingen push) och P(push) för en heltalsfördelning. */
export function overFromPmf(pmf: number[], line: number): { p: number; push: number } {
  let over = 0;
  let push = 0;
  let total = 0;
  for (let k = 0; k < pmf.length; k++) {
    total += pmf[k];
    if (k > line) over += pmf[k];
    else if (k === line) push += pmf[k];
  }
  // Svansen bortom kMax räknas som över.
  over += Math.max(0, 1 - total);
  const live = 1 - push;
  return { p: live > 0 ? over / live : 0.5, push };
}

const kMaxFor = (mean: number, vmr: number) => Math.ceil(mean + 10 * Math.sqrt(Math.max(1, mean * vmr)) + 10);

/** P(över line) i en fördelning med given form. */
export function overProbShape(shape: CountShape, line: number): { p: number; push: number } {
  return overFromPmf(countPmf(shape.mean, shape.vmr, kMaxFor(shape.mean, shape.vmr)), line);
}

/**
 * Medlet som ger P(över refLine | ingen push) = pRef, med samma varians/medel
 * som formen. Bisektion — P(över) växer monotont med medlet.
 */
export function meanForProb(pRef: number, refLine: number, vmr: number): number {
  let lo = 0.01;
  let hi = Math.max(5, refLine * 3 + 10);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (overProbShape({ mean: mid, vmr }, refLine).p < pRef) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Pinnacles rättvisa P(över refLine) flyttad till `line` med modellens spridning. */
export function translate(pRef: number, refLine: number, line: number, vmr: number): { p: number; push: number } {
  if (line === refLine) {
    // Samma linje: Pinnacles sannolikhet som den är; pushen ur formen.
    const m = meanForProb(pRef, refLine, vmr);
    return { p: pRef, push: overProbShape({ mean: m, vmr }, line).push };
  }
  return overProbShape({ mean: meanForProb(pRef, refLine, vmr), vmr }, line);
}

const clamp = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Logit-blandning: w = 0 ger ankaret, w = 1 modellen. */
export function blendLogit(pModel: number, pAnchor: number, w: number): number {
  return sigmoid(w * logit(pModel) + (1 - w) * logit(pAnchor));
}

// ---------------------------------------------------------------------------
// Inställningar som backtesten sätter (nba:props-line-backtest)
// ---------------------------------------------------------------------------

/** Sättet att ta bort Pinnacles marginal (D1). */
export const PROP_DEVIG: DevigMethod = "power";

/**
 * Modellens vikt mot Pinnacles rättvisa pris per statistik, i log-odds (D2 vid
 * speltid, nba:props-line-backtest --split 0.6, tvånivå-takter): trimmad på 60 %
 * av datumen jan–nov 2026, testdelen −6h: alla w 0,15 Δ −0,0024 [−0,0038, −0,0007],
 * poäng w 0,20 Δ −0,0032, returer w 0,05 Δ −0,0014, assist w 0, trepoängare w 0,5
 * (KI spänner över 0 — sänkt till 0,3). PRA för få linjer: 0,05.
 * Usage-omfördelning (β 0,6) prövad och bortvald: modellens log loss 0,7100 → 0,7431.
 */
export const PROP_ANCHOR_W: Record<PropStatKey, number> = { pts: 0.15, reb: 0.05, ast: 0.05, fg3: 0.3, pra: 0.05 };

/** Äldsta Pinnacle-pris som får förankra (minuter sedan det senast sågs). */
export const ANCHOR_MAX_AGE_MIN = 90;

export interface PinAnchor {
  line: number;
  over: number;
  under: number;
  maxStake: number | null;
  /** När priset senast sågs (ms). */
  seenAt: number;
}

export interface AnchoredPrice {
  anchor: "pinnacle" | "own";
  pModel: number;
  pPush: number;
  /** Pinnacles rättvisa P(över) på bokens linje, eller bokens eget (own). */
  pAnchor: number | null;
  pFinal: number;
  edgeOver: number | null;
  edgeUnder: number | null;
  bestSide: "over" | "under" | null;
  edge: number | null;
  bestOdds: number | null;
}

/**
 * Pris för en boks linje: förankrat i Pinnacles rättvisa pris när ett färskt
 * finns, annars bokens egen avviggning med låg modellvikt (anchor "own").
 */
export function priceAnchoredProp(
  model: { p: number; push: number; vmr: number },
  quote: { line: number; over: number; under: number },
  pin: PinAnchor | null,
  w: number,
  opts: { now?: number; method?: DevigMethod; ownW?: number } = {}
): AnchoredPrice {
  const now = opts.now ?? Date.now();
  const fresh = pin && now - pin.seenAt <= ANCHOR_MAX_AGE_MIN * 60e3 ? pin : null;
  const pRef = fresh ? devigTwoWay(fresh.over, fresh.under, opts.method ?? PROP_DEVIG) : null;
  let anchor: AnchoredPrice["anchor"] = "own";
  let pAnchor: number | null = null;
  let push = model.push;
  let pFinal: number;
  if (fresh && pRef != null) {
    const tr = translate(pRef, fresh.line, quote.line, model.vmr);
    anchor = "pinnacle";
    pAnchor = tr.p;
    push = tr.push;
    pFinal = blendLogit(model.p, tr.p, w);
  } else {
    pAnchor = devigTwoWay(quote.over, quote.under, "prop");
    const ow = opts.ownW ?? 0.15;
    pFinal = pAnchor == null ? model.p : ow * model.p + (1 - ow) * pAnchor;
  }
  const e = edges(pFinal, push, quote.over, quote.under);
  const bestSide = e.edgeOver >= e.edgeUnder ? "over" : "under";
  return {
    anchor,
    pModel: model.p,
    pPush: push,
    pAnchor,
    pFinal,
    edgeOver: e.edgeOver,
    edgeUnder: e.edgeUnder,
    bestSide,
    edge: bestSide === "over" ? e.edgeOver : e.edgeUnder,
    bestOdds: bestSide === "over" ? quote.over : quote.under,
  };
}

/** Huvudlinjen bland flera: den med jämnast pris (samma regel som för matchlinjer). */
export function mainLineOf<T extends { over: number; under: number }>(rows: T[]): T | null {
  if (!rows.length) return null;
  const evenness = (r: T) => Math.abs(1 / r.over - 1 / r.under);
  return rows.reduce((a, b) => (evenness(b) < evenness(a) ? b : a));
}

/** Värde per insatt enhet för över/under, insatsen tillbaka vid push. */
export function edges(p: number, push: number, over: number, under: number): { edgeOver: number; edgeUnder: number } {
  return { edgeOver: over * p * (1 - push) + push - 1, edgeUnder: under * (1 - p) * (1 - push) + push - 1 };
}
