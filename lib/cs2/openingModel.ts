// Pistolrunda och första kill.
//
// Pistol: ratingsmodellens pistolförmåga (ratings.ts), viktad över vilken
// sida laget börjar på. Första kill: lagens andel av rundornas första duell
// per sida (ur demos), ställda mot varandra med log5 — samma idé som när två
// slagmän/kastare möts i baseboll. Spelarens chans är lagets chans gånger
// hans andel av lagets öppningskills på sidan.

import type { Side } from "./types";

/** log5: P(A vinner) när A vinner andelen a och B andelen b mot ett snittlag. */
export function log5(a: number, b: number): number {
  const num = a * (1 - b);
  const den = num + b * (1 - a);
  return den > 0 ? num / den : 0.5;
}

export const shrinkRate = (num: number, den: number, prior: number, k: number) => (num + k * prior) / (den + k);

export interface OpeningRates {
  /** Andel rundor laget tog första killen, per sida (krympt mot 50 %). */
  team: Record<Side, number>;
  /** Spelarens andel av lagets öppningskills, per sida (krympt mot 20 %). */
  players: Record<string, Record<Side, number>>;
}

export function openingRates(
  rounds: Array<{ side: Side; firstKillBy: "own" | "opp" | null }>,
  players: Array<{ key: string; side: Side; openingKills: number }>
): OpeningRates {
  const team = { ct: 0.5, t: 0.5 } as Record<Side, number>;
  for (const side of ["ct", "t"] as const) {
    const rs = rounds.filter((r) => r.side === side && r.firstKillBy);
    team[side] = shrinkRate(rs.filter((r) => r.firstKillBy === "own").length, rs.length, 0.5, 40);
  }
  // Raderna kommer per karta och sida — summera per spelare först.
  const totals: Record<Side, number> = { ct: 0, t: 0 };
  const sums = new Map<string, Record<Side, number>>();
  for (const p of players) {
    totals[p.side] += p.openingKills;
    const s = sums.get(p.key) ?? { ct: 0, t: 0 };
    s[p.side] += p.openingKills;
    sums.set(p.key, s);
  }
  const out: OpeningRates["players"] = {};
  for (const [key, s] of sums) {
    out[key] = { ct: shrinkRate(s.ct, totals.ct, 0.2, 10), t: shrinkRate(s.t, totals.t, 0.2, 10) };
  }
  return { team, players: out };
}

/** P(A tar kartans första kill), viktat över startsidan i runda 1. */
export function firstKillProb(a: OpeningRates, b: OpeningRates, pAStartsCt: number): number {
  const aCt = log5(a.team.ct, b.team.t);
  const aT = log5(a.team.t, b.team.ct);
  return pAStartsCt * aCt + (1 - pAStartsCt) * aT;
}

/** P(spelaren tar kartans första kill). */
export function playerFirstKillProb(team: OpeningRates, opp: OpeningRates, playerKey: string, pTeamStartsCt: number): number {
  const share = team.players[playerKey] ?? { ct: 0.2, t: 0.2 };
  const pCt = log5(team.team.ct, opp.team.t) * share.ct;
  const pT = log5(team.team.t, opp.team.ct) * share.t;
  return pTeamStartsCt * pCt + (1 - pTeamStartsCt) * pT;
}

/** P(A vinner första pistolen) ur pistol-sannolikheterna per sida. */
export function firstPistolProb(pistolCtA: number, pistolCtB: number, pAStartsCt: number): number {
  return pAStartsCt * pistolCtA + (1 - pAStartsCt) * (1 - pistolCtB);
}
