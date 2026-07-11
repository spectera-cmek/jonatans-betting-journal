import { prisma } from "@/lib/db";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/bets/export — download the current user's bet log as CSV.
export async function GET() {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();
  const bets = await prisma.bet.findMany({
    where: { userId },
    orderBy: [{ eventAt: "desc" }, { createdAt: "desc" }],
  });

  const headers = [
    "eventAt",
    "sport",
    "league",
    "event",
    "market",
    "marketCategory",
    "marketScope",
    "eventKind",
    "tournamentStage",
    "selection",
    "selectionSide",
    "line",
    "odds",
    "closingOdds",
    "stakeUnits",
    "outcome",
    "profitUnits",
    "bookmaker",
    "tipster",
    "resultProvider",
    "resultEventRef",
    "notes",
  ];

  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = bets.map((b) =>
    [
      b.eventAt ? b.eventAt.toISOString().slice(0, 10) : "",
      b.sport,
      b.league,
      b.event,
      b.market,
      b.marketCategory,
      b.marketScope,
      b.eventKind,
      b.tournamentStage,
      b.selection,
      b.selectionSide,
      b.line,
      b.odds,
      b.closingOdds,
      b.stakeUnits,
      b.outcome,
      b.profitUnits,
      b.bookmaker,
      b.tipster,
      b.resultProvider,
      b.resultEventRef,
      b.notes,
    ]
      .map(escape)
      .join(",")
  );

  const csv = [headers.join(","), ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bets-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
