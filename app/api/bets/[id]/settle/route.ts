import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeBet } from "@/lib/types";
import { profitUnits, type Outcome } from "@/lib/betting";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

const OUTCOMES: Outcome[] = [
  "pending",
  "win",
  "loss",
  "push",
  "half_win",
  "half_loss",
  "void",
];

// POST /api/bets/:id/settle  body: { outcome }
// Quick manual settlement from the bet log.
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  try {
    const { outcome } = (await req.json()) as { outcome?: string };
    const o = (outcome || "").toLowerCase() as Outcome;
    if (!OUTCOMES.includes(o)) {
      return NextResponse.json({ error: "invalid outcome" }, { status: 400 });
    }

    // Scoped lookup: another user's bet id looks like a 404, not a 403.
    const existing = await prisma.bet.findFirst({ where: { id: params.id, userId } });
    if (!existing) {
      return NextResponse.json({ error: "Bet not found" }, { status: 404 });
    }

    const isPending = o === "pending";
    const bet = await prisma.bet.update({
      where: { id: params.id },
      data: {
        outcome: o,
        profitUnits: isPending
          ? null
          : profitUnits(o, existing.odds, existing.stakeUnits),
        gradedAt: isPending ? null : new Date(),
      },
    });
    return NextResponse.json(serializeBet(bet));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to settle bet" }, { status: 500 });
  }
}
