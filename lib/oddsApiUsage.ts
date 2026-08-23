// Credit bookkeeping for The Odds API.
//
// Kept in its own module, away from lib/oddsApi.ts, on purpose: that file is
// pure (no Prisma, no DB) and several unit tests import it. The client reaches
// this module through a dynamic import that only fires on a real HTTP call, so
// a test that never hits the network never pulls Prisma in.

import { prisma } from "./db";
import type { OddsApiQuota } from "./oddsApi";

/** Endpoints we bill against the monthly quota. */
export type OddsApiEndpoint =
  | "sports"
  | "events"
  | "odds"
  | "event-odds"
  | "historical-events"
  | "historical-event-odds"
  | "scores";

/**
 * Persist what a call actually cost.
 *
 * `x-requests-last` is the only honest number available: a call with three
 * markets in one region costs three, and predicting that from the request is
 * exactly the kind of arithmetic that silently drifts. Never throws — a failed
 * usage write must not take down the odds call it was measuring.
 */
export async function recordOddsApiUsage(
  endpoint: OddsApiEndpoint,
  quota: OddsApiQuota,
  sportKey?: string
): Promise<void> {
  if (quota.last == null) return; // header missing — nothing measured
  try {
    await prisma.oddsApiUsage.create({
      data: {
        endpoint,
        sportKey: sportKey ?? null,
        credits: Math.round(quota.last),
        remaining: quota.remaining == null ? null : Math.round(quota.remaining),
      },
    });
  } catch {
    // Bookkeeping is best-effort by design.
  }
}

export interface OddsApiCreditStatus {
  /** Credits left this period, from the most recent call's headers. */
  remaining: number | null;
  /** When that reading was taken. */
  asOf: Date | null;
  /** Credits spent over the last 30 days, summed from our own log. */
  spentLast30Days: number;
  /** Calls made over the last 30 days. */
  callsLast30Days: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Current credit picture for the settings screen. */
export async function oddsApiCreditStatus(): Promise<OddsApiCreditStatus> {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [latest, agg] = await Promise.all([
    prisma.oddsApiUsage.findFirst({
      where: { remaining: { not: null } },
      orderBy: { ranAt: "desc" },
      select: { remaining: true, ranAt: true },
    }),
    prisma.oddsApiUsage.aggregate({
      where: { ranAt: { gte: since } },
      _sum: { credits: true },
      _count: true,
    }),
  ]);

  return {
    remaining: latest?.remaining ?? null,
    asOf: latest?.ranAt ?? null,
    spentLast30Days: agg._sum.credits ?? 0,
    callsLast30Days: agg._count,
  };
}

/**
 * Most recent `x-requests-remaining` reading, or null when nothing is logged.
 *
 * The historical backfill checks this before each event so a long run stops on
 * its own instead of draining the plan and failing mid-batch.
 */
export async function latestRemainingCredits(): Promise<number | null> {
  const row = await prisma.oddsApiUsage.findFirst({
    where: { remaining: { not: null } },
    orderBy: { ranAt: "desc" },
    select: { remaining: true },
  });
  return row?.remaining ?? null;
}
