// Plain DTOs passed from server components / API to client components.
// Dates are serialized to ISO strings so they survive the server->client boundary.

import type { Outcome } from "./betting";

export interface BetDTO {
  id: string;
  placedAt: string;
  eventAt: string | null;
  sportKey: string | null;
  sport: string | null;
  league: string | null;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  eventKind: string;
  tournamentStage: string | null;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  betType: string;
  odds: number;
  closingOdds: number | null;
  stakeUnits: number;
  outcome: Outcome;
  profitUnits: number | null;
  externalRef: string | null;
  resultProvider: string | null;
  resultEventRef: string | null;
  bookmaker: string | null;
  tipster: string | null;
  notes: string | null;
  legs: string | null; // JSON-encoded accumulator legs (for the edit modal)
  gradedAt: string | null;
  createdAt: string;
  clvPct: number | null;
}

// Loose Prisma-row shape (avoids importing the generated client type here).
type BetRow = {
  id: string;
  placedAt: Date;
  eventAt: Date | null;
  sportKey: string | null;
  sport: string | null;
  league: string | null;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  eventKind: string;
  tournamentStage: string | null;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  betType: string;
  odds: number;
  closingOdds: number | null;
  stakeUnits: number;
  outcome: string;
  profitUnits: number | null;
  externalRef: string | null;
  resultProvider: string | null;
  resultEventRef: string | null;
  bookmaker: string | null;
  tipster: string | null;
  notes: string | null;
  legs: string | null;
  gradedAt: Date | null;
  createdAt: Date;
};

export function serializeBet(b: BetRow): BetDTO {
  return {
    id: b.id,
    placedAt: b.placedAt.toISOString(),
    eventAt: b.eventAt ? b.eventAt.toISOString() : null,
    sportKey: b.sportKey,
    sport: b.sport,
    league: b.league,
    event: b.event,
    homeTeam: b.homeTeam,
    awayTeam: b.awayTeam,
    market: b.market,
    marketCategory: b.marketCategory,
    marketScope: b.marketScope,
    eventKind: b.eventKind,
    tournamentStage: b.tournamentStage,
    selection: b.selection,
    selectionSide: b.selectionSide,
    line: b.line,
    betType: b.betType,
    odds: b.odds,
    closingOdds: b.closingOdds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    profitUnits: b.profitUnits,
    externalRef: b.externalRef,
    resultProvider: b.resultProvider,
    resultEventRef: b.resultEventRef,
    bookmaker: b.bookmaker,
    tipster: b.tipster,
    notes: b.notes,
    legs: b.legs,
    gradedAt: b.gradedAt ? b.gradedAt.toISOString() : null,
    createdAt: b.createdAt.toISOString(),
    clvPct:
      b.closingOdds && b.closingOdds > 1
        ? (b.odds / b.closingOdds - 1) * 100
        : null,
  };
}

// Compact row for list/calendar views — skips the heavy fields (notes, legs,
// teams, refs) so 8k+ rows stay a small payload. Keep in sync with the
// `select` in GET /api/bets?fields=list.
export interface BetListDTO {
  id: string;
  placedAt: string;
  eventAt: string | null;
  sport: string | null;
  league: string | null;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  eventKind: string;
  tournamentStage: string | null;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  betType: string;
  odds: number;
  stakeUnits: number;
  outcome: Outcome;
  profitUnits: number | null;
  bookmaker: string | null;
  resultProvider: string | null;
  resultEventRef: string | null;
}

export type BetListRow = Pick<
  BetRow,
  | "id" | "placedAt" | "eventAt" | "sport" | "league" | "event" | "homeTeam" | "awayTeam" | "market"
  | "marketCategory" | "marketScope" | "eventKind" | "tournamentStage"
  | "selection" | "selectionSide" | "line" | "betType" | "odds" | "stakeUnits"
  | "outcome" | "profitUnits" | "bookmaker" | "resultProvider" | "resultEventRef"
>;

export function serializeBetList(b: BetListRow): BetListDTO {
  return {
    id: b.id,
    placedAt: b.placedAt.toISOString(),
    eventAt: b.eventAt ? b.eventAt.toISOString() : null,
    sport: b.sport,
    league: b.league,
    event: b.event,
    homeTeam: b.homeTeam,
    awayTeam: b.awayTeam,
    market: b.market,
    marketCategory: b.marketCategory,
    marketScope: b.marketScope,
    eventKind: b.eventKind,
    tournamentStage: b.tournamentStage,
    selection: b.selection,
    selectionSide: b.selectionSide,
    line: b.line,
    betType: b.betType,
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    profitUnits: b.profitUnits,
    bookmaker: b.bookmaker,
    resultProvider: b.resultProvider,
    resultEventRef: b.resultEventRef,
  };
}

export interface BetSettlementDTO {
  id: string;
  betId: string;
  fromOutcome: Outcome;
  toOutcome: Outcome;
  fromProfitUnits: number | null;
  toProfitUnits: number | null;
  fromGradedAt: string | null;
  toGradedAt: string | null;
  source: string;
  reason: string | null;
  createdAt: string;
  revertedAt: string | null;
}

export interface SettingsDTO {
  username?: string; // present on GET (who's logged in), not echoed by PUT
  unitValue: number;
  currency: string;
  startingBankrollUnits: number;
  dailyStakeBudgetUnits: number | null;
  weeklyStakeBudgetUnits: number | null;
  hasOddsApiKey: boolean;
  hasTheStatsApiKey: boolean;
}
