import { NextResponse } from "next/server";
import { getOdds, hasOddsApiKey } from "@/lib/oddsApi";
import { scanValuePlays, type ValueScanResult } from "@/lib/valueScanner";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CACHE_MS = 60_000;
const cache = new Map<string, { expiresAt: number; result: ValueScanResult }>();

// GET /api/odds/value?sport=soccer_epl
// Scans a single H2H/1X2 board. One sport per request keeps Odds API credit
// usage understandable and lets the user choose the competitions that matter.
export async function GET(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasOddsApiKey()) {
    return NextResponse.json({ error: "ODDS_API_KEY saknas. Lägg till den i .env.local för att använda oddsjämförelsen." }, { status: 503 });
  }

  const sport = new URL(req.url).searchParams.get("sport")?.trim();
  if (!sport) return NextResponse.json({ error: "sport is required" }, { status: 400 });

  const cached = cache.get(sport);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ ...cached.result, generatedAt: new Date().toISOString(), cached: true });
  }

  try {
    const events = await getOdds(sport, { regions: "eu,uk", markets: "h2h" });
    const result = scanValuePlays(events);
    cache.set(sport, { expiresAt: Date.now() + CACHE_MS, result });
    return NextResponse.json({ ...result, generatedAt: new Date().toISOString(), cached: false });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
