// Batch OddsPortal CLV capture for featured markets (h2h / totals / spreads).
// Local/CLI only — Playwright is not suited for serverless.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db";
import { clvPct } from "./betting";
import { parseHomeAway } from "./eventLink";
import {
  scrapeClosingBatch,
  type ScrapeBetInput,
  type ScrapeClosingResult,
} from "./oddsPortal";

const DAY_MS = 24 * 60 * 60 * 1000;
const FEATURED_MARKETS = ["h2h", "totals", "spreads"] as const;

/** Sports OddsPortal scrape handles reliably enough for batch CLV. */
const SCRAPEABLE_SPORTS = [
  "Football",
  "Tennis",
  "Basketball",
  "Baseball",
  "Ice Hockey",
  "American Football",
  "MMA",
  "Boxing",
  "Darts",
] as const;

export interface OddsPortalClvOptions {
  /** Lookback from now (default 90). Ignored when sinceDate is set. */
  sinceDays?: number;
  sinceDate?: Date;
  /** Max bets to scrape this run. */
  limit?: number;
  /** When true, do not write closingOdds. */
  dryRun?: boolean;
  /** Require kickoff + grace before scraping (default true). */
  postKickoffOnly?: boolean;
  /** Minutes after eventAt before we treat odds as closing (default 15). */
  graceMinutes?: number;
  /** Pause between OddsPortal searches (default 1200). */
  pauseMs?: number;
  prisma?: PrismaClient;
}

export interface OddsPortalClvResult {
  candidates: number;
  attempted: number;
  updated: number;
  failed: number;
  details: string[];
}

type CandidateBet = {
  id: string;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  sport: string | null;
  league: string | null;
  eventAt: Date | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  bookmaker: string | null;
  odds: number;
};

function toScrapeInput(bet: CandidateBet): ScrapeBetInput | null {
  const parsed = parseHomeAway(bet.event);
  const homeTeam = bet.homeTeam || parsed?.home || null;
  const awayTeam = bet.awayTeam || parsed?.away || null;
  if (!homeTeam && !awayTeam && !bet.event?.trim()) return null;
  if (!(bet.odds > 1)) return null;

  return {
    sport: bet.sport,
    league: bet.league,
    event: bet.event,
    homeTeam,
    awayTeam,
    eventAt: bet.eventAt,
    market: bet.market,
    marketCategory: bet.marketCategory,
    marketScope: bet.marketScope,
    selection: bet.selection,
    selectionSide: bet.selectionSide,
    line: bet.line,
    bookmaker: bet.bookmaker,
  };
}

function formatResult(
  bet: CandidateBet,
  scraped: ScrapeClosingResult,
  dryRun: boolean
): string {
  if (!scraped.ok || scraped.closingOdds == null) {
    return `${bet.event}: FAIL ${scraped.code || "error"} — ${scraped.detail}`;
  }
  const pct = clvPct(bet.odds, scraped.closingOdds);
  const pctStr = pct == null ? "?" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  const bk = scraped.bookmakerUsed ? ` via ${scraped.bookmakerUsed}` : "";
  return `${bet.event}: closing ${scraped.closingOdds.toFixed(2)} (du ${bet.odds.toFixed(2)}, CLV ${pctStr})${bk}${dryRun ? " [dry-run]" : ""}`;
}

/** Featured singles missing closing odds in the lookback window. */
export async function listFeaturedClvCandidates(
  opts: OddsPortalClvOptions = {}
): Promise<CandidateBet[]> {
  const prisma = opts.prisma ?? defaultPrisma;
  const sinceDays = opts.sinceDays ?? 14;
  const since =
    opts.sinceDate ?? new Date(Date.now() - sinceDays * DAY_MS);
  const postKickoffOnly = opts.postKickoffOnly !== false;
  const graceMinutes = opts.graceMinutes ?? 15;
  const kickoffCutoff = new Date(Date.now() - graceMinutes * 60 * 1000);
  const limit = opts.limit ?? 200;

  const where: Prisma.BetWhereInput = {
    betType: "single",
    eventKind: "match",
    market: { in: [...FEATURED_MARKETS] },
    closingOdds: null,
    sport: { in: [...SCRAPEABLE_SPORTS] },
    OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
    AND: [
      {
        OR: [
          { eventAt: { gte: since } },
          { eventAt: null, placedAt: { gte: since } },
        ],
      },
      ...(postKickoffOnly
        ? [
            {
              OR: [
                { eventAt: { lte: kickoffCutoff } },
                // No kickoff time — allow scrape (best-effort historical page)
                { eventAt: null },
              ],
            } satisfies Prisma.BetWhereInput,
          ]
        : []),
    ],
  };

  return prisma.bet.findMany({
    where,
    orderBy: [{ eventAt: "asc" }, { placedAt: "asc" }],
    take: limit,
    select: {
      id: true,
      event: true,
      homeTeam: true,
      awayTeam: true,
      sport: true,
      league: true,
      eventAt: true,
      market: true,
      marketCategory: true,
      marketScope: true,
      selection: true,
      selectionSide: true,
      line: true,
      bookmaker: true,
      odds: true,
    },
  });
}

/**
 * Scrape OddsPortal closing odds for featured bets (shared browser).
 * Intended for local CLI / Task Scheduler — not Vercel.
 */
export async function captureClosingFromOddsPortal(
  opts: OddsPortalClvOptions = {}
): Promise<OddsPortalClvResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const dryRun = !!opts.dryRun;
  const details: string[] = [];

  const candidates = await listFeaturedClvCandidates(opts);
  if (candidates.length === 0) {
    details.push("Inga featured bets utan closingOdds i fönstret.");
    return { candidates: 0, attempted: 0, updated: 0, failed: 0, details };
  }

  const batchItems: { id: string; input: ScrapeBetInput; bet: CandidateBet }[] =
    [];
  for (const bet of candidates) {
    const input = toScrapeInput(bet);
    if (!input) {
      details.push(`${bet.event}: skip — saknar lag/odds`);
      continue;
    }
    batchItems.push({ id: bet.id, input, bet });
  }

  details.push(
    `${candidates.length} kandidater, scrapar ${batchItems.length}${dryRun ? " [dry-run]" : ""}`
  );

  if (batchItems.length === 0) {
    return {
      candidates: candidates.length,
      attempted: 0,
      updated: 0,
      failed: 0,
      details,
    };
  }

  const scraped = await scrapeClosingBatch(
    batchItems.map(({ id, input }) => ({ id, input })),
    { pauseMs: opts.pauseMs }
  );

  const byId = new Map(batchItems.map((b) => [b.id, b.bet]));
  let updated = 0;
  let failed = 0;

  for (const row of scraped) {
    const bet = byId.get(row.id);
    if (!bet) continue;
    details.push(formatResult(bet, row.result, dryRun));

    if (!row.result.ok || row.result.closingOdds == null || !(row.result.closingOdds > 1)) {
      failed += 1;
      continue;
    }

    // Skip writing provisional (pre-kickoff) live odds in batch mode.
    if (row.result.provisional && opts.postKickoffOnly !== false) {
      details.push(`  → hoppade provisional (pre-kickoff)`);
      failed += 1;
      continue;
    }

    if (!dryRun) {
      await prisma.bet.update({
        where: { id: bet.id },
        data: { closingOdds: row.result.closingOdds },
      });
    }
    updated += 1;
  }

  return {
    candidates: candidates.length,
    attempted: batchItems.length,
    updated,
    failed,
    details,
  };
}
