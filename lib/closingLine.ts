// The one write path for closing odds.
//
// Four capture paths feed this: the historical snapshot, the near-kickoff live
// price, TheStatsAPI, the OddsPortal scrape, and whatever the user types by
// hand. Before this module they all wrote `Bet.closingOdds` directly, with the
// result that whichever ran last won — an hourly scrape could quietly overwrite
// a true closing line with a worse guess, and nothing recorded that it had.
//
// Two rules fix that:
//   - Every capture APPENDS a ClosingLine row. History is never overwritten;
//     several rows on one bet are how line movement is stored.
//   - The denormalised fields on Bet only move when the new source is at least
//     as trustworthy as the one already there (see SOURCE_PRIORITY).

import type { PrismaClient } from "@prisma/client";

export type ClosingSource =
  | "manual"
  | "odds_api_historical"
  | "thestatsapi"
  | "oddsportal"
  | "odds_api_live";

/**
 * How much each source is trusted, high wins.
 *
 * `manual` sits at the top because a value the user typed is a decision, not an
 * observation — automation must never silently replace it. Below that the order
 * is simply how close each source is to the actual close: the historical
 * snapshot IS the close, a scrape or a stats provider is a reconstruction of
 * it, and a live price 30 minutes early is a guess at it.
 */
export const SOURCE_PRIORITY: Record<ClosingSource, number> = {
  manual: 100,
  odds_api_historical: 80,
  thestatsapi: 60,
  oddsportal: 50,
  odds_api_live: 20,
};

/** Sources that settle a bet's CLV — nothing re-captures it afterwards. */
const FINAL_SOURCES: ReadonlySet<ClosingSource> = new Set<ClosingSource>([
  "manual",
  "odds_api_historical",
]);

export interface RecordClosingInput {
  betId: string;
  source: ClosingSource;
  /** Slug of the book the raw price was read from. */
  bookmaker?: string | null;
  /** The book's own closing price — still carries their margin. */
  rawOdds: number;
  /** De-vigged fair price, when a reference was available. */
  fairOdds?: number | null;
  fairSource?: string | null;
  overround?: number | null;
  disagreement?: number | null;
  /** Provider snapshot timestamp, when the provider reports one. */
  snapshotAt?: Date | null;
}

export interface RecordClosingResult {
  /** Whether the bet's headline closing fields were updated. */
  promoted: boolean;
  /** Source that currently owns the bet's closing fields. */
  winner: string;
}

function priorityOf(source: string | null | undefined): number {
  if (!source) return -1;
  return SOURCE_PRIORITY[source as ClosingSource] ?? 0;
}

/**
 * Append a closing-line observation and promote it to the bet when it is at
 * least as good as what is already recorded.
 */
export async function recordClosingLine(
  prisma: PrismaClient,
  input: RecordClosingInput
): Promise<RecordClosingResult> {
  const {
    betId,
    source,
    bookmaker = null,
    rawOdds,
    fairOdds = null,
    fairSource = null,
    overround = null,
    disagreement = null,
    snapshotAt = null,
  } = input;

  const existing = await prisma.bet.findUnique({
    where: { id: betId },
    select: { closingSource: true },
  });
  if (!existing) return { promoted: false, winner: "" };

  const promote = priorityOf(source) >= priorityOf(existing.closingSource);

  const lineData = { bookmaker, rawOdds, fairOdds, fairSource, overround, disagreement };

  // A provider snapshot addresses one row through the compound unique, so a
  // re-run replaces it instead of piling up duplicates. Without a timestamp
  // (live capture, manual entry) each capture is its own observation — that is
  // exactly the movement we want to keep.
  const write = snapshotAt
    ? prisma.closingLine.upsert({
        where: { betId_source_snapshotAt: { betId, source, snapshotAt } },
        create: { betId, source, snapshotAt, ...lineData },
        update: lineData,
      })
    : prisma.closingLine.create({
        data: { betId, source, snapshotAt: null, ...lineData },
      });

  if (!promote) {
    await write;
    return { promoted: false, winner: existing.closingSource ?? "" };
  }

  await prisma.$transaction([
    write,
    prisma.bet.update({
      where: { id: betId },
      data: {
        closingOdds: rawOdds,
        closingFairOdds: fairOdds,
        closingSource: source,
        closingBookmaker: bookmaker,
        closingCapturedAt: new Date(),
        clvFinal: FINAL_SOURCES.has(source),
      },
    }),
  ]);

  return { promoted: true, winner: source };
}
