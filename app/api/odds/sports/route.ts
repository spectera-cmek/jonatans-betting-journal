import { NextResponse } from "next/server";
import { getSports, hasOddsApiKey } from "@/lib/oddsApi";
import { isAuthed, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/odds/sports — list available sports from The Odds API.
export async function GET() {
  if (!isAuthed()) return apiUnauthorized();
  if (!hasOddsApiKey()) {
    return NextResponse.json({ error: "No ODDS_API_KEY set", sports: [] }, { status: 200 });
  }
  try {
    const sports = await getSports();
    return NextResponse.json({ sports });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, sports: [] }, { status: 502 });
  }
}
