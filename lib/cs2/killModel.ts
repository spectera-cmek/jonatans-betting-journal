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
//
// Historiken vägs med halveringstid (KILL_HALF_LIFE_DAYS) och justeras för
// motståndet: kills mot ett lag som släpper till många kills räknas ner, och
// raten skalas upp eller ner efter kommande motståndares släppta kills
// (teamConcession). Allt valt med walk-forward-backtest på 33 674
// spelare-kartor: log-score 3,0874 → 3,0749, MAE 4,26 → 4,20 kills.

import { convolvePmf, negBinPmfVector, lineProbs } from "../shotModel";
import type { PlayerSideFacts } from "./demo/types";
import type { MapDistribution } from "./mapModel";
import type { VetoDistribution } from "./veto";

/** Dispersion för kills givet rundorna (log-score-optimum i backtestet). */
export const DEFAULT_KILL_PHI = 60;
/** Halveringstid för spelarens kill-historik. */
export const KILL_HALF_LIFE_DAYS = 60;
/** Krympning (rundor) av ett lags släppta kills mot ligan. */
export const CONCESSION_SHRINK_ROUNDS = 300;
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

/**
 * Krympning i rundor (kw/kl). Kartnivån krymps hårt: en spelares kills på en
 * enskild karta är mest brus, hans totala nivå säger mer (backtest: 30 → 200).
 */
export const KILL_SHRINK = { all: 60, map: 200 };

/**
 * Hur många kills ett lag släpper till per runda, relativt ligan (1 = snitt).
 * `kills` = kills av lag 1:s respektive lag 2:s spelare på kartan.
 */
export function teamConcession(
  maps: Array<{ team1Id: number; team2Id: number; rounds: number; kills1: number; kills2: number }>,
  k = CONCESSION_SHRINK_ROUNDS
): { byTeam: Record<number, number>; league: number } {
  const acc: Record<number, { k: number; r: number }> = {};
  let K = 0;
  let R = 0;
  for (const m of maps) {
    if (m.rounds <= 0) continue;
    (acc[m.team1Id] ??= { k: 0, r: 0 }).k += m.kills2;
    acc[m.team1Id].r += m.rounds;
    (acc[m.team2Id] ??= { k: 0, r: 0 }).k += m.kills1;
    acc[m.team2Id].r += m.rounds;
    K += m.kills1 + m.kills2;
    R += 2 * m.rounds;
  }
  const league = R > 0 ? K / R : 0.66;
  const byTeam: Record<number, number> = {};
  for (const [team, a] of Object.entries(acc)) byTeam[Number(team)] = (a.k + k * league) / (a.r + k) / league;
  return { byTeam, league };
}

/**
 * HLTV-historik per karta, viktad efter ålder och normerad för motståndet
 * (kills delas med motståndarens släppta-kills-faktor).
 */
export function killHistory(
  rows: Array<{ playedAt: Date; mapName: string; kills: number; headshots: number | null; won: number; lost: number; opp: number | null }>,
  now: Date,
  concession: Record<number, number> = {},
  halfLifeDays = KILL_HALF_LIFE_DAYS
): RateInputs["hltv"] {
  const out: RateInputs["hltv"] = {};
  for (const r of rows) {
    const age = Math.max(0, (now.getTime() - r.playedAt.getTime()) / 86_400_000);
    const w = Math.pow(0.5, age / halfLifeDays);
    const f = r.opp != null ? concession[r.opp] ?? 1 : 1;
    const e = (out[r.mapName] ??= { kills: 0, headshots: 0, roundsWon: 0, roundsLost: 0 });
    e.kills += (w * r.kills) / f;
    e.headshots = e.headshots != null && r.headshots != null ? e.headshots + (w * r.headshots) / f : null;
    e.roundsWon += w * r.won;
    e.roundsLost += w * r.lost;
  }
  return out;
}

/** Kill-raterna skalade efter kommande motståndares släppta kills. */
export function vsOpponent<T extends Record<string, KillRates>>(rates: T, factor: number): T {
  if (factor === 1) return rates;
  return Object.fromEntries(Object.entries(rates).map(([k, r]) => [k, { ...r, kw: r.kw * factor, kl: r.kl * factor }])) as T;
}

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
export function killRates(
  inp: RateInputs,
  league: LeagueKillPrior,
  maps: string[],
  /** Krympning i rundor: spelarens nivå mot ligan och kartan mot spelarens nivå. */
  shrinkRounds: { all: number; map: number } = KILL_SHRINK
): Record<string, KillRates> & { all: KillRates } {
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
    kw: shrink(sum.kwN, sum.kwD, league.kw, shrinkRounds.all),
    kl: shrink(sum.klN, sum.klD, league.kl, shrinkRounds.all),
    hs: shrink(sum.hsN, sum.hsD, league.hs, 80),
    rounds: sum.rounds,
  };
  const out = { all } as Record<string, KillRates> & { all: KillRates };
  for (const m of allMaps) {
    const o = obs.get(m)!;
    out[m] = {
      kw: shrink(o.kwN, o.kwD, all.kw, shrinkRounds.map),
      kl: shrink(o.klN, o.klD, all.kl, shrinkRounds.map),
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
