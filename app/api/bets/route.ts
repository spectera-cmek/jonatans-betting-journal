import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet, serializeBetList } from "@/lib/types";
import { buildBetData, ValidationError } from "@/lib/betInput";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { settleBet } from "@/lib/settlement";
import { linkBetToOddsEvent } from "@/lib/eventLink";
import type { Outcome } from "@/lib/betting";

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
  stakeUnits: true,
  outcome: true,
  profitUnits: true,
  bookmaker: true,
  resultProvider: true,
  resultEventRef: true,
} as const;

// GET /api/bets — list the current user's bets, newest event first.
//   ?limit=N       cap the number of rows (e.g. the dashboard's recent list)
//   ?fields=list   compact rows without notes/legs/teams (much smaller payload)
export async function GET(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const { searchParams } = new URL(req.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "", 10);
  const take = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  const where: Prisma.BetWhereInput = { userId };
  const exactFilters = [
    ["league", "league"],
    ["marketCategory", "marketCategory"],
    ["marketScope", "marketScope"],
    ["eventKind", "eventKind"],
    ["tournamentStage", "tournamentStage"],
    ["outcome", "outcome"],
  ] as const;
  for (const [query, field] of exactFilters) {
    const value = searchParams.get(query)?.trim();
    if (value) (where as Record<string, unknown>)[field] = value;
  }
  const orderBy = [{ eventAt: "desc" }, { createdAt: "desc" }] as never;

  if (searchParams.get("fields") === "list") {
    const bets = await prisma.bet.findMany({ where, orderBy, take, select: LIST_SELECT });
    return NextResponse.json(bets.map(serializeBetList));
  }
  const bets = await prisma.bet.findMany({ where, orderBy, take });
  return NextResponse.json(bets.map(serializeBet));
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
    if (!bet.externalRef) {
      await linkBetToOddsEvent(prisma, bet).catch(() => {});
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
