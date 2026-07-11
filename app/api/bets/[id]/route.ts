import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet } from "@/lib/types";
import { buildBetData, ValidationError } from "@/lib/betInput";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/bets/:id — full bet (the list endpoint serves compact rows; the
// edit modal needs every field).
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const bet = await prisma.bet.findFirst({ where: { id: params.id, userId } });
  if (!bet) return NextResponse.json({ error: "Bet not found" }, { status: 404 });
  return NextResponse.json(serializeBet(bet));
}

// PATCH /api/bets/:id — update fields on a bet (must belong to the current user).
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  try {
    // Scoped lookup: another user's bet id looks like a 404, not a 403.
    const existing = await prisma.bet.findFirst({ where: { id: params.id, userId } });
    if (!existing) {
      return NextResponse.json({ error: "Bet not found" }, { status: 404 });
    }
    const body = await req.json();
    if (body.outcome !== undefined && body.outcome !== existing.outcome) {
      return NextResponse.json(
        { error: "Ändra resultat via rättningsknappen så historiken sparas." },
        { status: 400 }
      );
    }
    if (
      existing.outcome !== "pending" &&
      ((body.odds !== undefined && Number(body.odds) !== existing.odds) ||
        (body.stakeUnits !== undefined && Number(body.stakeUnits) !== existing.stakeUnits))
    ) {
      return NextResponse.json(
        { error: "Ångra rättningen innan odds eller insats ändras på ett avgjort bet." },
        { status: 409 }
      );
    }
    delete body.outcome;
    const data = buildBetData(body, {
      partial: true,
      existing: {
        odds: existing.odds,
        stakeUnits: existing.stakeUnits,
        outcome: existing.outcome,
      },
    });
    const bet = await prisma.bet.update({
      where: { id: params.id },
      data: data as never,
    });
    return NextResponse.json(serializeBet(bet));
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error(e);
    return NextResponse.json({ error: "Failed to update bet" }, { status: 500 });
  }
}

// DELETE /api/bets/:id
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  try {
    const { count } = await prisma.bet.deleteMany({ where: { id: params.id, userId } });
    if (count === 0) {
      return NextResponse.json({ error: "Bet not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to delete bet" }, { status: 500 });
  }
}
