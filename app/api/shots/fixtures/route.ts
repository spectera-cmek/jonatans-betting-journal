import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { buildFixtureProjections } from "@/lib/shotScreen";
import { SHOT_LEAGUES } from "@/lib/shotData";
import { hasShotsDb } from "@/lib/shotsDb";

export const dynamic = "force-dynamic";

const LEAGUE_LIST = SHOT_LEAGUES.map((l) => ({ key: l.key, label: l.label }));

/**
 * Kommande matcher med modellens väntevärden per mätetal.
 *
 * Finns för att kunna prissätta odds från böcker API:et inte täcker — Betsson,
 * Bethard och NordicBet har skottlinjer på Allsvenskan, men ingen av dem finns
 * i TheStatsAPI. Klienten räknar edgen lokalt ur λ och dispersion, så den kan
 * uppdatera medan man skriver utan ett anrop per tangenttryck.
 */
export async function GET(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();

  if (!hasShotsDb()) {
    return NextResponse.json({ fixtures: [], leagues: LEAGUE_LIST, dbConfigured: false });
  }

  const url = new URL(req.url);
  const leagueRaw = url.searchParams.get("league");
  const allowed = new Set(SHOT_LEAGUES.map((l) => l.key));
  const leagueKeys = leagueRaw
    ? leagueRaw.split(",").map((s) => s.trim()).filter((s) => allowed.has(s))
    : undefined;
  const daysRaw = Number(url.searchParams.get("days"));
  const horizonDays = Number.isFinite(daysRaw) ? Math.min(30, Math.max(1, daysRaw)) : 10;

  const fixtures = await buildFixtureProjections({
    leagueKeys: leagueKeys?.length ? leagueKeys : undefined,
    horizonDays,
  });

  return NextResponse.json(
    { fixtures, leagues: LEAGUE_LIST, dbConfigured: true },
    { headers: { "Cache-Control": "private, max-age=120, stale-while-revalidate=600" } }
  );
}
