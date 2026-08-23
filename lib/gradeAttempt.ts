// Retry bookkeeping for auto-grading.
//
// Every sync used to re-attempt every pending bet, so a bet nothing could ever
// settle — a niche market, a league with no result feed, a fixture that never
// matched — burned a lookup on every run, forever, and said nothing about why.
//
// Two things fix that: exponential backoff on repeated failure, and recording
// the reason where the UI can show it.

import type { PrismaClient, Prisma } from "@prisma/client";

/** Give up after this many failures; the bet stays pending for manual settling. */
export const MAX_GRADE_ATTEMPTS = 8;

/**
 * Wait after the nth failed attempt, in hours: 1, 2, 4, 8 … capped at 24.
 *
 * The cap matters more than the curve. Most failures are "the match has not
 * finished yet" or "the feed has not published it yet", and both resolve within
 * a day — an uncapped doubling would push a perfectly gradable bet weeks out.
 */
export function backoffHours(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(24, 2 ** (attempts - 1));
}

/**
 * A Prisma filter matching bets that are due for another attempt.
 *
 * Spread into a `where` alongside the caller's own conditions.
 */
export function retryDueFilter(now: Date = new Date()): Prisma.BetWhereInput {
  return {
    gradeAttempts: { lt: MAX_GRADE_ATTEMPTS },
    OR: [
      { gradeLastTriedAt: null },
      // 1 hour is the shortest backoff, so anything older than that is due for
      // at least its next attempt; the per-bet check below is the exact gate.
      { gradeLastTriedAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } },
    ],
  };
}

/** Is this bet's backoff window over? */
export function isRetryDue(
  bet: { gradeAttempts: number; gradeLastTriedAt: Date | null },
  now: Date = new Date()
): boolean {
  if (bet.gradeAttempts >= MAX_GRADE_ATTEMPTS) return false;
  if (!bet.gradeLastTriedAt) return true;
  const waitMs = backoffHours(bet.gradeAttempts) * 60 * 60 * 1000;
  return now.getTime() - bet.gradeLastTriedAt.getTime() >= waitMs;
}

/**
 * Record a failed attempt and why.
 *
 * The reason is the point: "marknaden kan inte räknas ur slutresultatet" in the
 * bet row is actionable, the same sentence buried in a details[] array the sync
 * response throws away is not.
 */
export async function noteGradeFailure(
  prisma: PrismaClient,
  betId: string,
  reason: string
): Promise<void> {
  await prisma.bet.update({
    where: { id: betId },
    data: {
      gradeAttempts: { increment: 1 },
      gradeLastTriedAt: new Date(),
      gradeBlockedReason: reason.slice(0, 300),
    },
  });
}

/** Clear the retry state once a bet settles. */
export async function clearGradeBlock(prisma: PrismaClient, betId: string): Promise<void> {
  await prisma.bet.update({
    where: { id: betId },
    data: { gradeAttempts: 0, gradeLastTriedAt: null, gradeBlockedReason: null },
  });
}
