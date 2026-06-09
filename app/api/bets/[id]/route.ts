import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet } from "@/lib/types";
import { buildBetData, ValidationError } from "@/lib/betInput";
import { isAuthed, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// PATCH /api/bets/:id — update fields on a bet.
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  if (!isAuthed()) return apiUnauthorized();
  try {
    const existing = await prisma.bet.findUnique({ where: { id: params.id } });
    if (!existing) {
      return NextResponse.json({ error: "Bet not found" }, { status: 404 });
    }
    const body = await req.json();
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
  if (!isAuthed()) return apiUnauthorized();
  try {
    await prisma.bet.delete({ where: { id: params.id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to delete bet" }, { status: 500 });
  }
}
