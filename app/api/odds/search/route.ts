import { NextResponse } from "next/server";
import { getOdds, hasOddsApiKey, bestPriceFor } from "@/lib/oddsApi";

export const dynamic = "force-dynamic";

// GET /api/odds/search?sport=soccer_epl&q=arsenal
// Returns upcoming events for a sport, filtered by query, with H2H prices to autofill.
export async function GET(req: Request) {
  if (!hasOddsApiKey()) {
    return NextResponse.json({ error: "No ODDS_API_KEY set", events: [] }, { status: 200 });
  }

  const { searchParams } = new URL(req.url);
  const sport = searchParams.get("sport");
  const q = (searchParams.get("q") || "").toLowerCase();

  if (!sport) {
    return NextResponse.json({ error: "sport is required", events: [] }, { status: 400 });
  }

  try {
    const events = await getOdds(sport, { markets: "h2h" });
    const filtered = events
      .filter((e) => {
        if (!q) return true;
        return (
          e.home_team.toLowerCase().includes(q) ||
          e.away_team.toLowerCase().includes(q)
        );
      })
      .slice(0, 25)
      .map((e) => ({
        id: e.id,
        sportKey: e.sport_key,
        sportTitle: e.sport_title,
        commenceTime: e.commence_time,
        homeTeam: e.home_team,
        awayTeam: e.away_team,
        homePrice: bestPriceFor(e, "h2h", e.home_team),
        awayPrice: bestPriceFor(e, "h2h", e.away_team),
        drawPrice: bestPriceFor(e, "h2h", "Draw"),
      }));

    return NextResponse.json({ events: filtered });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, events: [] }, { status: 502 });
  }
}
