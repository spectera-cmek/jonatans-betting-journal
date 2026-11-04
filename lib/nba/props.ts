// Spelarprops: poäng, returer, assist, trepoängare och PRA.
//
// Varje spelare simuleras för sig, "kväll för kväll":
//   minuter      ~ Normal(förväntade minuter, ±18 %)            (byten, foul trouble, blowouts)
//   usage-form   ~ log-normal kring 1                            (heta/kalla kvällar i volym)
//   2PA/3PA/FTA  ~ Poisson(takt/min × minuter × matchens tempo × usage)
//   träff        ~ Binomial med kvällens träffprocent (spelarens + motståndet + dagsform)
//   returer/assist ~ Poisson(takt × minuter × tempo × egen form)
// Spelarens takter kommer ur ratings.ts (krympta mot positionen), och matchens
// tempo och nivå ur lagmodellen — en snabb match mot ett dåligt försvar ger mer.

import type { PlayerRates } from "./ratings";
import { logit, mulberry32, sigmoid } from "./sim";

export type PropStat = "pts" | "reb" | "ast" | "fg3" | "pra";
export const PROP_STATS: PropStat[] = ["pts", "reb", "ast", "fg3", "pra"];
export const PROP_LABEL: Record<PropStat, string> = { pts: "Poäng", reb: "Returer", ast: "Assist", fg3: "Trepoängare", pra: "PRA" };

export interface PropParams {
  /** Minuternas spridning som andel av förväntade minuter (minst minutesSdMin). */
  minutesSd: number;
  minutesSdMin: number;
  /** Kvällens volymform (σ på log-skalan) för skott och straffar. */
  usageSigma: number;
  /** Kvällens träffform (σ på träff-logit). */
  shotSigma: number;
  /** Kvällens form för returer och assist (σ på log-skalan). */
  rebSigma: number;
  astSigma: number;
  sims: number;
  /** 0 = takter ur ratings.ts (krympta mot positionen), 1 = propRates.ts (tvånivå-prior, egen halveringstid per grupp). */
  rateModel: number;
  /** Halveringstider (spelarens matcher) för volym, träff, returer, assist — rateModel 1. */
  hlVolume: number;
  hlPct: number;
  hlReb: number;
  hlAst: number;
  /** Krympning (minuter) av färsk takt mot spelarens lång sikt, och av lång sikt mot positionen. */
  shortK: number;
  longK: number;
  /** Matcher i lång sikt. */
  longGames: number;
  /** Krympning (försök) av träffprocent: 2P, 3P, straffar. */
  pct2K: number;
  pct3K: number;
  ftK: number;
  /** Usage-omfördelning när ordinarie saknas: andel av plays, assist och returer som tas över. 0 = av. */
  usageBeta: number;
  astBeta: number;
  rebBeta: number;
  /** Vem tar över: vikt minuter · takt^γ. */
  usageGamma: number;
}

export const DEFAULT_PROP_PARAMS: PropParams = {
  minutesSd: 0.18,
  minutesSdMin: 3,
  usageSigma: 0.2,
  shotSigma: 0.2,
  rebSigma: 0.2,
  astSigma: 0.25,
  sims: 5000,
  // Box-score 2025-26 (5 453 spelare-matcher): MAE poäng 5,01 → 4,96, log loss alla fem bättre
  // (t.ex. trepoängare 0,6232 → 0,6037), täckning oförändrad. Linjebacktest: modellens log loss
  // vid Pinnacles linje 0,7100 → 0,7092 och snittnivån stämmer (andel över per stat ±0,3 %-enheter).
  rateModel: 1,
  hlVolume: 25,
  hlPct: 60,
  hlReb: 20,
  hlAst: 25,
  shortK: 300,
  longK: 400,
  longGames: 120,
  pct2K: 150,
  pct3K: 250,
  ftK: 60,
  usageBeta: 0,
  astBeta: 0,
  rebBeta: 0,
  usageGamma: 1,
};

/** Version för props-prissättningen (sparas på projektioner och picks). */
export const PROP_MODEL_VERSION = "props-v2";

/**
 * Reserv när ingen färsk Pinnacle-linje finns: modellvikt mot bokens EGET
 * avviggade pris (den gamla vägen). Sådana priser flaggas aldrig — en flagga
 * kräver ~35 %-enheters oenighet och var nästan alltid en modellbugg.
 */
export const PROP_OWN_BLEND_W = 0.15;

/** Matchens miljö för spelarens lag. */
export interface PropEnv {
  /** Matchens tempo / lagets vanliga tempo. */
  paceFactor: number;
  /** Logit-tillägg på träffprocenten mot just den här motståndaren. */
  effLogit: number;
  /** Assistfaktor (fler träffar = fler assist). */
  astFactor: number;
}

export const NEUTRAL_ENV: PropEnv = { paceFactor: 1, effLogit: 0, astFactor: 1 };

function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function poisson(lambda: number, rand: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 40) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rand)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

function binomial(n: number, p: number, rand: () => number): number {
  let x = 0;
  for (let i = 0; i < n; i++) if (rand() < p) x++;
  return x;
}

export type PropSamples = Record<PropStat, Int16Array>;

/** Simulerar en spelares kvällar. */
export function simulatePlayer(r: PlayerRates, minutes: number, env: PropEnv = NEUTRAL_ENV, pp: PropParams = DEFAULT_PROP_PARAMS, seed = 1): PropSamples {
  const n = pp.sims;
  const rand = mulberry32(seed >>> 0);
  const out: PropSamples = { pts: new Int16Array(n), reb: new Int16Array(n), ast: new Int16Array(n), fg3: new Int16Array(n), pra: new Int16Array(n) };
  const l2 = logit(Math.min(0.95, Math.max(0.05, r.pct2))) + env.effLogit;
  const l3 = logit(Math.min(0.95, Math.max(0.05, r.pct3))) + env.effLogit;
  const sd = Math.max(pp.minutesSdMin, pp.minutesSd * minutes);
  const lnAdj = (s: number) => -(s * s) / 2; // så att log-normal har medel 1
  for (let i = 0; i < n; i++) {
    const m = minutes <= 0 ? 0 : Math.min(48, Math.max(0, minutes + sd * normal(rand)));
    const vol = m * env.paceFactor;
    const u = Math.exp(pp.usageSigma * normal(rand) + lnAdj(pp.usageSigma));
    const e = pp.shotSigma * normal(rand);
    const a2 = poisson(r.a2 * vol * u, rand);
    const a3 = poisson(r.a3 * vol * u, rand);
    const fta = poisson(r.fta * vol * u, rand);
    const m2 = binomial(a2, sigmoid(l2 + e), rand);
    const m3 = binomial(a3, sigmoid(l3 + e), rand);
    const ftm = binomial(fta, r.ftPct, rand);
    const pts = 2 * m2 + 3 * m3 + ftm;
    const reb = poisson((r.oreb + r.dreb) * vol * Math.exp(pp.rebSigma * normal(rand) + lnAdj(pp.rebSigma)), rand);
    const ast = poisson(r.ast * vol * env.astFactor * Math.exp(pp.astSigma * normal(rand) + lnAdj(pp.astSigma)), rand);
    out.pts[i] = pts;
    out.reb[i] = reb;
    out.ast[i] = ast;
    out.fg3[i] = m3;
    out.pra[i] = pts + reb + ast;
  }
  return out;
}

export interface PropSummary {
  mean: number;
  median: number;
  q10: number;
  q90: number;
}

export function summarizeSamples(x: Int16Array): PropSummary {
  const s = Int16Array.from(x).sort();
  const n = s.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return { mean: sum / n, median: s[Math.floor(n / 2)], q10: s[Math.floor(n * 0.1)], q90: s[Math.min(n - 1, Math.floor(n * 0.9))] };
}

/** P(över linjen | ingen push) och P(push). */
export function overProb(x: Int16Array, line: number): { p: number; push: number } {
  let over = 0;
  let push = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > line) over++;
    else if (x[i] === line) push++;
  }
  const live = x.length - push;
  return { p: live ? over / live : 0.5, push: push / x.length };
}

/** Antal simulerade kvällar per värde (0..max), för fördelningskurvan. */
export function histogram(x: Int16Array): number[] {
  let max = 0;
  for (let i = 0; i < x.length; i++) if (x[i] > max) max = x[i];
  const h = new Array<number>(max + 1).fill(0);
  for (let i = 0; i < x.length; i++) h[x[i]]++;
  return h;
}

/** Faktiskt utfall ur en boxscore-rad. */
export function actualStat(stat: PropStat, r: { pts: number; oreb: number; dreb: number; ast: number; fgm3: number }): number {
  switch (stat) {
    case "pts":
      return r.pts;
    case "reb":
      return r.oreb + r.dreb;
    case "ast":
      return r.ast;
    case "fg3":
      return r.fgm3;
    case "pra":
      return r.pts + r.oreb + r.dreb + r.ast;
  }
}
