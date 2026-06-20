import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet, serializeBetList } from "@/lib/types";
import { buildBetData, ValidationError } from "@/lib/betInput";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Columns for the compact list shape (fields=list). Keep in sync with BetListDTO.
const LIST_SELECT = {
  id: true,
  placedAt: true,
  eventAt: true,
  sport: true,
  league: true,
  event: true,
  market: true,
  marketCategory: true,
  marketScope: true,
  selection: true,
  betType: true,
  odds: true,
  stakeUnits: true,
  outcome: true,
  profitUnits: true,
  bookmaker: true,
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
  const where = { userId };
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
    const bet = await prisma.bet.create({ data: { ...(data as object), userId } as never });
    return NextResponse.json(serializeBet(bet), { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error(e);
    return NextResponse.json({ error: "Failed to create bet" }, { status: 500 });
  }
}
