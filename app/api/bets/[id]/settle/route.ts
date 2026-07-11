import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet } from "@/lib/types";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import {
  SettlementError,
  settleBet,
  undoLastSettlement,
  serializeSettlement,
} from "@/lib/settlement";
import type { Outcome } from "@/lib/betting";

export const dynamic = "force-dynamic";

function settlementError(error: unknown) {
  if (error instanceof SettlementError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  console.error(error);
  return NextResponse.json({ error: "Rättningen misslyckades." }, { status: 500 });
}

// GET /api/bets/:id/settle — per-bet audit history.
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const bet = await prisma.bet.findFirst({
    where: { id: params.id, userId },
    select: { id: true },
  });
  if (!bet) return NextResponse.json({ error: "Bet not found" }, { status: 404 });
  const rows = await prisma.betSettlement.findMany({
    where: { betId: bet.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(rows.map(serializeSettlement));
}

// POST /api/bets/:id/settle
// body: { outcome, reason?, correct? }. A correction is always explicit.
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  try {
    const body = (await req.json()) as {
      outcome?: string;
      reason?: string;
      correct?: boolean;
    };
    const outcome = (body.outcome || "").toLowerCase() as Outcome;
    if (body.correct && !body.reason?.trim()) {
      return NextResponse.json(
        { error: "Ange en anledning när en tidigare rättning korrigeras." },
        { status: 400 }
      );
    }
    const result = await settleBet(prisma, {
      betId: params.id,
      userId,
      outcome,
      source: "manual",
      reason: body.reason || "Manuell rättning",
      allowCorrection: body.correct === true,
    });
    return NextResponse.json({
      bet: serializeBet(result.bet),
      settlement: result.settlement ? serializeSettlement(result.settlement) : null,
      changed: result.changed,
    });
  } catch (e) {
    return settlementError(e);
  }
}

// DELETE /api/bets/:id/settle — undo the latest non-reverted settlement.
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  try {
    const result = await undoLastSettlement(prisma, { betId: params.id, userId });
    return NextResponse.json({
      bet: serializeBet(result.bet),
      settlement: result.settlement ? serializeSettlement(result.settlement) : null,
      changed: result.changed,
    });
  } catch (error) {
    return settlementError(error);
  }
}
