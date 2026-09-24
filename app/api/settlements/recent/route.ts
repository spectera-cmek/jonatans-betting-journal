import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { serializeSettlement } from "@/lib/settlement";
import type { RecentSettlementDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_ROWS = 500;

// GET /api/settlements/recent?days=14 — every settlement the last N days,
// whoever made it (nightly cron, agent, the sync button, a click), with enough
// of the bet to judge at a glance whether it was graded right. Undo stays on
// DELETE /api/bets/:id/settle; `undoable` says whether that would succeed.
export async function GET(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const raw = parseInt(new URL(req.url).searchParams.get("days") ?? "", 10);
  const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 90) : 14;

  const rows = await prisma.betSettlement.findMany({
    where: { createdAt: { gte: new Date(Date.now() - days * 864e5) }, bet: { userId } },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    include: {
      bet: {
        select: {
          id: true,
          event: true,
          selection: true,
          sport: true,
          league: true,
          bookmaker: true,
          betType: true,
          odds: true,
          stakeUnits: true,
          eventAt: true,
          outcome: true,
          profitUnits: true,
        },
      },
    },
  });

  // Only a bet's newest live settlement can be undone, and only while the bet
  // still holds what that settlement wrote (undoLastSettlement's own guard).
  const newestLive = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.revertedAt || seen.has(r.betId)) continue;
    seen.add(r.betId);
    newestLive.add(r.id);
  }

  const out: RecentSettlementDTO[] = rows.map((r) => ({
    ...serializeSettlement(r),
    undoable:
      newestLive.has(r.id) &&
      r.bet.outcome === r.toOutcome &&
      (r.bet.profitUnits ?? null) === (r.toProfitUnits ?? null),
    bet: {
      ...r.bet,
      eventAt: r.bet.eventAt?.toISOString() ?? null,
    },
  }));
  return NextResponse.json(out);
}
