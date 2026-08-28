// Near-kickoff CLV capture via The Odds API (live odds ≈ closing).
// Free-tier friendly: fetch per linked event with regions=eu and only needed markets.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db";
import { clvPct } from "./betting";
import {
  getEventOdds,
  hasOddsApiKey,
  preferredPriceFor,
  type OddsEvent,
} from "./oddsApi";
import { linkBetToOddsEvent, parseHomeAway, teamNameMatches } from "./eventLink";
import { isStatsApiMatchRef } from "./theStatsApi";
import { FEATURED_MARKETS, oddsApiClvEligibility } from "./clvEligibility";

export interface OddsApiKickoffClvOptions {
  /** Capture when kickoff is within this many minutes ahead (default 30). */
  beforeMinutes?: number;
  /** Still capture this many minutes after kickoff (default 5). */
  afterMinutes?: number;
  limit?: number;
  dryRun?: boolean;
  /** Prefer these bookmaker keys (Odds API keys). */
  bookmakers?: string;
  /** Only these bet ids (optional). */
  betIds?: string[];
  prisma?: PrismaClient;
}

export interface OddsApiKickoffClvResult {
  linked: number;
  closingUpdated: number;
  failed: number;
  details: string[];
}

type KickoffBet = {
  id: string;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  eventAt: Date | null;
  sport: string | null;
  league: string | null;
  sportKey: string | null;
  externalRef: string | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  bookmaker: string | null;
  notes: string | null;
  boosted: boolean;
  odds: number;
};

/** Map a featured bet to The Odds API market + outcome name (+ optional point). */
export function oddsApiOutcomeForBet(
  bet: Pick<
    KickoffBet,
    "market" | "selection" | "selectionSide" | "line" | "homeTeam" | "awayTeam" | "event"
  >,
  event: Pick<OddsEvent, "home_team" | "away_team">
): { market: string; outcomeName: string; point?: number } | null {
  const market = (bet.market || "").toLowerCase();
  const side = (bet.selectionSide || "").toLowerCase();
  const home = bet.homeTeam || parseHomeAway(bet.event)?.home || event.home_team;
  const away = bet.awayTeam || parseHomeAway(bet.event)?.away || event.away_team;

  if (market === "h2h") {
    if (side === "draw") return { market: "h2h", outcomeName: "Draw" };
    if (/oavgjort|draw|\bx\b/i.test(bet.selection)) {
      return { market: "h2h", outcomeName: "Draw" };
    }

    // Urvalstexten går före selectionSide.
    //
    // Sidan är härledd vid inmatningen och blir fel när hem-/bortalag saknas:
    // "Liverpool vinst fulltid" i "Newcastle United - Liverpool" låg som
    // side=home. Litade man på sidan hämtades Newcastles pris i stället för
    // Liverpools — ett closing som ser rimligt ut men gäller motståndaren.
    const matchesHome =
      (!!home && teamNameMatches(bet.selection, home)) ||
      teamNameMatches(bet.selection, event.home_team);
    const matchesAway =
      (!!away && teamNameMatches(bet.selection, away)) ||
      teamNameMatches(bet.selection, event.away_team);

    if (matchesHome && !matchesAway) return { market: "h2h", outcomeName: event.home_team };
    if (matchesAway && !matchesHome) return { market: "h2h", outcomeName: event.away_team };

    // Namnet pekar på båda eller inget — då är sidan enda ledtråden.
    if (side === "home") return { market: "h2h", outcomeName: event.home_team };
    if (side === "away") return { market: "h2h", outcomeName: event.away_team };
    return null;
  }

  if (market === "totals") {
    if (bet.line == null) return null;
    if (side === "over" || /över|over/i.test(bet.selection)) {
      return { market: "totals", outcomeName: "Over", point: bet.line };
    }
    if (side === "under" || /under/i.test(bet.selection)) {
      return { market: "totals", outcomeName: "Under", point: bet.line };
    }
    return null;
  }

  if (market === "spreads") {
    if (bet.line == null) return null;

    // Samma ordning som h2h ovan: namnet i urvalet är mer tillförlitligt än den
    // härledda sidan, och ett handikapp på fel lag är fel med omvänt tecken.
    const matchesHome =
      (!!home && teamNameMatches(bet.selection, home)) ||
      teamNameMatches(bet.selection, event.home_team);
    const matchesAway =
      (!!away && teamNameMatches(bet.selection, away)) ||
      teamNameMatches(bet.selection, event.away_team);

    if (matchesHome && !matchesAway) {
      return { market: "spreads", outcomeName: event.home_team, point: bet.line };
    }
    if (matchesAway && !matchesHome) {
      return { market: "spreads", outcomeName: event.away_team, point: bet.line };
    }
    if (side === "home") {
      return { market: "spreads", outcomeName: event.home_team, point: bet.line };
    }
    if (side === "away") {
      return { market: "spreads", outcomeName: event.away_team, point: bet.line };
    }
    return null;
  }

  return null;
}

function marketsParamForBets(bets: KickoffBet[]): string {
  const set = new Set<string>();
  for (const b of bets) {
    if (b.market === "h2h" || b.market === "totals" || b.market === "spreads") {
      set.add(b.market);
    }
  }
  if (set.size === 0) return "h2h";
  return [...set].join(",");
}

/**
 * Link + capture live Odds API prices for featured bets near kickoff.
 * Writes closingOdds once; skips TheStatsAPI-linked (mt_*) refs.
 */
export async function captureClosingNearKickoff(
  opts: OddsApiKickoffClvOptions = {}
): Promise<OddsApiKickoffClvResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const details: string[] = [];
  if (!hasOddsApiKey()) {
    return {
      linked: 0,
      closingUpdated: 0,
      failed: 0,
      details: ["No ODDS_API_KEY set — cannot capture kickoff CLV."],
    };
  }

  const beforeMinutes = opts.beforeMinutes ?? 30;
  const afterMinutes = opts.afterMinutes ?? 5;
  const limit = opts.limit ?? 40;
  const dryRun = !!opts.dryRun;
  const now = Date.now();
  const windowStart = new Date(now - afterMinutes * 60 * 1000);
  const windowEnd = new Date(now + beforeMinutes * 60 * 1000);

  const candidates = await prisma.bet.findMany({
    where: {
      betType: "single",
      eventKind: "match",
      market: { in: [...FEATURED_MARKETS] },
      closingOdds: null,
      eventAt: { gte: windowStart, lte: windowEnd },
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
      ...(opts.betIds?.length ? { id: { in: opts.betIds } } : {}),
    },
    orderBy: { eventAt: "asc" },
    take: limit,
    select: {
      id: true,
      event: true,
      homeTeam: true,
      awayTeam: true,
      eventAt: true,
      sport: true,
      league: true,
      sportKey: true,
      externalRef: true,
      market: true,
      marketCategory: true,
      marketScope: true,
      selection: true,
      selectionSide: true,
      line: true,
      bookmaker: true,
      notes: true,
      boosted: true,
      odds: true,
    },
  });

  if (candidates.length === 0) {
    details.push(
      `Inga featured bets med kickoff inom -${afterMinutes}/+${beforeMinutes} min.`
    );
    return { linked: 0, closingUpdated: 0, failed: 0, details };
  }

  details.push(`${candidates.length} bets i kickoff-fönstret`);

  let linked = 0;
  const ready: KickoffBet[] = [];

  for (const bet of candidates) {
    if (isStatsApiMatchRef(bet.externalRef)) {
      details.push(`${bet.event}: skip — TheStatsAPI-länk (mt_*)`);
      continue;
    }

    // `market` är avräkningstyp, inte semantisk marknad: ett hörn- eller
    // kortspel ligger också som "totals". Utan den här kontrollen hämtas
    // målpriset åt dem. Se lib/clvEligibility.ts.
    const verdict = oddsApiClvEligibility(bet);
    if (!verdict.ok) {
      details.push(`${bet.event}: hoppade — ${verdict.reason}`);
      continue;
    }

    let row: KickoffBet = bet;
    if (!bet.externalRef || !bet.sportKey) {
      const result = await linkBetToOddsEvent(prisma, bet);
      if (!result.linked) {
        details.push(`${bet.event}: kunde inte länka till Odds API`);
        continue;
      }
      linked += 1;
      row = {
        ...bet,
        externalRef: result.externalRef ?? bet.externalRef,
        sportKey: result.sportKey ?? bet.sportKey,
        homeTeam: result.homeTeam ?? bet.homeTeam,
        awayTeam: result.awayTeam ?? bet.awayTeam,
        eventAt: result.eventAt ?? bet.eventAt,
      };
      details.push(`${bet.event}: länkad → ${row.sportKey}/${row.externalRef}`);
    }
    ready.push(row);
  }

  // Group by sportKey + eventId to fetch each event once.
  const byEvent = new Map<string, KickoffBet[]>();
  for (const bet of ready) {
    if (!bet.sportKey || !bet.externalRef) continue;
    const key = `${bet.sportKey}::${bet.externalRef}`;
    const list = byEvent.get(key) || [];
    list.push(bet);
    byEvent.set(key, list);
  }

  let closingUpdated = 0;
  let failed = 0;
  const eventCache = new Map<string, OddsEvent>();

  for (const [key, bets] of byEvent) {
    const [sportKey, eventId] = key.split("::");
    if (!sportKey || !eventId) continue;

    let event = eventCache.get(key);
    if (!event) {
      try {
        event = await getEventOdds(sportKey, eventId, {
          regions: "eu",
          markets: marketsParamForBets(bets),
          bookmakers: opts.bookmakers,
        });
        eventCache.set(key, event);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        details.push(`${bets[0]?.event}: Odds API-fel — ${msg}`);
        failed += bets.length;
        continue;
      }
    }

    for (const bet of bets) {
      const target = oddsApiOutcomeForBet(bet, event);
      if (!target) {
        details.push(`${bet.event}: kunde inte mappa selection → Odds API outcome`);
        failed += 1;
        continue;
      }

      const picked = preferredPriceFor(
        event,
        target.market,
        target.outcomeName,
        target.point
      );
      if (!picked || !(picked.price > 1)) {
        details.push(
          `${bet.event}: ingen prisrad (${target.market} ${target.outcomeName}${target.point != null ? ` ${target.point}` : ""})`
        );
        failed += 1;
        continue;
      }

      const pct = clvPct(bet.odds, picked.price);
      const pctStr = pct == null ? "?" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
      details.push(
        `${bet.event}: closing ${picked.price.toFixed(2)} via ${picked.bookmaker} (du ${bet.odds.toFixed(2)}, CLV ${pctStr})${dryRun ? " [dry-run]" : ""}`
      );

      if (!dryRun) {
        await prisma.bet.update({
          where: { id: bet.id },
          data: { closingOdds: picked.price },
        });
      }
      closingUpdated += 1;
    }
  }

  return { linked, closingUpdated, failed, details };
}

/** True when eventAt is inside the pre/post-kickoff capture window. */
export function isInKickoffClvWindow(
  eventAt: Date | null | undefined,
  opts?: { beforeMinutes?: number; afterMinutes?: number; now?: number }
): boolean {
  if (!eventAt) return false;
  const beforeMinutes = opts?.beforeMinutes ?? 30;
  const afterMinutes = opts?.afterMinutes ?? 5;
  const now = opts?.now ?? Date.now();
  const t = new Date(eventAt).getTime();
  return t >= now - afterMinutes * 60 * 1000 && t <= now + beforeMinutes * 60 * 1000;
}

/**
 * Next upcoming featured kickoff that still needs CLV, or null.
 * Used by the watcher to sleep until the 30-min window opens.
 */
export async function nextFeaturedKickoffNeedingClv(
  opts: { beforeMinutes?: number; prisma?: PrismaClient } = {}
): Promise<Date | null> {
  const prisma = opts.prisma ?? defaultPrisma;
  const beforeMinutes = opts.beforeMinutes ?? 30;
  const now = new Date();
  // Look ahead far enough that we can wake when the window opens.
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const bet = await prisma.bet.findFirst({
    where: {
      betType: "single",
      eventKind: "match",
      market: { in: [...FEATURED_MARKETS] },
      closingOdds: null,
      eventAt: { gt: now, lte: horizon },
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
    },
    orderBy: { eventAt: "asc" },
    select: { eventAt: true },
  });

  if (!bet?.eventAt) return null;
  // Window opens at eventAt - beforeMinutes
  return new Date(bet.eventAt.getTime() - beforeMinutes * 60 * 1000);
}

/**
 * If this bet is featured + inside the kickoff window, capture closing now.
 * Safe to fire-and-forget after create/link.
 */
export async function maybeCaptureKickoffClvForBet(
  betId: string,
  opts: { prisma?: PrismaClient } = {}
): Promise<OddsApiKickoffClvResult | null> {
  const prisma = opts.prisma ?? defaultPrisma;
  if (!hasOddsApiKey()) return null;

  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: {
      id: true,
      market: true,
      marketScope: true,
      betType: true,
      eventKind: true,
      closingOdds: true,
      eventAt: true,
    },
  });
  if (!bet) return null;
  if (bet.closingOdds != null) return null;
  if (bet.betType !== "single" || bet.eventKind !== "match") return null;
  if (!FEATURED_MARKETS.includes(bet.market as (typeof FEATURED_MARKETS)[number])) {
    return null;
  }
  if (bet.marketScope === "player") return null;
  if (!isInKickoffClvWindow(bet.eventAt)) return null;

  return captureClosingNearKickoff({
    prisma,
    betIds: [betId],
    beforeMinutes: 30,
    afterMinutes: 5,
    limit: 1,
  });
}
