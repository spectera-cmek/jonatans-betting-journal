import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { buildGradingQueue } from "@/lib/gradingQueue";
import { settleBet } from "@/lib/settlement";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const { searchParams } = new URL(req.url);
  const league = searchParams.get("league")?.trim() || undefined;
  const suggestions = await buildGradingQueue(prisma, userId, { league });
  return NextResponse.json(suggestions);
}

export async function POST(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const body = (await req.json()) as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 100)
    : [];
  if (!ids.length) {
    return NextResponse.json({ error: "Välj minst ett rättningsförslag." }, { status: 400 });
  }

  const suggestions = await buildGradingQueue(prisma, userId, {
    ids,
    limit: ids.length,
  });
  const details: string[] = [];
  let settled = 0;
  for (const suggestion of suggestions) {
    if (suggestion.readiness !== "ready" || !suggestion.suggestedOutcome) {
      details.push(`${suggestion.event}: ${suggestion.reason}`);
      continue;
    }
    try {
      if (suggestion.resultEventRef) {
        await prisma.bet.updateMany({
          where: { id: suggestion.betId, userId },
          data: { resultProvider: "espn", resultEventRef: suggestion.resultEventRef },
        });
      }
      const result = await settleBet(prisma, {
        betId: suggestion.betId,
        userId,
        outcome: suggestion.suggestedOutcome,
        source: "espn",
        reason: suggestion.reason,
      });
      if (result.changed) settled += 1;
      details.push(`${suggestion.event}: ${suggestion.suggestedOutcome}`);
    } catch (error) {
      details.push(`${suggestion.event}: ${(error as Error).message}`);
    }
  }
  return NextResponse.json({
    settled,
    requested: ids.length,
    details,
  });
}
