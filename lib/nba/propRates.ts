// Takter för props (bara props — matchmodellen använder ratings.ts orörd).
//
// 1. Tvånivå-prior: spelarens långsiktiga takt (upp till `longGames` matcher,
//    oviktad) krymps mot positionen, och den färska, viktade takten krymps mot
//    den långsiktiga. Den gamla vägen drog allt direkt mot positionssnittet med
//    250 minuter — ~17 % för en 34-minutersstjärna, ~35 % efter 20 matcher.
// 2. Egen halveringstid per grupp: volym (skott, straffar, bollförluster),
//    träffprocent, returer och assist stabiliseras olika snabbt.
// 3. Usage-omfördelning: när ordinarie spelare saknas tas deras plays, assist
//    och returer över av dem som spelar, i proportion till hur mycket var och en
//    redan står för (exponent γ). β = 0 = ingen omfördelning.

import type { PropParams } from "./props";
import { firstBefore, type History, type League, type PlayerRates } from "./ratings";

const COUNT_KEYS = ["a2", "a3", "fta", "tov", "oreb", "dreb", "ast"] as const;
type CountKey = (typeof COUNT_KEYS)[number];
const GROUP: Record<CountKey, "vol" | "reb" | "ast"> = { a2: "vol", a3: "vol", fta: "vol", tov: "vol", oreb: "reb", dreb: "reb", ast: "ast" };

export function playerPropRates(h: History, playerId: number, asOf: number, league: League, pp: PropParams): PlayerRates {
  const rows = h.players.get(playerId) ?? [];
  const long = { min: 0, a2: 0, m2: 0, a3: 0, m3: 0, fta: 0, ftm: 0, tov: 0, oreb: 0, dreb: 0, ast: 0 };
  const short: Record<"vol" | "reb" | "ast" | "pct", { min: number; sums: Record<string, number> }> = {
    vol: { min: 0, sums: {} },
    reb: { min: 0, sums: {} },
    ast: { min: 0, sums: {} },
    pct: { min: 0, sums: {} },
  };
  const hl = { vol: pp.hlVolume, reb: pp.hlReb, ast: pp.hlAst, pct: pp.hlPct };
  let pos: string | null = null;
  let k = 0;
  for (let i = firstBefore(rows, asOf); i < rows.length && k < pp.longGames; i++) {
    const r = rows[i];
    pos ??= r.position;
    if (r.minutes <= 0) continue;
    const x: Record<string, number> = { a2: r.fga2, m2: r.fgm2, a3: r.fga3, m3: r.fgm3, fta: r.fta, ftm: r.ftm, tov: r.tov, oreb: r.oreb, dreb: r.dreb ?? 0, ast: r.ast ?? 0 };
    long.min += r.minutes;
    for (const key of Object.keys(x)) (long as Record<string, number>)[key] += x[key];
    for (const g of ["vol", "reb", "ast", "pct"] as const) {
      const w = Math.pow(0.5, k / hl[g]);
      short[g].min += w * r.minutes;
      for (const key of Object.keys(x)) short[g].sums[key] = (short[g].sums[key] ?? 0) + w * x[key];
    }
    k++;
  }
  const prior = league.pos[pos ?? "F"] ?? league.pos.F;
  const out = { sample: long.min } as PlayerRates;
  for (const key of COUNT_KEYS) {
    const longRate = ((long as Record<string, number>)[key] + prior[key] * pp.longK) / (long.min + pp.longK);
    const s = short[GROUP[key]];
    out[key] = ((s.sums[key] ?? 0) + longRate * pp.shortK) / (s.min + pp.shortK);
  }
  // Träffprocent: lång sikt krympt mot positionen i försök, kort sikt mot lång sikt.
  const pct = (m: "m2" | "m3" | "ftm", a: "a2" | "a3" | "fta", pr: number, K: number) => {
    const longPct = ((long as Record<string, number>)[m] + pr * K) / ((long as Record<string, number>)[a] + K);
    const s = short.pct.sums;
    return ((s[m] ?? 0) + longPct * K) / ((s[a] ?? 0) + K);
  };
  out.pct2 = pct("m2", "a2", prior.pct2, pp.pct2K);
  out.pct3 = pct("m3", "a3", prior.pct3, pp.pct3K);
  out.ftPct = pct("ftm", "fta", prior.ftPct, pp.ftK);
  return out;
}

export interface UsageMult {
  vol: number;
  ast: number;
  reb: number;
}

/**
 * Multiplikatorer för kvällens spelare när uppställningen skiljer sig från
 * lagets vanliga (`base`, minuter per spelare). Laget har ungefär lika många
 * plays, assist och returer att dela på oavsett vem som spelar; det som de
 * frånvarande brukar stå för fördelas med β på kvällens spelare, viktat
 * minuter · takt^γ.
 */
export function usageMultipliers(
  tonight: Array<{ playerId: number; minutes: number }>,
  base: Array<{ playerId: number; minutes: number }>,
  rateOf: (playerId: number) => PlayerRates,
  pp: Pick<PropParams, "usageBeta" | "astBeta" | "rebBeta" | "usageGamma">
): Map<number, UsageMult> {
  const out = new Map<number, UsageMult>(tonight.map((t) => [t.playerId, { vol: 1, ast: 1, reb: 1 }]));
  if (!(pp.usageBeta || pp.astBeta || pp.rebBeta)) return out;
  const pools: Array<["vol" | "ast" | "reb", (r: PlayerRates) => number, number]> = [
    ["vol", (r) => r.a2 + r.a3 + 0.44 * r.fta + r.tov, pp.usageBeta],
    ["ast", (r) => r.ast, pp.astBeta],
    ["reb", (r) => r.oreb + r.dreb, pp.rebBeta],
  ];
  for (const [key, f, beta] of pools) {
    if (!beta) continue;
    const total = (lineup: Array<{ playerId: number; minutes: number }>) => lineup.reduce((a, p) => a + p.minutes * f(rateOf(p.playerId)), 0);
    const delta = total(base) - total(tonight);
    const weights = tonight.map((p) => p.minutes * Math.pow(Math.max(1e-6, f(rateOf(p.playerId))), pp.usageGamma));
    const ws = weights.reduce((a, b) => a + b, 0);
    if (!(ws > 0)) continue;
    tonight.forEach((p, i) => {
      const own = p.minutes * f(rateOf(p.playerId));
      if (!(own > 0)) return;
      const m = 1 + (beta * delta * (weights[i] / ws)) / own;
      out.get(p.playerId)![key] = Math.min(1.6, Math.max(0.6, m));
    });
  }
  return out;
}

/** Takterna skalade med usage-multiplikatorerna. */
export function scaleRates(r: PlayerRates, m: UsageMult | undefined): PlayerRates {
  if (!m) return r;
  return { ...r, a2: r.a2 * m.vol, a3: r.a3 * m.vol, fta: r.fta * m.vol, tov: r.tov * m.vol, ast: r.ast * m.ast, oreb: r.oreb * m.reb, dreb: r.dreb * m.reb };
}
