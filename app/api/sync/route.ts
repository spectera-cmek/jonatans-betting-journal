import { NextResponse } from "next/server";
import { runGrade, runClosing, runFullSync, runGradeByScores, runLinkEvents } from "@/lib/sync";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/sync?kind=grade|closing|all|scores|link
// "scores" uses the free, keyless ESPN scoreboard lookup (no Odds API needed).
// Sync is deliberately global: it grades pending bets for ALL users against
// objective final scores, regardless of who triggers it.
export async function POST(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind") || "all";
  try {
    const result =
      kind === "scores"
        ? await runGradeByScores()
        : kind === "link"
          ? await runLinkEvents()
        : kind === "grade"
          ? await runGrade()
          : kind === "closing"
            ? await runClosing()
            : await runFullSync();
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { ok: false, message: (e as Error).message, linked: 0, graded: 0, closingUpdated: 0, details: [] },
      { status: 500 }
    );
  }
}
