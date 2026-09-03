import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet, serializeBetList } from "@/lib/types";
import { buildBetData, ValidationError } from "@/lib/betInput";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { settleBet } from "@/lib/settlement";
import { computeMetrics } from "@/lib/betting";
import { linkBetToOddsEvent } from "@/lib/eventLink";
import { tryLinkSingleFootballBet, isFootballBet } from "@/lib/clvCapture";
import { hasTheStatsApiKey, isStatsApiMatchRef } from "@/lib/theStatsApi";
import { maybeCaptureKickoffClvForBet } from "@/lib/clvOddsApi";
import { hasOddsApiKey } from "@/lib/oddsApi";
import type { Outcome } from "@/lib/betting";

function isStatsLinked(ref: string | null | undefined): boolean {
  return isStatsApiMatchRef(ref);
}

export const dynamic = "force-dynamic";

// Columns for the compact list shape (fields=list). Keep in sync with BetListDTO.
const LIST_SELECT = {
  id: true,
  placedAt: true,
  eventAt: true,
  sport: true,
  league: true,
  event: true,
  homeTeam: true,
  awayTeam: true,
  market: true,
  marketCategory: true,
  marketScope: true,
  eventKind: true,
  tournamentStage: true,
  selection: true,
  selectionSide: true,
  line: true,
  betType: true,
  odds: true,
  closingOdds: true,
  closingSource: true,
  boosted: true,
  stakeUnits: true,
  outcome: true,
  profitUnits: true,
  bookmaker: true,
  resultProvider: true,
  resultEventRef: true,
} as const;

// Only what computeMetrics reads. Aggregating a filtered set over these seven
// columns costs a fraction of shipping whole rows, and keeps one implementation
// of "what does ROI mean" rather than a second one written in SQL.
const AGG_SELECT = {
  odds: true,
  stakeUnits: true,
  outcome: true,
  profitUnits: true,
  closingOdds: true,
  closingSource: true,
  boosted: true,
} as const;

// GET /api/bets — list the current user's bets, newest event first.
//   ?limit=N       cap the number of rows (e.g. the dashboard's recent list)
//   ?fields=list   compact rows without notes/legs/teams (much smaller payload)
//   ?paged=1       one page of rows plus the whole filtered set's totals and the
//                  filter option lists: { rows, total, metrics, facets }
//   ?page / ?pageSize / ?sort=asc|desc / ?q / ?sport / ?book / ?res / ?day /
//   ?year / ?month  — filtering and paging, applied in the database
export async function GET(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const { searchParams } = new URL(req.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "", 10);
  const take = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  const where = await buildBetFilter(userId, searchParams);
  const desc = searchParams.get("sort") !== "asc";
  const orderBy = (
    desc ? [{ eventAt: "desc" }, { createdAt: "desc" }] : [{ eventAt: "asc" }, { createdAt: "asc" }]
  ) as never;

  if (searchParams.get("paged")) {
    return NextResponse.json(await pagedBets(userId, where, orderBy, searchParams));
  }
  if (searchParams.get("fields") === "list") {
    const bets = await prisma.bet.findMany({ where, orderBy, take, select: LIST_SELECT });
    return NextResponse.json(bets.map(serializeBetList));
  }
  const bets = await prisma.bet.findMany({ where, orderBy, take });
  return NextResponse.json(bets.map(serializeBet));
}

/**
 * Translate the bets page's filters into a Prisma where clause. Kept next to the
 * route so the query string is the single description of a filtered view — the
 * page mirrors these same names into the URL.
 */
async function buildBetFilter(userId: string, sp: URLSearchParams): Promise<Prisma.BetWhereInput> {
  const where: Prisma.BetWhereInput = { userId };
  const and: Prisma.BetWhereInput[] = [];

  const exactFilters = [
    ["league", "league"],
    ["sport", "sport"],
    ["bookmaker", "bookmaker"],
    ["marketCategory", "marketCategory"],
    ["marketScope", "marketScope"],
    ["eventKind", "eventKind"],
    ["tournamentStage", "tournamentStage"],
    ["outcome", "outcome"],
  ] as const;
  for (const [query, field] of exactFilters) {
    const value = sp.get(query)?.trim();
    if (value) (where as Record<string, unknown>)[field] = value;
  }

  // Result chips group several outcomes: a half-win is a win, void is a push.
  const res = sp.get("res")?.trim();
  const RES_GROUPS: Record<string, string[]> = {
    win: ["win", "half_win"],
    loss: ["loss", "half_loss"],
    pending: ["pending"],
    push: ["push", "void"],
  };
  if (res && RES_GROUPS[res]) where.outcome = { in: RES_GROUPS[res] };

  // Dates are filtered on the event's own time, falling back to when the bet was
  // placed — the same rule the list sorts and groups by.
  const day = sp.get("day")?.trim();
  const year = sp.get("year")?.trim();
  const month = sp.get("month")?.trim();
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    and.push(dateRange(new Date(`${day}T00:00:00`), new Date(`${day}T23:59:59.999`)));
  } else if (year || month) {
    const y = year ? parseInt(year, 10) : null;
    const mo = month ? parseInt(month, 10) : null;
    if (y && mo) and.push(dateRange(new Date(y, mo - 1, 1), new Date(y, mo, 1)));
    else if (y) and.push(dateRange(new Date(y, 0, 1), new Date(y + 1, 0, 1)));
    else if (mo) {
      // "Every June", with no year picked. Prisma's builder has no EXTRACT, so
      // expand it into one range per year the journal actually covers.
      const years = await journalYears(userId);
      and.push({
        OR: years.map((yr) => dateRange(new Date(yr, mo - 1, 1), new Date(yr, mo, 1))),
      });
    }
  }

  const q = sp.get("q")?.trim();
  if (q) {
    const contains = { contains: q, mode: "insensitive" } as const;
    and.push({
      OR: [
        { event: contains },
        { league: contains },
        { selection: contains },
        { bookmaker: contains },
        { marketCategory: contains },
        { tournamentStage: contains },
      ],
    });
  }

  if (and.length) where.AND = and;
  return where;
}

/** Distinct calendar years the journal covers, newest first. */
async function journalYears(userId: string): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ year: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM COALESCE("eventAt", "placedAt"))::int AS year
    FROM "Bet" WHERE "userId" = ${userId} ORDER BY year DESC`;
  return rows.map((r) => r.year);
}

/** eventAt within [from, to), falling back to placedAt when eventAt is null. */
function dateRange(from: Date, to: Date): Prisma.BetWhereInput {
  return {
    OR: [
      { eventAt: { gte: from, lt: to } },
      { eventAt: null, placedAt: { gte: from, lt: to } },
    ],
  };
}

/**
 * One page of rows, plus totals over the *whole* filtered set and the option
 * lists the filter controls need. The bets page used to download every row
 * (5.8 MB for a 10k-bet journal) purely to compute these three things in the
 * browser.
 */
async function pagedBets(
  userId: string,
  where: Prisma.BetWhereInput,
  orderBy: never,
  sp: URLSearchParams
) {
  const page = Math.max(0, parseInt(sp.get("page") ?? "0", 10) || 0);
  const pageSize = Math.min(500, Math.max(1, parseInt(sp.get("pageSize") ?? "100", 10) || 100));

  const [rows, total, aggRows, facets] = await Promise.all([
    prisma.bet.findMany({ where, orderBy, skip: page * pageSize, take: pageSize, select: LIST_SELECT }),
    prisma.bet.count({ where }),
    prisma.bet.findMany({ where, select: AGG_SELECT }),
    sp.get("facets") ? betFacets(userId) : Promise.resolve(null),
  ]);

  return {
    rows: rows.map(serializeBetList),
    total,
    metrics: computeMetrics(aggRows.map((b) => ({ ...b, outcome: b.outcome as Outcome }))),
    facets,
  };
}

/**
 * Distinct values for the filter dropdowns, over the whole journal rather than
 * the current filter — narrowing to one sport must not hide the other sports.
 */
async function betFacets(userId: string) {
  const distinct = async (field: "sport" | "league" | "bookmaker" | "marketCategory" | "marketScope") => {
    const rows = await prisma.bet.groupBy({ by: [field], where: { userId }, _count: true });
    return rows
      .map((r) => (r as Record<string, unknown>)[field] as string | null)
      .filter((v): v is string => !!v && v.trim() !== "");
  };

  const [sports, leagues, bookmakers, marketCategories, scopes, years] = await Promise.all([
    distinct("sport"),
    distinct("league"),
    distinct("bookmaker"),
    distinct("marketCategory"),
    distinct("marketScope"),
    journalYears(userId),
  ]);

  const sv = (a: string, b: string) => a.localeCompare(b, "sv");
  return {
    sports: sports.sort(sv),
    leagues: leagues.sort(sv),
    bookmakers: bookmakers.sort(sv),
    marketCategories: marketCategories.sort(sv),
    scopes,
    years: years.map(String),
  };
}

// POST /api/bets — create a bet.
export async function POST(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  try {
    const body = await req.json();
    const data = buildBetData(body, { partial: false });
    // Kvitto-import (parse-screenshot-flödet) skickar med referens + speltid;
    // samma semantik som scripts/agent/logBet.ts.
    if (typeof body.importRef === "string" && body.importRef.trim() !== "") {
      data.importRef = body.importRef.trim();
    }
    if (typeof body.placedAt === "string" && !Number.isNaN(new Date(body.placedAt).getTime())) {
      data.placedAt = new Date(body.placedAt);
    }
    const requestedOutcome = (data.outcome ?? "pending") as Outcome;
    if (requestedOutcome !== "pending") {
      data.outcome = "pending";
      data.profitUnits = null;
      data.gradedAt = null;
    }
    let bet = await prisma.bet.create({ data: { ...(data as object), userId } as never });
    // Football → TheStatsAPI (historical CLV). Other sports → Odds API if available.
    if (!isStatsLinked(bet.externalRef)) {
      if (isFootballBet(bet) && hasTheStatsApiKey()) {
        await tryLinkSingleFootballBet(bet.id, prisma).catch(() => {});
      } else if (!bet.externalRef) {
        await linkBetToOddsEvent(prisma, bet).catch(() => {});
      }
      bet = (await prisma.bet.findUnique({ where: { id: bet.id } })) ?? bet;
    }
    // If kickoff is within ~30 min, snapshot closing odds immediately.
    if (hasOddsApiKey()) {
      await maybeCaptureKickoffClvForBet(bet.id).catch(() => null);
      bet = (await prisma.bet.findUnique({ where: { id: bet.id } })) ?? bet;
    }
    if (requestedOutcome !== "pending") {
      const result = await settleBet(prisma, {
        betId: bet.id,
        userId,
        outcome: requestedOutcome,
        source: "manual",
        reason: "Betet skapades med ett avgjort resultat",
      });
      bet = result.bet;
    }
    return NextResponse.json(serializeBet(bet), { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error(e);
    return NextResponse.json({ error: "Failed to create bet" }, { status: 500 });
  }
}
