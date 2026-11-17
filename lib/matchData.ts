// Gemensam form för matchdata från statistikkällorna (ESPN, NHL:s API,
// Sofascore). Varje källa översätter sitt svar hit, så att rättningen i
// lib/propsGrading.ts inte behöver veta varifrån datan kom.
//
// Statistiknycklarna följer Sofascores namn (cornerKicks, totalShotsOnGoal,
// onTargetScoringAttempt, points …) — det var den första källan, och
// mappningstabellen i propsGrading.ts är skriven mot dem. Andra källor
// döper om sina fält till samma namn.

export type MatchStatus = "scheduled" | "live" | "finished" | "postponed" | "cancelled";

export interface MatchTeam {
  id: number;
  name: string;
  shortName: string | null;
}

export interface MatchEvent {
  /** Källans id för matchen (ESPN-, NHL- eller Sofascore-id). */
  id: number;
  startAt: Date;
  status: MatchStatus;
  /** Källans egen statustext, t.ex. "AET" — för loggar. */
  statusDescription: string | null;
  homeTeam: MatchTeam;
  awayTeam: MatchTeam;
  /** Mål efter ordinarie tid (fotboll); null när bara slutresultatet efter förlängning är känt. */
  homeScore: number | null;
  awayScore: number | null;
  /** Slutresultatet inklusive förlängning. */
  homeScoreFinal: number | null;
  awayScoreFinal: number | null;
  tournamentName: string | null;
  uniqueTournamentId: number | null;
  seasonId: number | null;
  round: number | null;
}

export interface StatPair {
  home: number;
  away: number;
}

export interface PlayerLine {
  playerId: number;
  name: string;
  shortName: string | null;
  side: "home" | "away";
  substitute: boolean;
  /** Källan vet säkert om spelaren var med (ESPN, NHL). Saknas: härleds ur statistiken. */
  played?: boolean;
  /** Bara numeriska värden, platta. */
  stats: Record<string, number>;
}

export interface Lineups {
  confirmed: boolean;
  players: PlayerLine[];
}

/** Finns nyckeln hos någon spelare i matchen? Om inte vet vi inte om fältet finns alls. */
export function hasStatKey(lineups: Lineups, key: string): boolean {
  return lineups.players.some((p) => key in p.stats);
}

/**
 * Spelade spelaren? Källans eget besked först. Annars: fotboll har
 * minutesPlayed, basket secondsPlayed, hockey timeOnIce (sekunder). En
 * avbytare utan någon statistik alls kom inte in.
 */
export function playerPlayed(p: PlayerLine): boolean {
  if (p.played !== undefined) return p.played;
  for (const key of ["minutesPlayed", "secondsPlayed", "timeOnIce"]) {
    if (key in p.stats) return p.stats[key] > 0;
  }
  return !p.substitute || Object.keys(p.stats).length > 0;
}
