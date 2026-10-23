// Shared sync logic used by both the API routes and the CLI script.
// Grades finished bets from ESPN's free scoreboard; closing odds for CLV come
// from the local OddsPortal scrape. No API keys needed.

import { prisma } from "./db";
import { gradeBet } from "./grading";
import { espnPath, fetchFinalScore } from "./scores";
import { settleBet } from "./settlement";
import { captureClosingFromOddsPortal } from "./clvOddsPortalBatch";

export interface SyncResult {
  ok: boolean;
  message: string;
  linked: number;
  graded: number;
  closingUpdated: number;
  details: string[];
}

const CLV_WINDOW_DAYS = 90;
/** Keep each serverless sync under Vercel’s timeout (504). */
const SYNC_GRADE_LIMIT = 25;
const SYNC_DEADLINE_MS = 45_000;

/**
 * Auto-grade pending structured (h2h/totals/spreads) single bets from the real
 * final score, fetched from ESPN's free, keyless scoreboard endpoints. Works
 * without any API key. Imported rich-market accumulators won't qualify (their
 * market isn't h2h/totals/spreads) and are left for the PDF import / manual W/L.
 */
export async function runGradeByScores(
  opts: { limit?: number; deadlineMs?: number; source?: "espn" | "cron" } = {}
): Promise<SyncResult> {
  const details: string[] = [];
  const limit = opts.limit ?? SYNC_GRADE_LIMIT;
  const deadline = opts.deadlineMs ?? Date.now() + SYNC_DEADLINE_MS;

  const pending = await prisma.bet.findMany({
    where: {
      outcome: "pending",
      market: { in: ["h2h", "totals", "spreads"] },
      eventAt: { not: null },
      betType: "single",
      eventKind: "match",
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
    },
    orderBy: { eventAt: "asc" },
    take: limit,
  });

  if (pending.length === 0) {
    return { ok: true, message: "Inga pending bets att rätta via resultat.", linked: 0, graded: 0, closingUpdated: 0, details };
  }

  let graded = 0;
  for (const bet of pending) {
    if (Date.now() > deadline) {
      details.push("Timeout-skydd: avbryter ESPN-rättning — kör synk igen.");
      break;
    }
    const path = espnPath(bet.sport, bet.league);
    if (!path) {
      details.push(`${bet.event}: okänd liga för resultat-uppslag`);
      continue;
    }
    if (!bet.homeTeam || !bet.awayTeam) {
      details.push(`${bet.event}: saknar lagnamn (home/away)`);
      continue;
    }

    let score;
    try {
      score = await fetchFinalScore(
        path,
        new Date(bet.eventAt!),
        bet.homeTeam,
        bet.awayTeam,
        bet.resultProvider === "espn" ? bet.resultEventRef : null
      );
    } catch (e) {
      details.push(`${bet.event}: ${(e as Error).message}`);
      continue;
    }
    if (!score) {
      details.push(`${bet.event}: inget färdigspelat resultat hittat ännu`);
      continue;
    }
    if (score.wentToExtraTime) {
      details.push(`${bet.event}: förlängning/straffar — kräver manuell kontroll av 90-minutersmarknaden`);
      continue;
    }

    const outcome = gradeBet(
      { market: bet.market, selectionSide: bet.selectionSide, line: bet.line },
      score
    );
    if (!outcome) {
      details.push(`${bet.event}: marknaden kan inte auto-rättas`);
      continue;
    }

    try {
      const result = await settleBet(prisma, {
        betId: bet.id,
        outcome,
        source: opts.source ?? "espn",
        reason: `${score.homeScore}-${score.awayScore} via ESPN`,
      });
      if (result.changed) graded += 1;
      details.push(`${bet.event}: ${score.homeScore}-${score.awayScore} -> ${outcome}`);
    } catch (error) {
      details.push(`${bet.event}: ${(error as Error).message}`);
    }
  }

  if (graded > 0) {
    await prisma.syncLog.create({
      data: { kind: "grade", summary: `Score-graded ${graded} bet(s).` },
    });
  }

  return {
    ok: true,
    message: `Rättade ${graded} bet(s) via resultat.`,
    linked: 0,
    graded,
    closingUpdated: 0,
    details,
  };
}

/**
 * OddsPortal batch scrape for featured markets (local/CLI only — needs Playwright).
 */
export async function runClosingFromOddsPortal(
  opts: {
    limit?: number;
    sinceDays?: number;
    dryRun?: boolean;
    postKickoffOnly?: boolean;
  } = {}
): Promise<SyncResult> {
  const result = await captureClosingFromOddsPortal({
    limit: opts.limit ?? 50,
    sinceDays: opts.sinceDays ?? CLV_WINDOW_DAYS,
    dryRun: opts.dryRun,
    postKickoffOnly: opts.postKickoffOnly,
  });

  if (result.updated > 0 && !opts.dryRun) {
    await prisma.syncLog.create({
      data: {
        kind: "closing",
        summary: `OddsPortal scrape closing for ${result.updated} bet(s).`,
      },
    });
  }

  return {
    ok: result.updated > 0 || result.failed === 0,
    message: `OddsPortal: ${result.updated} closing (${result.failed} misslyckade av ${result.attempted}).`,
    linked: 0,
    graded: 0,
    closingUpdated: result.updated,
    details: result.details,
  };
}

/** ESPN grading, batched for serverless. Same as the nightly cron job. */
export async function runFullSync(): Promise<SyncResult> {
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const scores = await runGradeByScores({ limit: SYNC_GRADE_LIMIT, deadlineMs: deadline });
  const suffix = scores.graded >= SYNC_GRADE_LIMIT ? " Kör synk igen för nästa batch." : "";
  return {
    ...scores,
    message: scores.graded ? `Synk klar: ${scores.graded} rättade.${suffix}` : "Synk klar — inget att rätta.",
  };
}
