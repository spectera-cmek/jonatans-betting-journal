// Lagrating: offensiv och defensiv effektivitet (poäng per 100 possessions)
// och tempo, justerade mot det motstånd laget faktiskt mött.
//
// Varje lagmatch ger en observation  ORtg = liga + off(lag) + def(motst.) ± hemma/2.
// def > 0 betyder att laget SLÄPPER IN mer än snittet (sämre försvar).
// Systemet löses med viktad minsta kvadrat (alternerande, med ridge mot 0):
// färska matcher väger tyngst (halveringstid i dagar), och tidigt på säsongen
// bär förra säsongens matcher ratingen — de har bara lägre vikt.
// Tempo löses likadant: possessions/48 = liga + tempo(lag) + tempo(motst.).

import { DEFAULT_NBA_PARAMS, type NbaModelParams } from "./params";
import { firstBefore, gameMinutes, possessions, type History } from "./ratings";

export interface TeamRating {
  /** Poäng per 100 possessions över snittet i anfall. */
  off: number;
  /** Poäng per 100 possessions över snittet som laget släpper in (lägre = bättre). */
  def: number;
  /** Possessions per 48 över snittet (summeras med motståndarens). */
  pace: number;
  /** Viktat antal matcher bakom ratingen. */
  weight: number;
}

export interface RatingTable {
  /** Ligans poäng per 100 possessions. */
  ortg: number;
  /** Ligans possessions per 48 minuter. */
  pace: number;
  teams: Map<number, TeamRating>;
}

interface Obs {
  team: number;
  opp: number;
  w: number;
  /** ORtg minus liga och hemmaplan. */
  y: number;
  /** Possessions/48. */
  pace: number;
}

/** Sommaruppehåll: ett glapp i matcher längre än så här skiljer säsonger åt. */
const SEASON_GAP_MS = 60 * 864e5;

/** Första matchen i säsongen som asOf ligger i, och sista matchen säsongen före. */
export function seasonBounds(h: History, asOf: number): { start: number; prevEnd: number | null } | null {
  const rows = h.allTeamRows;
  const i0 = firstBefore(rows, asOf);
  if (i0 >= rows.length) return null;
  for (let i = i0; i < rows.length - 1; i++) {
    if (rows[i].t - rows[i + 1].t > SEASON_GAP_MS) return { start: rows[i].t, prevEnd: rows[i + 1].t };
  }
  return { start: rows[rows.length - 1].t, prevEnd: null };
}

/**
 * Lagrating före asOf. Tidigt på säsongen dras varje lag mot förra säsongens
 * slutrating (en del av den, resten mot snittet) i stället för mot 0 — som
 * marknaden gör innan lagen hunnit spela.
 */
export function fitTeamRatings(h: History, asOf: number, p: NbaModelParams = DEFAULT_NBA_PARAMS): RatingTable {
  const sb = p.priorGames > 0 ? seasonBounds(h, asOf) : null;
  if (sb?.prevEnd != null) {
    const prev = fitRaw(h, sb.prevEnd + 1, p, -Infinity, null);
    const prior = new Map<number, TeamRating>();
    prev.teams.forEach((r, k) => prior.set(k, { off: r.off * p.priorKeep, def: r.def * p.priorKeep, pace: r.pace * p.priorKeep, weight: 0 }));
    return fitRaw(h, asOf, p, sb.start, prior);
  }
  return fitRaw(h, asOf, p, -Infinity, null);
}

function fitRaw(h: History, asOf: number, p: NbaModelParams, from: number, prior: Map<number, TeamRating> | null): RatingTable {
  const rows = h.allTeamRows;
  const start = firstBefore(rows, asOf);
  const maxAge = 400 * 864e5;
  const obs: Obs[] = [];
  let wSum = 0;
  let rtgSum = 0;
  let paceSum = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const age = asOf - r.t;
    if (age > maxAge || r.t < from) break;
    const poss = possessions(r);
    if (poss <= 0) continue;
    const w = Math.pow(0.5, age / 864e5 / p.ratingHalfLifeDays);
    const rtg = (100 * r.pts) / poss;
    const pace48 = (poss / gameMinutes(r.periods)) * 48;
    // Hemmaplan: halva fördelen till hemmalaget, halva avdraget till bortalaget.
    const hca = r.home ? p.homeRtg / 2 : -p.homeRtg / 2;
    obs.push({ team: r.teamId, opp: r.oppId, w, y: rtg - hca, pace: pace48 });
    wSum += w;
    rtgSum += w * (rtg - hca);
    paceSum += w * pace48;
  }
  const teams = new Map<number, TeamRating>();
  if (!obs.length) {
    // Säsongens första match: bara förra säsongen finns.
    if (prior) prior.forEach((r, k) => teams.set(k, r));
    return { ortg: 115, pace: 99, teams };
  }
  const lg = rtgSum / wSum;
  const lgPace = paceSum / wSum;
  const off = new Map<number, number>();
  const def = new Map<number, number>();
  const pace = new Map<number, number>();
  const weight = new Map<number, number>();
  for (const o of obs) {
    off.set(o.team, 0);
    def.set(o.team, 0);
    pace.set(o.team, 0);
    weight.set(o.team, (weight.get(o.team) ?? 0) + o.w);
  }
  // Ridge: mot förra säsongen (med priorGames matchers vikt) eller mot snittet.
  const lambda = prior ? p.ratingRidgeGames + p.priorGames : p.ratingRidgeGames;
  const pr = (m: "off" | "def" | "pace", k: number) => (prior?.get(k)?.[m] ?? 0) * lambda;
  if (prior) prior.forEach((r, k) => {
    if (!off.has(k)) return;
    off.set(k, r.off);
    def.set(k, r.def);
    pace.set(k, r.pace);
  });
  for (let iter = 0; iter < 40; iter++) {
    // Anfall: y − liga − def(motst.)
    const accO = new Map<number, [number, number]>();
    const accD = new Map<number, [number, number]>();
    const accP = new Map<number, [number, number]>();
    for (const o of obs) {
      const a = accO.get(o.team) ?? [0, 0];
      a[0] += o.w * (o.y - lg - (def.get(o.opp) ?? 0));
      a[1] += o.w;
      accO.set(o.team, a);
      const d = accD.get(o.opp) ?? [0, 0];
      d[0] += o.w * (o.y - lg - (off.get(o.team) ?? 0));
      d[1] += o.w;
      accD.set(o.opp, d);
      // Tempo: båda lagen i observationen delar matchens tempo.
      const pc = accP.get(o.team) ?? [0, 0];
      pc[0] += o.w * (o.pace - lgPace - (pace.get(o.opp) ?? 0));
      pc[1] += o.w;
      accP.set(o.team, pc);
    }
    accO.forEach(([s, n], k) => off.set(k, (s + pr("off", k)) / (n + lambda)));
    accD.forEach(([s, n], k) => def.set(k, (s + pr("def", k)) / (n + lambda)));
    accP.forEach(([s, n], k) => pace.set(k, (s + pr("pace", k)) / (n + lambda)));
  }
  // Centrera så att snittlaget är 0 (ridge kan ge en liten drift).
  const center = (m: Map<number, number>) => {
    let s = 0;
    m.forEach((v) => (s += v));
    const mean = s / (m.size || 1);
    m.forEach((v, k) => m.set(k, v - mean));
  };
  center(off);
  center(def);
  center(pace);
  for (const k of weight.keys()) {
    teams.set(k, { off: off.get(k) ?? 0, def: def.get(k) ?? 0, pace: pace.get(k) ?? 0, weight: weight.get(k) ?? 0 });
  }
  return { ortg: lg, pace: lgPace, teams };
}

/** Rating för ett lag, eller snittlaget om det saknas. */
export function ratingOf(t: RatingTable, teamId: number): TeamRating {
  return t.teams.get(teamId) ?? { off: 0, def: 0, pace: 0, weight: 0 };
}

/** Förväntad ORtg för `team` mot `opp` (utan hemmaplan och vila). */
export function expectedOrtg(t: RatingTable, team: number, opp: number): number {
  return t.ortg + ratingOf(t, team).off + ratingOf(t, opp).def;
}
