// The real closing line, from The Odds API's /historical snapshots.
//
// A price captured before kickoff is a guess at the close; this is the close.
// The API serves the nearest snapshot at or before a timestamp, so asking for
// the event's own kickoff time gives the last prices the market showed.
//
// Two numbers come out of every capture and they answer different questions:
//
//   rawOdds  — what the reference book closed at. Carries their margin, so a
//              bet measured against it looks BETTER than it was.
//   fairOdds — the same market with the vig removed. Shorter CLV, honest CLV.
//
// Paid plans only, and a snapshot costs 10 × markets × regions. Everything here
// is built around spending that once per event, never once per bet.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db";
import { clvPct } from "./betting";
import {
  getHistoricalEventOdds,
  hasOddsApiKey,
  preferredPriceFor,
  type OddsEvent,
} from "./oddsApi";
import { oddsApiOutcomeForBet } from "./clvOddsApi";
import { extractOddsApiPrices, type OddsApiPriceRow } from "./oddsApiMap";
import {
  marketReference,
  type BookMarket,
  type MarketReference,
  type OddsMarket,
  type OddsOutcome,
} from "./marketOdds";
import { isStatsApiMatchRef } from "./theStatsApi";
import { latestRemainingCredits } from "./oddsApiUsage";
import { recordClosingLine } from "./closingLine";

export const CLOSING_SOURCE_HISTORICAL = "odds_api_historical";

/** Markets a featured bet can map onto an Odds API market key. */
const FEATURED_MARKETS = ["h2h", "totals", "spreads"] as const;
type FeaturedMarket = (typeof FEATURED_MARKETS)[number];

/** Bet market → the market key on the project's own price rows. */
const PROJECT_MARKET: Record<FeaturedMarket, OddsMarket> = {
  h2h: "1x2",
  totals: "totals",
  spreads: "ah",
};

/**
 * Stop capturing when the plan has this little left.
 *
 * A backfill that drains the quota does not just stop — it takes the nightly
 * settle run down with it, and that is the job that actually has to keep
 * working. The reserve is what those runs need.
 */
export const DEFAULT_CREDIT_RESERVE = 200;

export interface HistoricalClvOptions {
  /** Only bets whose event is at least this old (default 0 = any past event). */
  graceMinutes?: number;
  /** Ignore events older than this (default 400 days — the API's own reach). */
  sinceDays?: number;
  limit?: number;
  dryRun?: boolean;
  /** Odds API regions. One region keeps the 10× multiplier bearable. */
  regions?: string;
  /** Hard ceiling on credits this run may spend. */
  maxCredits?: number;
  /** Refuse to start a call when remaining credits fall below this. */
  creditReserve?: number;
  betIds?: string[];
  prisma?: PrismaClient;
}

export interface HistoricalClvResult {
  events: number;
  closingUpdated: number;
  failed: number;
  creditsSpent: number;
  stoppedEarly: string | null;
  details: string[];
}

type ClvCandidate = {
  id: string;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  eventAt: Date | null;
  sportKey: string | null;
  externalRef: string | null;
  market: string;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  bookmaker: string | null;
  odds: number;
};

/**
 * Which side of the market the bet backed, in the project's own vocabulary.
 *
 * Reuses `oddsApiOutcomeForBet` rather than re-deriving the mapping: that
 * function is the one already tested against Swedish selection text, draws and
 * team-name drift, and two mappings that can disagree is exactly how a bet ends
 * up measured against the wrong side of the market.
 */
export function betOutcomeSide(
  bet: Parameters<typeof oddsApiOutcomeForBet>[0],
  event: Pick<OddsEvent, "home_team" | "away_team">
): { market: FeaturedMarket; outcome: OddsOutcome; point?: number; outcomeName: string } | null {
  const target = oddsApiOutcomeForBet(bet, event);
  if (!target) return null;
  const market = target.market as FeaturedMarket;
  if (!FEATURED_MARKETS.includes(market)) return null;

  let outcome: OddsOutcome | null = null;
  if (market === "totals") {
    if (target.outcomeName === "Over") outcome = "over";
    else if (target.outcomeName === "Under") outcome = "under";
  } else if (target.outcomeName === "Draw") {
    outcome = "draw";
  } else if (target.outcomeName === event.home_team) {
    outcome = "home";
  } else if (target.outcomeName === event.away_team) {
    outcome = "away";
  }

  if (!outcome) return null;
  return { market, outcome, point: target.point, outcomeName: target.outcomeName };
}

/** Price rows for one market (and line), grouped per bookmaker. */
export function booksForMarket(
  rows: OddsApiPriceRow[],
  market: OddsMarket,
  line: number | null
): BookMarket[] {
  const byBook = new Map<string, BookMarket>();
  for (const r of rows) {
    if (r.market !== market) continue;
    if (line == null) {
      if (r.line != null) continue;
    } else if (r.line == null || Math.abs(r.line - line) > 0.001) {
      continue;
    }
    let book = byBook.get(r.bookmaker);
    if (!book) {
      book = { bookmaker: r.bookmaker, outcomes: [] };
      byBook.set(r.bookmaker, book);
    }
    book.outcomes.push({
      outcome: r.outcome,
      odds: r.odds,
      layOdds: r.layOdds,
      backSize: r.backSize,
      laySize: r.laySize,
    });
  }
  return [...byBook.values()];
}

/**
 * The outcome set the market is made of, read off the data rather than assumed.
 *
 * A three-way 1X2 and a two-way moneyline are the same `h2h` market key to the
 * API; hardcoding a draw would make every NHL and tennis bet unpriceable, and
 * hardcoding its absence would leave football markets summing to well under 1.
 */
export function expectedOutcomes(books: BookMarket[], market: OddsMarket): OddsOutcome[] {
  if (market === "totals") return ["over", "under"];
  if (market === "ah") return ["home", "away"];
  const hasDraw = books.some((b) => b.outcomes.some((o) => o.outcome === "draw"));
  return hasDraw ? ["home", "draw", "away"] : ["home", "away"];
}

/**
 * Fair (de-vigged) price for the side a bet backed.
 *
 * Asian handicap is deliberately left unpriced: the sign convention differs
 * between books (`HANDICAP_SIGN` in lib/marketOdds.ts covers five of them, and
 * the AH screen is switched off in the UI for exactly that reason). Comparing
 * two books that disagree about the sign produces a confident, wrong CLV — so
 * spreads get a raw closing price and an explicit null fair price instead.
 */
export function fairClosingFor(
  event: OddsEvent,
  market: FeaturedMarket,
  outcome: OddsOutcome,
  line: number | null
): { fairOdds: number; reference: MarketReference } | null {
  if (market === "spreads") return null;

  const projectMarket = PROJECT_MARKET[market];
  const { rows } = extractOddsApiPrices(event);
  const books = booksForMarket(rows, projectMarket, projectMarket === "1x2" ? null : line);
  if (books.length === 0) return null;

  const expected = expectedOutcomes(books, projectMarket);
  if (!expected.includes(outcome)) return null;

  // Consensus is allowed here — unlike on the EV screen. Measuring a price you
  // already took against the market afterwards is not circular the way shopping
  // against a median of the same soft books would be.
  const reference = marketReference(books, expected, { allowConsensus: true });
  if (!reference) return null;

  const p = reference.probs.get(outcome);
  if (!p || !(p > 0) || !(p < 1)) return null;
  return { fairOdds: 1 / p, reference };
}

/** Odds API market keys needed to price this group of bets. */
function marketsParam(bets: ClvCandidate[]): string {
  const set = new Set<string>();
  for (const b of bets) {
    if (FEATURED_MARKETS.includes(b.market as FeaturedMarket)) set.add(b.market);
  }
  return set.size === 0 ? "h2h" : [...set].join(",");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Capture the true closing line for bets whose event has finished.
 *
 * One snapshot per event, covering every bet on it — the cost is per call, not
 * per bet, so grouping is the difference between 10 credits and 10 per leg.
 */
export async function captureHistoricalClosing(
  opts: HistoricalClvOptions = {}
): Promise<HistoricalClvResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const details: string[] = [];
  const empty: HistoricalClvResult = {
    events: 0,
    closingUpdated: 0,
    failed: 0,
    creditsSpent: 0,
    stoppedEarly: null,
    details,
  };

  if (!hasOddsApiKey()) {
    details.push("ODDS_API_KEY saknas — kan inte hämta historisk stängning.");
    return empty;
  }

  const graceMinutes = opts.graceMinutes ?? 0;
  const sinceDays = opts.sinceDays ?? 400;
  const limit = opts.limit ?? 50;
  const regions = opts.regions ?? "eu";
  const reserve = opts.creditReserve ?? DEFAULT_CREDIT_RESERVE;
  const dryRun = !!opts.dryRun;

  const now = Date.now();
  const before = new Date(now - graceMinutes * 60 * 1000);
  const after = new Date(now - sinceDays * DAY_MS);

  const candidates = (await prisma.bet.findMany({
    where: {
      clvFinal: false,
      betType: "single",
      eventKind: "match",
      market: { in: [...FEATURED_MARKETS] },
      eventAt: { gte: after, lte: before },
      externalRef: { not: null },
      sportKey: { not: null },
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
      ...(opts.betIds?.length ? { id: { in: opts.betIds } } : {}),
    },
    orderBy: { eventAt: "desc" },
    take: limit,
    select: {
      id: true,
      event: true,
      homeTeam: true,
      awayTeam: true,
      eventAt: true,
      sportKey: true,
      externalRef: true,
      market: true,
      selection: true,
      selectionSide: true,
      line: true,
      bookmaker: true,
      odds: true,
    },
  })) as ClvCandidate[];

  // TheStatsAPI-linked rows (mt_*) and its synthetic sport keys are a different
  // provider's ids — the Odds API has never heard of them.
  const usable = candidates.filter(
    (b) => !isStatsApiMatchRef(b.externalRef) && !b.sportKey?.startsWith("tsa:")
  );

  if (usable.length === 0) {
    details.push("Inga länkade bets utan slutgiltig stängning i fönstret.");
    return empty;
  }

  const byEvent = new Map<string, ClvCandidate[]>();
  for (const bet of usable) {
    const key = `${bet.sportKey}::${bet.externalRef}`;
    const list = byEvent.get(key);
    if (list) list.push(bet);
    else byEvent.set(key, [bet]);
  }

  details.push(`${usable.length} bets på ${byEvent.size} event`);

  let events = 0;
  let closingUpdated = 0;
  let failed = 0;
  let creditsSpent = 0;
  let stoppedEarly: string | null = null;

  for (const [key, bets] of byEvent) {
    if (opts.maxCredits != null && creditsSpent >= opts.maxCredits) {
      stoppedEarly = `Kreditbudget nådd (${creditsSpent}/${opts.maxCredits}) — kör igen för resten.`;
      details.push(stoppedEarly);
      break;
    }

    const remaining = await latestRemainingCredits();
    if (remaining != null && remaining <= reserve) {
      stoppedEarly = `Endast ${remaining} krediter kvar (reserv ${reserve}) — avbryter.`;
      details.push(stoppedEarly);
      break;
    }

    const [sportKey, eventId] = key.split("::");
    const kickoff = bets.find((b) => b.eventAt)?.eventAt;
    if (!sportKey || !eventId || !kickoff) {
      failed += bets.length;
      continue;
    }

    let event: OddsEvent;
    let snapshotAt: Date | null = null;
    try {
      const { envelope, quota } = await getHistoricalEventOdds(
        sportKey,
        eventId,
        new Date(kickoff).toISOString(),
        { regions, markets: marketsParam(bets) }
      );
      event = envelope.data;
      snapshotAt = envelope.timestamp ? new Date(envelope.timestamp) : null;
      creditsSpent += quota.last ?? 0;
      events += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      details.push(`${bets[0]?.event}: historik-fel — ${msg}`);
      failed += bets.length;
      continue;
    }

    if (!event?.bookmakers?.length) {
      details.push(`${bets[0]?.event}: snapshot utan bookmakerpriser`);
      failed += bets.length;
      continue;
    }

    for (const bet of bets) {
      const side = betOutcomeSide(bet, event);
      if (!side) {
        details.push(`${bet.event}: kunde inte mappa "${bet.selection}" till ett utfall`);
        failed += 1;
        continue;
      }

      const raw = preferredPriceFor(
        event,
        side.market,
        side.outcomeName,
        side.point,
        // The bettor's own book first: CLV against the price you could actually
        // have kept taking is the one that describes your own edge.
        bet.bookmaker ? [bet.bookmaker, "pinnacle", "bet365", "unibet"] : undefined
      );
      if (!raw || !(raw.price > 1)) {
        details.push(`${bet.event}: ingen prisrad för ${side.market}/${side.outcome}`);
        failed += 1;
        continue;
      }

      const fair = fairClosingFor(event, side.market, side.outcome, bet.line);

      const rawClv = clvPct(bet.odds, raw.price);
      const fairClv = fair ? clvPct(bet.odds, fair.fairOdds) : null;
      const fmt = (n: number | null) =>
        n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
      details.push(
        `${bet.event}: stängning ${raw.price.toFixed(2)} (${raw.bookmaker})` +
          (fair ? ` · fair ${fair.fairOdds.toFixed(2)} (${fair.reference.source})` : " · fair —") +
          ` · du ${bet.odds.toFixed(2)} · CLV rå ${fmt(rawClv)} fair ${fmt(fairClv)}` +
          (dryRun ? " [dry-run]" : "")
      );

      if (dryRun) {
        closingUpdated += 1;
        continue;
      }

      try {
        const { promoted, winner } = await recordClosingLine(prisma, {
          betId: bet.id,
          source: CLOSING_SOURCE_HISTORICAL,
          bookmaker: raw.bookmaker,
          rawOdds: raw.price,
          fairOdds: fair?.fairOdds ?? null,
          fairSource: fair?.reference.source ?? null,
          overround: fair?.reference.overround ?? null,
          disagreement: fair?.reference.disagreement ?? null,
          snapshotAt,
        });
        if (!promoted) {
          details.push(`${bet.event}: sparad som historik, men "${winner}" har företräde`);
        }
        closingUpdated += 1;
      } catch (e) {
        details.push(`${bet.event}: kunde inte spara — ${(e as Error).message}`);
        failed += 1;
      }
    }
  }

  return { events, closingUpdated, failed, creditsSpent, stoppedEarly, details };
}
