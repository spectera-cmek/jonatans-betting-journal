import type { PrismaClient } from "@prisma/client";
import { gradeBet } from "./grading";
import { espnPath, fetchFinalScore } from "./scores";
import {
  fetchWorldCupData,
  findWorldCupMatchForBet,
  type WorldCupMatch,
} from "./worldCup";
import { VM_2026_LEAGUE } from "./betTaxonomy";
import type { Outcome } from "./betting";

export type GradingReadiness = "ready" | "waiting" | "manual" | "unmatched";

export interface GradingSuggestion {
  betId: string;
  event: string;
  selection: string;
  eventAt: string | null;
  league: string | null;
  marketCategory: string | null;
  readiness: GradingReadiness;
  suggestedOutcome: Outcome | null;
  reason: string;
  score: string | null;
  source: "espn" | null;
  resultEventRef: string | null;
}

function manualReason(bet: {
  betType: string;
  eventKind: string;
  market: string;
  marketScope: string | null;
}): string | null {
  if (bet.betType === "accumulator") return "Ackumulator: kontrollera varje ben och eventuell void/payout.";
  if (bet.eventKind === "outright") return "Turneringsspel/future kräver turneringsutfall.";
  if (bet.marketScope === "player") return "Spelarprop kräver verifierad spelarstatistik.";
  if (!["h2h", "totals", "spreads"].includes(bet.market))
    return "Marknaden kan inte räknas från enbart slutresultatet.";
  return null;
}

function worldCupMatch(
  bet: {
    resultProvider: string | null;
    resultEventRef: string | null;
    eventAt: Date | null;
    homeTeam: string | null;
    awayTeam: string | null;
    event: string;
  },
  matches: WorldCupMatch[]
) {
  if (bet.resultProvider === "espn" && bet.resultEventRef) {
    return matches.find((match) => match.id === bet.resultEventRef) ?? null;
  }
  return findWorldCupMatchForBet(bet, matches);
}

export async function buildGradingQueue(
  prisma: PrismaClient,
  userId: string,
  options: { league?: string; limit?: number; ids?: string[] } = {}
): Promise<GradingSuggestion[]> {
  const bets = await prisma.bet.findMany({
    where: {
      userId,
      outcome: "pending",
      ...(options.league ? { league: options.league } : {}),
      ...(options.ids?.length ? { id: { in: options.ids } } : {}),
    },
    orderBy: [{ eventAt: "asc" }, { placedAt: "asc" }],
    take: options.limit ?? 100,
  });

  const needsWorldCup = bets.some((bet) => bet.league === VM_2026_LEAGUE);
  const worldCup = needsWorldCup ? await fetchWorldCupData() : null;
  const suggestions: GradingSuggestion[] = [];

  for (const bet of bets) {
    const base = {
      betId: bet.id,
      event: bet.event,
      selection: bet.selection,
      eventAt: bet.eventAt?.toISOString() ?? null,
      league: bet.league,
      marketCategory: bet.marketCategory,
    };
    const needsManual = manualReason(bet);
    if (needsManual) {
      suggestions.push({
        ...base,
        readiness: "manual",
        suggestedOutcome: null,
        reason: needsManual,
        score: null,
        source: null,
        resultEventRef: bet.resultEventRef,
      });
      continue;
    }
    if (!bet.eventAt || !bet.homeTeam || !bet.awayTeam) {
      suggestions.push({
        ...base,
        readiness: "unmatched",
        suggestedOutcome: null,
        reason: "Saknar matchtid eller strukturerade hemma-/bortalag.",
        score: null,
        source: null,
        resultEventRef: bet.resultEventRef,
      });
      continue;
    }

    let score: { homeScore: number; awayScore: number; wentToExtraTime?: boolean } | null = null;
    let resultEventRef = bet.resultEventRef;
    if (bet.league === VM_2026_LEAGUE && worldCup) {
      const match = worldCupMatch(bet, worldCup.matches);
      if (!match) {
        suggestions.push({
          ...base,
          readiness: "unmatched",
          suggestedOutcome: null,
          reason: "Kunde inte koppla betet entydigt till en VM-match.",
          score: null,
          source: "espn",
          resultEventRef,
        });
        continue;
      }
      resultEventRef = match.id;
      if (!match.completed || match.homeScore === null || match.awayScore === null) {
        suggestions.push({
          ...base,
          readiness: "waiting",
          suggestedOutcome: null,
          reason: `${match.stageLabel}: ${match.statusText}`,
          score: match.status === "live" ? `${match.homeScore ?? 0}–${match.awayScore ?? 0}` : null,
          source: "espn",
          resultEventRef,
        });
        continue;
      }
      score = {
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        wentToExtraTime: match.wentToExtraTime,
      };
    } else {
      const path = espnPath(bet.sport, bet.league);
      if (path) {
        score = await fetchFinalScore(
          path,
          bet.eventAt,
          bet.homeTeam,
          bet.awayTeam,
          bet.resultProvider === "espn" ? bet.resultEventRef : null
        );
      }
      if (!path || !score) {
        suggestions.push({
          ...base,
          readiness: "waiting",
          suggestedOutcome: null,
          reason: path ? "Inget färdigspelat ESPN-resultat hittat ännu." : "Ligan saknar resultatkoppling.",
          score: null,
          source: path ? "espn" : null,
          resultEventRef,
        });
        continue;
      }
    }

    if (score.wentToExtraTime) {
      suggestions.push({
        ...base,
        readiness: "manual",
        suggestedOutcome: null,
        reason: "Matchen gick till förlängning/straffar; kontrollera 90-minutersmarknaden.",
        score: `${score.homeScore}–${score.awayScore}`,
        source: "espn",
        resultEventRef,
      });
      continue;
    }

    const outcome = gradeBet(
      { market: bet.market, selectionSide: bet.selectionSide, line: bet.line },
      score
    );
    suggestions.push({
      ...base,
      readiness: outcome ? "ready" : "manual",
      suggestedOutcome: outcome,
      reason: outcome
        ? `${score.homeScore}–${score.awayScore} ger ${outcome}.`
        : "Marknad/sida/linje räcker inte för säker automatisk rättning.",
      score: `${score.homeScore}–${score.awayScore}`,
      source: "espn",
      resultEventRef,
    });
  }
  return suggestions;
}
