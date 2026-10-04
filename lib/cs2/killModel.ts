// Spelarens kills och headshots som sannolikhetsfördelning.
//
// En spelare tar fler kills i rundor laget vinner (det är oftast därför
// rundan vanns) än i rundor det förlorar. Kills på en karta modelleras därför
// betingat på rundorna:
//
//   kills | (w vunna, l förlorade) ~ NegBin(w·kw + l·kl, φ)
//
// kw och kl är spelarens kills per vunnen/förlorad runda på just den kartan,
// krympta mot hans nivå över alla kartor och den mot ligan. Fördelningen av
// (w, l) kommer ur kartmodellen och fördelningen av kartor ur vetot — så
// "karta 1–2" blir en blandning över kartpar och slutresultat, inte ett snitt.
// Böckernas regler skiljer sig om övertid räknas; båda varianterna stöds.

import { convolvePmf, negBinPmfVector, lineProbs } from "../shotModel";
import type { PlayerSideFacts } from "./demo/types";
import type { MapDistribution } from "./mapModel";
import type { VetoDistribution } from "./veto";

/** Dispersion för kills givet rundorna. Satt nära Poisson; justeras av backtestet. */
export const DEFAULT_KILL_PHI = 40;
export const MAX_KILLS_MAP = 70;
export const MAX_KILLS_SERIES = 140;

export interface KillRates {
  kw: number;
  kl: number;
  hs: number;
  /** Rundor bakom kartans värde (före krympning). */
  rounds: number;
}

export interface LeagueKillPrior {
  kw: number;
  kl: number;
  hs: number;
}

/** Ligasnitt per spelare — ungefärliga CS2-nivåer, ersätts av data när den finns. */
export const DEFAULT_LEAGUE_PRIOR: LeagueKillPrior = { kw: 0.88, kl: 0.42, hs: 0.47 };

const shrink = (num: number, den: number, prior: number, k: number) => (num + k * prior) / (den + k);

export interface RateInputs {
  /** Demofakta per karta (båda sidor summerade). */
  demo: Record<string, Pick<PlayerSideFacts, "killsWon" | "killsLost" | "roundsWon" | "rounds" | "headshots" | "kills">>;
  /** HLTV per karta: kills, headshots och lagets vunna/förlorade rundor. */
  hltv: Record<string, { kills: number; headshots: number | null; roundsWon: number; roundsLost: number }>;
}

/**
 * Kill-rater per karta. Demofakta ger kw/kl direkt; finns bara HLTV-siffror
 * delas kills upp med ligans kvot kw/kl.
 */
export function killRates(inp: RateInputs, league: LeagueKillPrior, maps: string[]): Record<string, KillRates> & { all: KillRates } {
  const ratio = league.kw / league.kl;
  const obs = new Map<string, { kwN: number; kwD: number; klN: number; klD: number; hsN: number; hsD: number; rounds: number }>();
  const allMaps = new Set([...Object.keys(inp.demo), ...Object.keys(inp.hltv), ...maps]);
  for (const m of allMaps) {
    const d = inp.demo[m];
    const h = inp.hltv[m];
    const o = { kwN: 0, kwD: 0, klN: 0, klD: 0, hsN: 0, hsD: 0, rounds: 0 };
    if (d && d.rounds > 0) {
      o.kwN = d.killsWon;
      o.kwD = d.roundsWon;
      o.klN = d.killsLost;
      o.klD = d.rounds - d.roundsWon;
      o.hsN = d.headshots;
      o.hsD = d.kills;
      o.rounds = d.rounds;
    } else if (h && h.roundsWon + h.roundsLost > 0) {
      const kl = h.kills / (ratio * h.roundsWon + h.roundsLost);
      o.kwN = ratio * kl * h.roundsWon;
      o.kwD = h.roundsWon;
      o.klN = kl * h.roundsLost;
      o.klD = h.roundsLost;
      if (h.headshots != null) {
        o.hsN = h.headshots;
        o.hsD = h.kills;
      }
      o.rounds = h.roundsWon + h.roundsLost;
    }
    obs.set(m, o);
  }
  const sum = { kwN: 0, kwD: 0, klN: 0, klD: 0, hsN: 0, hsD: 0, rounds: 0 };
  for (const o of obs.values()) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += o[k];
  const all: KillRates = {
    kw: shrink(sum.kwN, sum.kwD, league.kw, 40),
    kl: shrink(sum.klN, sum.klD, league.kl, 40),
    hs: shrink(sum.hsN, sum.hsD, league.hs, 80),
    rounds: sum.rounds,
  };
  const out = { all } as Record<string, KillRates> & { all: KillRates };
  for (const m of allMaps) {
    const o = obs.get(m)!;
    out[m] = {
      kw: shrink(o.kwN, o.kwD, all.kw, 30),
      kl: shrink(o.klN, o.klD, all.kl, 30),
      hs: shrink(o.hsN, o.hsD, all.hs, 60),
      rounds: o.rounds,
    };
  }
  return out;
}

/**
 * Kills på en karta: blandning över kartans slutresultat. `dist` ska vara ur
 * spelarens lags perspektiv (A = spelarens lag).
 */
export function killPmfForMap(rates: KillRates, dist: MapDistribution, includeOt: boolean, phi = DEFAULT_KILL_PHI, maxK = MAX_KILLS_MAP): number[] {
  const byMean = new Map<number, number>();
  for (const o of dist.outcomes) {
    const w = o.aReg + (includeOt ? o.aOt : 0);
    const l = o.bReg + (includeOt ? o.bOt : 0);
    const mean = Math.round((w * rates.kw + l * rates.kl) * 1000) / 1000;
    byMean.set(mean, (byMean.get(mean) ?? 0) + o.p);
  }
  const out = new Array<number>(maxK + 1).fill(0);
  for (const [mean, p] of byMean) {
    const v = negBinPmfVector(mean, phi, maxK);
    for (let k = 0; k <= maxK; k++) out[k] += p * v[k];
  }
  return out;
}

/** Headshots ur kills: HS | K ~ Binomial(K, hs). */
export function headshotPmf(killPmf: number[], hs: number): number[] {
  const out = new Array<number>(killPmf.length).fill(0);
  for (let k = 0; k < killPmf.length; k++) {
    const pk = killPmf[k];
    if (pk < 1e-12) continue;
    // Binomial via rekursion.
    let term = Math.pow(1 - hs, k);
    for (let h = 0; h <= k; h++) {
      out[h] += pk * term;
      term = h < k ? (term * (k - h) * hs) / ((h + 1) * (1 - hs || 1e-12)) : 0;
    }
  }
  return out;
}

export interface SeriesPmf {
  pmf: number[];
  /** Sannolikheten att scopet alls spelas (karta 3 i en bo3). */
  pPlayed: number;
}

/**
 * Fördelning för ett scope ur per-karta-fördelningarna och vetot.
 * map1/map2/map3: betingat på att kartan spelas (böcker voidar annars).
 * maps12: summan av karta 1 och 2, blandad över kartparen.
 */
export function seriesPmf(
  scope: "map1" | "map2" | "map3" | "maps12" | "match",
  veto: VetoDistribution,
  perMap: (map: string) => number[],
  pMapPlayed: number[] = [1, 1, 1, 1, 1],
  maxK = MAX_KILLS_SERIES,
  /** För scope "match" i bo3: P(karta 3 spelas) längs vägen. */
  pDecider?: (maps: string[]) => number
): SeriesPmf {
  const out = new Array<number>(maxK + 1).fill(0);
  const cache = new Map<string, number[]>();
  const pmfOf = (m: string) => {
    let v = cache.get(m);
    if (!v) cache.set(m, (v = perMap(m)));
    return v;
  };
  let total = 0;
  for (const path of veto.paths) {
    let v: number[] | null = null;
    if (scope === "match") {
      if (path.maps.length === 1) v = pmfOf(path.maps[0]);
      else {
        const two = convolvePmf(pmfOf(path.maps[0]), pmfOf(path.maps[1]), maxK);
        if (path.maps.length >= 3) {
          const p3 = pDecider ? pDecider(path.maps) : pMapPlayed[2] ?? 0;
          const three = convolvePmf(two, pmfOf(path.maps[2]), maxK);
          v = two.map((x, k) => (1 - p3) * x + p3 * (three[k] ?? 0));
        } else v = two;
      }
    } else if (scope === "maps12") {
      if (path.maps.length < 2) continue;
      v = convolvePmf(pmfOf(path.maps[0]), pmfOf(path.maps[1]), maxK);
    } else {
      const idx = scope === "map1" ? 0 : scope === "map2" ? 1 : 2;
      const m = path.maps[idx];
      if (!m) continue;
      v = pmfOf(m);
    }
    for (let k = 0; k < v.length && k <= maxK; k++) out[k] += path.p * v[k];
    total += path.p;
  }
  if (total > 0) for (let k = 0; k <= maxK; k++) out[k] /= total;
  const pPlayed = scope === "map3" ? pMapPlayed[2] ?? 0 : scope === "map2" ? pMapPlayed[1] ?? 1 : 1;
  return { pmf: out, pPlayed };
}

export function pmfMean(pmf: number[]): number {
  return pmf.reduce((s, p, k) => s + p * k, 0);
}

/** Linjen (x.5) närmast medianen — "fair line" att visa när ingen bok finns. */
export function medianLine(pmf: number[]): number {
  let best = 0.5;
  let bestDiff = Infinity;
  let tail = 1; // P(X ≥ k) — P(över) på linjen k − 0,5
  for (let k = 0; k < pmf.length; k++) {
    const diff = Math.abs(tail - 0.5);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = k - 0.5;
    }
    tail -= pmf[k];
  }
  return Math.max(0.5, best);
}

/** P(över) på en linje — tunn wrapper för läsbarhetens skull. */
export function overProb(pmf: number[], line: number) {
  return lineProbs(pmf, line);
}
