import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { fetchClvForBet } from "@/lib/clvScrape";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/bets/:id/clv — scrape OddsPortal closing (or live) odds for one bet.
export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();

  try {
    const result = await fetchClvForBet(params.id, { userId });
    if (!result.ok) {
      const status =
        result.code === "missing_fields"
          ? 400
          : result.code === "blocked" || result.code === "browser_error"
            ? 502
            : 404;
      return NextResponse.json(
        {
          error: result.detail,
          code: result.code,
          detail: result.detail,
          closingOdds: null,
          clvPct: null,
        },
        { status }
      );
    }

    return NextResponse.json({
      closingOdds: result.closingOdds,
      clvPct: result.clvPct,
      bookmakerUsed: result.bookmakerUsed,
      matchUrl: result.matchUrl,
      provisional: result.provisional,
      detail: result.detail,
    });
  } catch (e) {
    console.error("[clv scrape]", e);
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "CLV-hämtning misslyckades.",
        detail: e instanceof Error ? e.message : "CLV-hämtning misslyckades.",
      },
      { status: 500 }
    );
  }
}
