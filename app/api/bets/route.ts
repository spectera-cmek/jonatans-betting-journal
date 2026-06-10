import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet } from "@/lib/types";
import { buildBetData, ValidationError } from "@/lib/betInput";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/bets — list the current user's bets, newest event first.
export async function GET() {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const bets = await prisma.bet.findMany({
    where: { userId },
    orderBy: [{ eventAt: "desc" }, { createdAt: "desc" }],
  });
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
