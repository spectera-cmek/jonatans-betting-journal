// Från spelare och minuter till en simulerad match.
//
//   spelarnas takter × förväntade minuter  → lagets offensiva profil
//   justerad mot motståndarens försvar     → profil i just den här matchen
//   tempo från båda lagen                  → antal possessions
//   hemmaplan / back-to-back               → logit-tillägg på träffprocent

import { DEFAULT_NBA_PARAMS, type NbaModelParams } from "./params";
import {
  leagueAverages,
  playerRates,
  profileFromTotals,
  teamProfile,
  type History,
  type League,
  type OffenseProfile,
  type TeamProfile,
} from "./ratings";
import { expectedPpp, logit, prepare, sigmoid, simulateGame, summarize, type GameSimInput, type SimResult, type SimSummary, type TeamSimInput } from "./sim";

export interface LineupEntry {
  playerId: number;
  minutes: number;
}

export interface TeamOffense extends OffenseProfile {
  /** Spelarnas samlade plays per 240 minuter delat med ligans — under 1 = för få avslutare. */
  usageRatio: number;
}

/** Lagets offensiva profil ur spelarnas takter, viktade med minuterna. */
export function teamOffense(h: History, lineup: LineupEntry[], asOf: number, league: League, p: NbaModelParams = DEFAULT_NBA_PARAMS): TeamOffense {
  const s = { fga2: 0, fgm2: 0, fga3: 0, fgm3: 0, fta: 0, ftm: 0, tov: 0, oreb: 0, orebChances: 0 };
  for (const e of lineup) {
    if (!(e.minutes > 0)) continue;
    const r = playerRates(h, e.playerId, asOf, league, p);
    const m = e.minutes;
    s.fga2 += m * r.a2;
    s.fgm2 += m * r.a2 * r.pct2;
    s.fga3 += m * r.a3;
    s.fgm3 += m * r.a3 * r.pct3;
    s.fta += m * r.fta;
    s.ftm += m * r.fta * r.ftPct;
    s.tov += m * r.tov;
    s.oreb += m * r.oreb;
  }
  if (s.fga2 + s.fga3 <= 0) return { ...league, usageRatio: 1 };
  s.orebChances = s.fga2 - s.fgm2 + (s.fga3 - s.fgm3);
  const minutes = lineup.reduce((a, e) => a + Math.max(0, e.minutes), 0) || 240;
  const lineupPlays = ((s.fga2 + s.fga3 + s.fta / p.ftsPerTrip + s.tov) / minutes) * 240;
  // Spelarnas OREB per minut kommer från deras egna lag — krymp mot ligan
  // så att andelen inte drar iväg när missarna är få.
  const prof = profileFromTotals(s, p.ftsPerTrip);
  prof.orebPct = (s.oreb + league.orebPct * 40) / (s.orebChances + 40);
  return { ...prof, usageRatio: league.playsPer240 > 0 ? lineupPlays / league.playsPer240 : 1 };
}

/** Offensiv profil justerad mot vad motståndaren brukar släppa till. */
export function adjustForDefense(off: OffenseProfile, allowed: OffenseProfile, league: League): OffenseProfile {
  const r = (a: number, b: number) => (b > 0 ? a / b : 1);
  const pTov = off.pTov * r(allowed.pTov, league.pTov);
  const pFt = off.pFt * r(allowed.pFt, league.pFt);
  const p3 = off.p3 * r(allowed.p3, league.p3);
  const p2 = off.p2 * r(allowed.p2, league.p2);
  const sum = pTov + pFt + p3 + p2 || 1;
  const shift = (o: number, a: number, l: number) => sigmoid(logit(o) + logit(a) - logit(l));
  return {
    pTov: pTov / sum,
    pFt: pFt / sum,
    p3: p3 / sum,
    p2: p2 / sum,
    pct2: shift(off.pct2, allowed.pct2, league.pct2),
    pct3: shift(off.pct3, allowed.pct3, league.pct3),
    ftPct: off.ftPct,
    orebPct: shift(off.orebPct, allowed.orebPct, league.orebPct),
  };
}

/**
 * Nivåkalibrering: det logit-tillägg på träffprocenten som får ligasnittets
 * profil att ge ligans faktiska poäng per possession i simuleringen.
 * Possession-modellen saknar några poängkällor (and-ones, returer på missade
 * straffar), så utan den hamnar totalen några poäng för lågt.
 */
const levelCache = new WeakMap<League, number>();
export function levelLogit(league: League, ftsPerTrip: number): number {
  const hit = levelCache.get(league);
  if (hit != null) return hit;
  const prep = prepare({ ...league, shotLogit: 0 });
  const ppp = (d: number) => expectedPpp(prep, sigmoid(prep.l2 + d), sigmoid(prep.l3 + d), ftsPerTrip);
  let lo = -0.5;
  let hi = 0.5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ppp(mid) < league.ppp) lo = mid;
    else hi = mid;
  }
  const d = (lo + hi) / 2;
  levelCache.set(league, d);
  return d;
}

export interface GameContext {
  homeId: number;
  awayId: number;
  /** Matchstart i ms — modellen ser bara matcher före den. */
  t: number;
  neutral?: boolean;
  homeLineup: LineupEntry[];
  awayLineup: LineupEntry[];
}

export interface Projection {
  input: GameSimInput;
  sim: SimResult;
  summary: SimSummary;
  homeProfile: TeamProfile;
  awayProfile: TeamProfile;
  homeB2B: boolean;
  awayB2B: boolean;
}

const B2B_MS = 30 * 3600e3;

export function buildSimInput(h: History, ctx: GameContext, p: NbaModelParams = DEFAULT_NBA_PARAMS, league?: League) {
  const lg = league ?? leagueAverages(h, ctx.t, p);
  const hp = teamProfile(h, ctx.homeId, ctx.t, lg, p);
  const ap = teamProfile(h, ctx.awayId, ctx.t, lg, p);
  const homeRaw = teamOffense(h, ctx.homeLineup, ctx.t, lg, p);
  const awayRaw = teamOffense(h, ctx.awayLineup, ctx.t, lg, p);
  const homeOff = adjustForDefense(homeRaw, ap.allowed, lg);
  const awayOff = adjustForDefense(awayRaw, hp.allowed, lg);
  const usage = (r: number) => p.usageK * Math.log(Math.min(1.2, Math.max(0.8, r)));
  const homeB2B = hp.lastGameT != null && ctx.t - hp.lastGameT < B2B_MS;
  const awayB2B = ap.lastGameT != null && ctx.t - ap.lastGameT < B2B_MS;
  const hca = ctx.neutral ? 0 : p.homeLogit;
  const level = levelLogit(lg, p.ftsPerTrip) + p.effLogit;
  const home: TeamSimInput = { ...homeOff, shotLogit: level + hca + usage(homeRaw.usageRatio) + (homeB2B ? p.b2bLogit : 0) };
  const away: TeamSimInput = { ...awayOff, shotLogit: level - hca + usage(awayRaw.usageRatio) + (awayB2B ? p.b2bLogit : 0) };
  const input: GameSimInput = {
    home,
    away,
    possMean: (hp.pace * ap.pace) / lg.pace,
    possSd: p.possSd,
    nightSigma: p.nightSigma,
    sharedSigma: p.sharedSigma,
    rubberBand: p.rubberBand,
    ftsPerTrip: p.ftsPerTrip,
    sims: p.sims,
    seed: (ctx.homeId * 7919 + ctx.awayId * 104729 + Math.floor(ctx.t / 864e5)) >>> 0,
  };
  return { input, league: lg, homeProfile: hp, awayProfile: ap, homeB2B, awayB2B, homeUsage: homeRaw.usageRatio, awayUsage: awayRaw.usageRatio };
}

export function projectGame(h: History, ctx: GameContext, p: NbaModelParams = DEFAULT_NBA_PARAMS, league?: League): Projection {
  const b = buildSimInput(h, ctx, p, league);
  const sim = simulateGame(b.input);
  return {
    input: b.input,
    sim,
    summary: summarize(sim),
    homeProfile: b.homeProfile,
    awayProfile: b.awayProfile,
    homeB2B: b.homeB2B,
    awayB2B: b.awayB2B,
  };
}
