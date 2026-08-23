// Per-bet CLV orchestration via OddsPortal scrape.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db";
import { clvPct } from "./betting";
import { parseHomeAway } from "./eventLink";
import { recordClosingLine } from "./closingLine";
import { scrapeClosingForBet } from "./oddsPortal";

export interface ClvScrapeResult {
  ok: boolean;
  closingOdds: number | null;
  clvPct: number | null;
  bookmakerUsed: string | null;
  matchUrl: string | null;
  provisional: boolean;
  code?: string;
  detail: string;
}

export async function fetchClvForBet(
  betId: string,
  opts?: { userId?: string; prisma?: PrismaClient }
): Promise<ClvScrapeResult> {
  const prisma = opts?.prisma ?? defaultPrisma;
  const bet = await prisma.bet.findFirst({
    where: {
      id: betId,
      ...(opts?.userId ? { userId: opts.userId } : {}),
    },
  });

  if (!bet) {
    return {
      ok: false,
      closingOdds: null,
      clvPct: null,
      bookmakerUsed: null,
      matchUrl: null,
      provisional: false,
      code: "missing_fields",
      detail: "Betet hittades inte.",
    };
  }

  if (!(bet.odds > 1)) {
    return {
      ok: false,
      closingOdds: null,
      clvPct: null,
      bookmakerUsed: null,
      matchUrl: null,
      provisional: false,
      code: "missing_fields",
      detail: "Betet saknar giltiga odds.",
    };
  }

  const parsed = parseHomeAway(bet.event);
  const homeTeam = bet.homeTeam || parsed?.home || null;
  const awayTeam = bet.awayTeam || parsed?.away || null;

  if (!homeTeam && !awayTeam && !bet.event?.trim()) {
    return {
      ok: false,
      closingOdds: null,
      clvPct: null,
      bookmakerUsed: null,
      matchUrl: null,
      provisional: false,
      code: "missing_fields",
      detail: "Saknar event/lag — kan inte söka på OddsPortal.",
    };
  }

  const scraped = await scrapeClosingForBet({
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
  });

  if (!scraped.ok || scraped.closingOdds == null || !(scraped.closingOdds > 1)) {
    return {
      ok: false,
      closingOdds: null,
      clvPct: null,
      bookmakerUsed: scraped.bookmakerUsed,
      matchUrl: scraped.matchUrl,
      provisional: scraped.provisional,
      code: scraped.code,
      detail: scraped.detail,
    };
  }

  await recordClosingLine(prisma, {
    betId: bet.id,
    source: "oddsportal",
    bookmaker: scraped.bookmakerUsed,
    rawOdds: scraped.closingOdds,
  });

  const pct = clvPct(bet.odds, scraped.closingOdds);
  return {
    ok: true,
    closingOdds: scraped.closingOdds,
    clvPct: pct,
    bookmakerUsed: scraped.bookmakerUsed,
    matchUrl: scraped.matchUrl,
    provisional: scraped.provisional,
    detail: scraped.detail,
  };
}
