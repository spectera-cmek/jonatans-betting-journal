// Förväntade minuter per spelare inför en match:
//   1. snittet av spelarens senaste framträdanden (coach's decision = 0 min,
//      skadefrånvaro räknas inte),
//   2. ESPN:s skadelista (Out = 0, Questionable = hälften …),
//   3. dina manuella ändringar, som alltid vinner,
// och till sist omfördelning så att laget får 240 minuter.

import { firstBefore, type History } from "./ratings";
import { MAX_PLAYER_MINUTES, TEAM_MINUTES } from "./params";

/** Andel av grundminuterna per skadestatus. */
export const INJURY_FACTOR: Record<string, number> = {
  out: 0,
  doubtful: 0.15,
  questionable: 0.5,
  "day-to-day": 0.6,
  probable: 0.9,
};

export function injuryFactor(status: string | null | undefined): number {
  if (!status) return 1;
  const f = INJURY_FACTOR[status.trim().toLowerCase()];
  return f ?? 1;
}

/** Skadad/frånvarande — en sådan match säger inget om rollen. */
const ABSENT = /injur|illness|not with team|suspend|personal|rest|g league|conditioning/i;

export interface MinutesInput {
  playerId: number;
  name: string;
  position: string | null;
  baseline: number;
  /** Matcher bakom grundminuterna. */
  games: number;
  injuryStatus: string | null;
  injuryDetail: string | null;
  /** Manuell ändring (0 = spelar inte), eller null. */
  override: number | null;
}

/**
 * Utklassningsrisk, mätt på grundserien 2025–26: vid stor spread spelar
 * startarna (grund ≥ 28 min) mindre — 100 % vid |spread| < 4, 98 % vid 8–12,
 * 94,6 % vid 12+ (n = 6 310). Modell: 1 − 0,006 · max(0, |spread| − 6).
 * Bänken får minuterna som blir över. Minutfelet för startare: 4,54 → 4,47.
 *
 * Prövat och bortvalt: färre minuter första matchen tillbaka efter ≥ 3
 * missade (de spelar 92 % av grundminuterna) — efter omfördelningen till 240
 * blev felet marginellt större, så det används inte.
 */
export const BLOWOUT_PER_POINT = 0.006;
export const BLOWOUT_FROM = 6;
export const STARTER_MINUTES = 28;

/**
 * Grundminuter när startfemman är känd: spelarens snitt i samma roll (startare
 * eller bänk) de senaste 10 matcherna i den rollen, vägt mot vanliga
 * grundminuter efter hur mycket data det finns. Mätt på grundserien 2025–26:
 * minutfelet 5,10 → 4,76; för spelare som bytt roll 5,71 → 4,84.
 */
export function roleBaseline(h: History, playerId: number, asOf: number, starter: boolean, baseline: number): number {
  const rows = h.players.get(playerId) ?? [];
  const i0 = firstBefore(rows, asOf);
  const same = rows
    .slice(i0, i0 + 25)
    .filter((r) => r.minutes > 0 && !!r.starter === starter)
    .slice(0, 10);
  if (same.length < 3) return baseline;
  const avg = same.reduce((a, r) => a + r.minutes, 0) / same.length;
  const w = same.length / (same.length + 3);
  return w * avg + (1 - w) * baseline;
}

export function blowoutFactor(absSpread: number | null | undefined, baseline: number): number {
  if (absSpread == null || baseline < STARTER_MINUTES) return 1;
  return Math.max(0.85, 1 - BLOWOUT_PER_POINT * Math.max(0, absSpread - BLOWOUT_FROM));
}


export interface MinutesRow extends MinutesInput {
  /** Efter skada, override och omfördelning. */
  minutes: number;
}

/**
 * Grundminuter för lagets spelare: de som senast spelade för laget och har
 * spelat inom `activeDays`. Viktat snitt av de senaste `lookback`
 * framträdandena, där nyare matcher väger tyngre.
 */
export function baselineMinutes(
  h: History,
  teamId: number,
  asOf: number,
  opts: { lookback?: number; halfLife?: number; activeDays?: number } = {}
): Array<{ playerId: number; position: string | null; baseline: number; games: number }> {
  const lookback = opts.lookback ?? 10;
  const halfLife = opts.halfLife ?? 4;
  const activeFrom = asOf - (opts.activeDays ?? 45) * 864e5;
  const teamRows = h.teams.get(teamId) ?? [];
  // Lagets senaste matcher — en spelare som inte stått i boxscoren i någon av
  // dem har troligen lämnat eller är långtidsskadad.
  const ti = firstBefore(teamRows, asOf);
  const recentTeamGames = new Set(teamRows.slice(ti, ti + 20).map((r) => r.gameId));
  const out: Array<{ playerId: number; position: string | null; baseline: number; games: number }> = [];
  h.players.forEach((rows, playerId) => {
    const i0 = firstBefore(rows, asOf);
    const last = rows[i0];
    if (!last || last.teamId !== teamId || last.t < activeFrom) return;
    let wSum = 0;
    let mSum = 0;
    let n = 0;
    for (let i = i0; i < rows.length && n < lookback; i++) {
      const r = rows[i];
      if (r.dnp && ABSENT.test(r.dnpReason ?? "")) continue;
      const w = Math.pow(0.5, n / halfLife);
      wSum += w;
      mSum += w * r.minutes;
      n++;
    }
    if (!n) return;
    const inRotation = rows.slice(i0, i0 + 3).some((r) => recentTeamGames.has(r.gameId));
    if (!inRotation) return;
    out.push({ playerId, position: last.position, baseline: mSum / wSum, games: n });
  });
  return out.sort((a, b) => b.baseline - a.baseline);
}

/**
 * Lägger på skador och overrides och skalar de fria spelarna så att laget
 * får exakt 240 minuter, med tak per spelare.
 */
export function projectMinutes(
  inputs: MinutesInput[],
  total = TEAM_MINUTES,
  cap = MAX_PLAYER_MINUTES,
  opts: { absSpread?: number | null } = {}
): MinutesRow[] {
  const rows: MinutesRow[] = inputs.map((x) => ({
    ...x,
    minutes:
      x.override != null
        ? Math.max(0, Math.min(48, x.override))
        : x.baseline * injuryFactor(x.injuryStatus) * blowoutFactor(opts.absSpread, x.baseline),
  }));
  const fixed = new Set(rows.filter((r) => r.override != null).map((r) => r.playerId));
  for (let iter = 0; iter < 12; iter++) {
    const fixedSum = rows.filter((r) => fixed.has(r.playerId)).reduce((s, r) => s + r.minutes, 0);
    const free = rows.filter((r) => !fixed.has(r.playerId) && r.minutes > 0);
    const freeSum = free.reduce((s, r) => s + r.minutes, 0);
    const target = Math.max(0, total - fixedSum);
    if (!free.length || freeSum <= 0) break;
    const k = target / freeSum;
    let capped = false;
    for (const r of free) {
      r.minutes *= k;
      if (r.minutes > cap) {
        r.minutes = cap;
        fixed.add(r.playerId);
        capped = true;
      }
    }
    if (!capped) break;
  }
  return rows.map((r) => ({ ...r, minutes: Math.round(r.minutes * 10) / 10 }));
}

/**
 * Lagets "normala" uppställning under perioden lagratingen bygger på:
 * grundminuter × andelen av lagets senaste `n` matcher spelaren faktiskt
 * spelade, omfördelat till 240. En stjärna som varit skadad i tre veckor finns
 * alltså bara delvis med här — ratingen har redan räknat med att han saknats.
 */
export function baseLineup(h: History, teamId: number, asOf: number, n = 15): Array<{ playerId: number; minutes: number }> {
  const teamRows = h.teams.get(teamId) ?? [];
  const ti = firstBefore(teamRows, asOf);
  const recent = teamRows.slice(ti, ti + n).map((r) => r.gameId);
  if (!recent.length) return [];
  const recentSet = new Set(recent);
  const base = baselineMinutes(h, teamId, asOf, { activeDays: 120 });
  const inputs: MinutesInput[] = base.map((b) => {
    const rows = h.players.get(b.playerId) ?? [];
    let played = 0;
    for (const r of rows) if (recentSet.has(r.gameId) && r.minutes > 0) played++;
    return {
      playerId: b.playerId,
      name: "",
      position: b.position,
      baseline: b.baseline * (played / recent.length),
      games: b.games,
      injuryStatus: null,
      injuryDetail: null,
      override: null,
    };
  });
  return projectMinutes(inputs)
    .filter((r) => r.minutes > 0)
    .map((r) => ({ playerId: r.playerId, minutes: r.minutes }));
}
