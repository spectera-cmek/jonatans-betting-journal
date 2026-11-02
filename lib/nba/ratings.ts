// Spelartakter, lagens tempo och försvar — allt räknat bara på matcher före
// ett givet datum (asOf), så att backtesten aldrig ser framtiden.
//
// Spelare: takter per minut (2PA, 3PA, FTA, TOV, OREB) och träffprocent,
// viktade så att färska matcher väger tyngst och krympta mot positionens
// snitt. Lag: tempo (possessions per 48) och vad motståndarna brukar få till
// mot dem, i förhållande till ligasnittet.

import { DEFAULT_NBA_PARAMS, type NbaModelParams } from "./params";

export interface PlayerGameRow {
  gameId: number;
  /** Matchstart i ms. */
  t: number;
  playerId: number;
  teamId: number;
  position: string | null;
  minutes: number;
  fga2: number;
  fgm2: number;
  fga3: number;
  fgm3: number;
  fta: number;
  ftm: number;
  oreb: number;
  tov: number;
  /** Startade matchen (boxscore). Saknas i äldre testdata. */
  starter?: boolean;
  /** Defensiva returer och assist — för props. Saknas i äldre testdata. */
  dreb?: number;
  ast?: number;
  dnp: boolean;
  dnpReason: string | null;
}

export interface TeamGameRow {
  gameId: number;
  t: number;
  teamId: number;
  oppId: number;
  home: boolean;
  pts: number;
  fga2: number;
  fgm2: number;
  fga3: number;
  fgm3: number;
  fta: number;
  ftm: number;
  oreb: number;
  dreb: number;
  tov: number;
  /** Motståndarens defensiva returer — för OREB%. */
  oppDreb: number;
  /** 4 = ordinarie, 5+ = förlängning. */
  periods: number;
}

export interface History {
  /** Per spelare, nyast först. */
  players: Map<number, PlayerGameRow[]>;
  /** Per lag, nyast först. */
  teams: Map<number, TeamGameRow[]>;
  /** Alla lagrader, nyast först. */
  allTeamRows: TeamGameRow[];
  /** Alla spelarrader, nyast först. */
  allPlayerRows: PlayerGameRow[];
}

const byNewest = <T extends { t: number }>(a: T, b: T) => b.t - a.t;

export function buildHistory(playerRows: PlayerGameRow[], teamRows: TeamGameRow[]): History {
  const players = new Map<number, PlayerGameRow[]>();
  for (const r of playerRows) {
    const l = players.get(r.playerId);
    if (l) l.push(r);
    else players.set(r.playerId, [r]);
  }
  players.forEach((l) => l.sort(byNewest));
  const teams = new Map<number, TeamGameRow[]>();
  for (const r of teamRows) {
    const l = teams.get(r.teamId);
    if (l) l.push(r);
    else teams.set(r.teamId, [r]);
  }
  teams.forEach((l) => l.sort(byNewest));
  return { players, teams, allTeamRows: [...teamRows].sort(byNewest), allPlayerRows: [...playerRows].sort(byNewest) };
}

/** Första index med t < asOf i en lista sorterad nyast först. */
export function firstBefore<T extends { t: number }>(rows: T[], asOf: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t >= asOf) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Possessions och ligasnitt
// ---------------------------------------------------------------------------

/** Possessions för ett lag i en match: FGA + 0,44·FTA − OREB + TOV. */
export function possessions(r: Pick<TeamGameRow, "fga2" | "fga3" | "fta" | "oreb" | "tov">): number {
  return r.fga2 + r.fga3 + 0.44 * r.fta - r.oreb + r.tov;
}

/** Minuter som spelades: 48 + 5 per förlängning. */
export const gameMinutes = (periods: number) => 48 + 5 * Math.max(0, (periods || 4) - 4);

export interface OffenseProfile {
  /** Andel av "plays" (avslut eller turnover) per typ. Summerar till 1. */
  pTov: number;
  pFt: number;
  p3: number;
  p2: number;
  pct2: number;
  pct3: number;
  ftPct: number;
  orebPct: number;
}

export interface League extends OffenseProfile {
  /** Possessions per 48 minuter. */
  pace: number;
  /** Faktiska poäng per possession i ligan — simuleringens nivå kalibreras mot den. */
  ppp: number;
  /** Plays (avslut, straffsituationer, turnovers) per 240 spelarminuter. */
  playsPer240: number;
  /** Positionspriors per minut och träffprocent. */
  pos: Record<string, PlayerRates>;
  games: number;
}

export interface PlayerRates {
  /** Per minut. */
  a2: number;
  a3: number;
  fta: number;
  tov: number;
  oreb: number;
  dreb: number;
  ast: number;
  pct2: number;
  pct3: number;
  ftPct: number;
  /** Viktade minuter bakom skattningen (hur mycket data). */
  sample: number;
}

/** Plays per lagrad: avslut + straffsituationer + turnovers. */
function plays(fga2: number, fga3: number, fta: number, tov: number, ftsPerTrip: number) {
  return fga2 + fga3 + fta / ftsPerTrip + tov;
}

export function profileFromTotals(
  t: { fga2: number; fgm2: number; fga3: number; fgm3: number; fta: number; ftm: number; tov: number; oreb: number; orebChances: number },
  ftsPerTrip: number
): OffenseProfile {
  const n = plays(t.fga2, t.fga3, t.fta, t.tov, ftsPerTrip) || 1;
  return {
    pTov: t.tov / n,
    pFt: t.fta / ftsPerTrip / n,
    p3: t.fga3 / n,
    p2: t.fga2 / n,
    pct2: t.fga2 ? t.fgm2 / t.fga2 : 0.53,
    pct3: t.fga3 ? t.fgm3 / t.fga3 : 0.36,
    ftPct: t.fta ? t.ftm / t.fta : 0.78,
    orebPct: t.orebChances ? t.oreb / t.orebChances : 0.25,
  };
}

/** Ligasnitt ur alla lagmatcher inom `windowDays` före asOf. */
export function leagueAverages(h: History, asOf: number, p: NbaModelParams = DEFAULT_NBA_PARAMS, windowDays = 240): League {
  const from = asOf - windowDays * 864e5;
  const s = { fga2: 0, fgm2: 0, fga3: 0, fgm3: 0, fta: 0, ftm: 0, tov: 0, oreb: 0, orebChances: 0, poss: 0, min: 0, pts: 0, games: 0 };
  const rw = { w: 0, poss: 0, min: 0, pts: 0 };
  for (let i = firstBefore(h.allTeamRows, asOf); i < h.allTeamRows.length; i++) {
    const r = h.allTeamRows[i];
    if (r.t < from) break;
    s.fga2 += r.fga2;
    s.fgm2 += r.fgm2;
    s.fga3 += r.fga3;
    s.fgm3 += r.fgm3;
    s.fta += r.fta;
    s.ftm += r.ftm;
    s.tov += r.tov;
    s.oreb += r.oreb;
    s.orebChances += r.oreb + r.oppDreb;
    s.poss += possessions(r);
    s.min += gameMinutes(r.periods);
    s.pts += r.pts;
    s.games++;
    // Nivå och tempo viktas mot färska matcher (samma halveringstid som lagratingen),
    // så att modellen följer med när poängnivån ändras under säsongen.
    const w = Math.pow(0.5, (asOf - r.t) / 864e5 / p.ratingHalfLifeDays);
    rw.w += w;
    rw.poss += w * possessions(r);
    rw.min += w * gameMinutes(r.periods);
    rw.pts += w * r.pts;
  }
  const prof = s.games
    ? profileFromTotals(s, p.ftsPerTrip)
    : { pTov: 0.12, pFt: 0.1, p3: 0.33, p2: 0.45, pct2: 0.54, pct3: 0.36, ftPct: 0.78, orebPct: 0.25 };
  const pace = rw.min > 0 ? (rw.poss / rw.min) * 48 : 99;
  const ppp = rw.poss > 0 ? rw.pts / rw.poss : 1.14;
  // Lagens plays per 240 spelarminuter (= per match i ordinarie tid).
  const minutes = s.min * 5;
  const playsPer240 = minutes > 0 ? (plays(s.fga2, s.fga3, s.fta, s.tov, p.ftsPerTrip) / minutes) * 240 : 112;
  return { ...prof, pace, ppp, playsPer240, pos: positionPriors(h, asOf, from, prof), games: s.games };
}

function positionPriors(h: History, asOf: number, from: number, lg: OffenseProfile): Record<string, PlayerRates> {
  const acc: Record<string, { min: number; a2: number; m2: number; a3: number; m3: number; fta: number; ftm: number; tov: number; oreb: number; dreb: number; ast: number }> = {};
  for (let i = firstBefore(h.allPlayerRows, asOf); i < h.allPlayerRows.length; i++) {
    const r = h.allPlayerRows[i];
    if (r.t < from) break;
    if (r.minutes <= 0) continue;
    const k = r.position ?? "F";
    const a = (acc[k] ??= { min: 0, a2: 0, m2: 0, a3: 0, m3: 0, fta: 0, ftm: 0, tov: 0, oreb: 0, dreb: 0, ast: 0 });
    a.min += r.minutes;
    a.a2 += r.fga2;
    a.m2 += r.fgm2;
    a.a3 += r.fga3;
    a.m3 += r.fgm3;
    a.fta += r.fta;
    a.ftm += r.ftm;
    a.tov += r.tov;
    a.oreb += r.oreb;
    a.dreb += r.dreb ?? 0;
    a.ast += r.ast ?? 0;
  }
  const fallback: PlayerRates = { a2: 0.4, a3: 0.3, fta: 0.18, tov: 0.1, oreb: 0.07, dreb: 0.2, ast: 0.15, pct2: lg.pct2, pct3: lg.pct3, ftPct: lg.ftPct, sample: 0 };
  const out: Record<string, PlayerRates> = {};
  for (const k of ["G", "F", "C"]) {
    const a = acc[k];
    out[k] =
      a && a.min > 500
        ? {
            a2: a.a2 / a.min,
            a3: a.a3 / a.min,
            fta: a.fta / a.min,
            tov: a.tov / a.min,
            oreb: a.oreb / a.min,
            dreb: a.dreb > 0 ? a.dreb / a.min : 0.2,
            ast: a.ast > 0 ? a.ast / a.min : 0.15,
            pct2: a.a2 ? a.m2 / a.a2 : lg.pct2,
            pct3: a.a3 ? a.m3 / a.a3 : lg.pct3,
            ftPct: a.fta ? a.ftm / a.fta : lg.ftPct,
            sample: a.min,
          }
        : fallback;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spelare
// ---------------------------------------------------------------------------

/** Spelarens takter per minut, viktade och krympta mot positionens prior. */
export function playerRates(h: History, playerId: number, asOf: number, league: League, p: NbaModelParams = DEFAULT_NBA_PARAMS): PlayerRates {
  const rows = h.players.get(playerId) ?? [];
  let k = 0;
  const s = { min: 0, a2: 0, m2: 0, a3: 0, m3: 0, fta: 0, ftm: 0, tov: 0, oreb: 0, dreb: 0, ast: 0 };
  let pos: string | null = null;
  for (let i = firstBefore(rows, asOf); i < rows.length && k < 120; i++) {
    const r = rows[i];
    pos ??= r.position;
    if (r.minutes <= 0) continue;
    const w = Math.pow(0.5, k / p.playerHalfLifeGames);
    k++;
    s.min += w * r.minutes;
    s.a2 += w * r.fga2;
    s.m2 += w * r.fgm2;
    s.a3 += w * r.fga3;
    s.m3 += w * r.fgm3;
    s.fta += w * r.fta;
    s.ftm += w * r.ftm;
    s.tov += w * r.tov;
    s.oreb += w * r.oreb;
    s.dreb += w * (r.dreb ?? 0);
    s.ast += w * (r.ast ?? 0);
  }
  const prior = league.pos[pos ?? "F"] ?? league.pos.F;
  const pm = p.priorMinutes;
  const rate = (x: number, pr: number) => (x + pr * pm) / (s.min + pm);
  const pct = (m: number, a: number, pr: number, K: number) => (m + pr * K) / (a + K);
  return {
    a2: rate(s.a2, prior.a2),
    a3: rate(s.a3, prior.a3),
    fta: rate(s.fta, prior.fta),
    tov: rate(s.tov, prior.tov),
    oreb: rate(s.oreb, prior.oreb),
    dreb: rate(s.dreb, prior.dreb),
    ast: rate(s.ast, prior.ast),
    pct2: pct(s.m2, s.a2, prior.pct2, p.pct2PriorAtt),
    pct3: pct(s.m3, s.a3, prior.pct3, p.pct3PriorAtt),
    ftPct: pct(s.ftm, s.fta, prior.ftPct, p.ftPriorAtt),
    sample: s.min,
  };
}

// ---------------------------------------------------------------------------
// Lag: tempo och försvar
// ---------------------------------------------------------------------------

export interface TeamProfile {
  /** Possessions per 48, krympt mot ligan. */
  pace: number;
  /** Vad motståndarna fått till mot laget — samma form som en offensiv profil. */
  allowed: OffenseProfile;
  /** Senaste matchens start (ms) före asOf — för back-to-back. */
  lastGameT: number | null;
  games: number;
}

export function teamProfile(h: History, teamId: number, asOf: number, league: League, p: NbaModelParams = DEFAULT_NBA_PARAMS): TeamProfile {
  const rows = h.teams.get(teamId) ?? [];
  const start = firstBefore(rows, asOf);
  const s = { fga2: 0, fgm2: 0, fga3: 0, fgm3: 0, fta: 0, ftm: 0, tov: 0, oreb: 0, orebChances: 0 };
  let possW = 0;
  let minW = 0;
  let wSum = 0;
  let k = 0;
  for (let i = start; i < rows.length && k < 82; i++, k++) {
    const r = rows[i];
    const opp = oppRow(h, r);
    const w = Math.pow(0.5, k / p.teamHalfLifeGames);
    wSum += w;
    possW += w * possessions(r);
    minW += w * gameMinutes(r.periods);
    if (opp) {
      s.fga2 += w * opp.fga2;
      s.fgm2 += w * opp.fgm2;
      s.fga3 += w * opp.fga3;
      s.fgm3 += w * opp.fgm3;
      s.fta += w * opp.fta;
      s.ftm += w * opp.ftm;
      s.tov += w * opp.tov;
      s.oreb += w * opp.oreb;
      s.orebChances += w * (opp.oreb + r.dreb);
    }
  }
  const shrink = wSum / (wSum + p.teamShrinkGames);
  const rawPace = minW ? (possW / minW) * 48 : league.pace;
  const raw = s.fga2 + s.fga3 > 0 ? profileFromTotals(s, p.ftsPerTrip) : league;
  const mix = (a: number, b: number) => b + (a - b) * shrink;
  return {
    pace: mix(rawPace, league.pace),
    allowed: {
      pTov: mix(raw.pTov, league.pTov),
      pFt: mix(raw.pFt, league.pFt),
      p3: mix(raw.p3, league.p3),
      p2: mix(raw.p2, league.p2),
      pct2: mix(raw.pct2, league.pct2),
      pct3: mix(raw.pct3, league.pct3),
      ftPct: league.ftPct,
      orebPct: mix(raw.orebPct, league.orebPct),
    },
    lastGameT: start < rows.length ? rows[start].t : null,
    games: k,
  };
}

function oppRow(h: History, r: TeamGameRow): TeamGameRow | undefined {
  const l = h.teams.get(r.oppId);
  if (!l) return undefined;
  const i = firstBefore(l, r.t + 1);
  return l[i]?.gameId === r.gameId ? l[i] : l.find((x) => x.gameId === r.gameId);
}
