import { NextResponse } from "next/server";
import { runFullSync, runGradeByScores } from "@/lib/sync";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/sync?kind=all|scores — both grade from the free, keyless ESPN
// scoreboard. OddsPortal CLV scrape is CLI-only (`npm run scrape:clv`).
// Sync is deliberately global: it grades pending bets for ALL users against
// objective final scores, regardless of who triggers it.
export async function POST(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind") || "all";
  try {
    const result = kind === "scores" ? await runGradeByScores() : await runFullSync();
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { ok: false, message: (e as Error).message, linked: 0, graded: 0, closingUpdated: 0, details: [] },
      { status: 500 }
    );
  }
}
