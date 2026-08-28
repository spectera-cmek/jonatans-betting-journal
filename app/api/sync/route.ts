import { NextResponse } from "next/server";
import {
  runGrade,
  runClosing,
  runFullSync,
  runGradeByScores,
  runLinkEvents,
  runClosingNearKickoff,
  runClosingHistorical,
} from "@/lib/sync";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";
// Linking + odds fetch can take a while on larger journals.
export const maxDuration = 60;

// POST /api/sync?kind=grade|closing|all|scores|link|odds-closing|historical-clv
// "scores" uses the free, keyless ESPN scoreboard lookup (no Odds API needed).
// "odds-closing" captures near-kickoff CLV via The Odds API.
// "historical-clv" captures closing retroactively from Odds API snapshots — the
// only path that works once kickoff has passed.
// OddsPortal scrape is CLI-only (`npm run scrape:clv`) — not available here.
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
          : kind === "odds-closing"
            ? await runClosingNearKickoff()
          : kind === "historical-clv"
            ? await runClosingHistorical({ limit: 40, maxCredits: 1200 })
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
