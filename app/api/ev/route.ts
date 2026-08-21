import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { buildEvMatches, EV_LEAGUES, EV_MARKETS } from "@/lib/evScreen";
import { hasShotsDb } from "@/lib/shotsDb";
import type { OddsMarket } from "@/lib/marketOdds";

export const dynamic = "force-dynamic";

const LEAGUE_LIST = EV_LEAGUES.map((l) => ({ key: l.key, label: l.label }));
const LEAGUE_KEYS = new Set(EV_LEAGUES.map((l) => l.key));

function numberParam(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function listParam(raw: string | null, allowed: Set<string>): string[] | undefined {
  if (!raw) return undefined;
  const picked = raw.split(",").map((s) => s.trim()).filter((s) => allowed.has(s));
  return picked.length > 0 ? picked : undefined;
}

export async function GET(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();

  if (!hasShotsDb()) {
    return NextResponse.json({
      matches: [],
      meta: {
        leagues: LEAGUE_LIST,
        fixtures: 0,
        pricedOutcomes: 0,
        suppressedDisagreement: 0,
        handicapSignWarnings: [],
        missingPrices: false,
        capturedAt: null,
        dbConfigured: false,
      },
    });
  }

  const url = new URL(req.url);
  const data = await buildEvMatches({
    leagueKeys: listParam(url.searchParams.get("league"), LEAGUE_KEYS),
    markets: listParam(url.searchParams.get("market"), new Set(EV_MARKETS)) as OddsMarket[] | undefined,
    minEdge: numberParam(url.searchParams.get("minEdge"), 0, -1, 1),
    horizonDays: numberParam(url.searchParams.get("days"), 14, 1, 30),
    limit: numberParam(url.searchParams.get("limit"), 100, 1, 300),
  });

  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" },
  });
}
