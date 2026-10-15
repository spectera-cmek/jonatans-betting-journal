import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { latestPerLine, summarizeFacit } from "@/lib/cs2/settle";
import type { BacktestSummary } from "@/lib/cs2/backtest";
import { noCs2Db } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// GET /api/cs2/facit — senaste backtestet och utfallet för sparade linjer.
export async function GET() {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const run = await cs2Prisma.cs2BacktestRun.findFirst({ orderBy: { createdAt: "desc" } });
  const rows = await cs2Prisma.cs2Projection.findMany({
    where: { settledAt: { not: null }, actual: { not: null } },
    select: {
      id: true,
      matchId: true,
      lineId: true,
      market: true,
      scope: true,
      playerId: true,
      player2Id: true,
      teamId: true,
      line: true,
      actual: true,
      pModel: true,
      pMarket: true,
      pFinal: true,
      bestSide: true,
      bestOdds: true,
      edgePct: true,
    },
  });
  // Boken bor på linjen; en linje i flera versioner räknas en gång (se latestPerLine).
  const lineIds = rows.flatMap((r) => (r.lineId != null ? [r.lineId] : []));
  const books = new Map(
    (await cs2Prisma.cs2Line.findMany({ where: { id: { in: lineIds } }, select: { id: true, bookmaker: true } })).map((l) => [l.id, l.bookmaker])
  );
  const latest = latestPerLine(rows.map((r) => ({ ...r, bookmaker: r.lineId != null ? books.get(r.lineId) ?? null : null })));
  const open = await cs2Prisma.cs2Projection.count({ where: { settledAt: null } });
  return NextResponse.json({
    dbConfigured: true,
    backtest: run ? { createdAt: run.createdAt.toISOString(), modelVersion: run.modelVersion, summary: run.summary as unknown as BacktestSummary } : null,
    lines: { open, ...summarizeFacit(latest.map((r) => ({ ...r, actual: r.actual! }))) },
  });
}
