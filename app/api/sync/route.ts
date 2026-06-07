import { NextResponse } from "next/server";
import { runGrade, runClosing, runFullSync, runGradeByScores } from "@/lib/sync";

export const dynamic = "force-dynamic";

// POST /api/sync?kind=grade|closing|all|scores
// "scores" uses the free, keyless ESPN scoreboard lookup (no Odds API needed).
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind") || "all";
  try {
    const result =
      kind === "scores"
        ? await runGradeByScores()
        : kind === "grade"
          ? await runGrade()
          : kind === "closing"
            ? await runClosing()
            : await runFullSync();
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { ok: false, message: (e as Error).message, graded: 0, closingUpdated: 0, details: [] },
      { status: 500 }
    );
  }
}
