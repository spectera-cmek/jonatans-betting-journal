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
export function projectMinutes(inputs: MinutesInput[], total = TEAM_MINUTES, cap = MAX_PLAYER_MINUTES): MinutesRow[] {
  const rows: MinutesRow[] = inputs.map((x) => ({
    ...x,
    minutes: x.override != null ? Math.max(0, Math.min(48, x.override)) : x.baseline * injuryFactor(x.injuryStatus),
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
