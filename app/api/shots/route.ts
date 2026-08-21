import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { buildShotScreen, SHOT_METRICS } from "@/lib/shotScreen";
import { SHOT_LEAGUES } from "@/lib/shotData";
import { hasShotsDb } from "@/lib/shotsDb";
import { DEFAULT_BLEND_W, type ShotMetric } from "@/lib/shotModel";

export const dynamic = "force-dynamic";

const LEAGUE_LIST = SHOT_LEAGUES.map((l) => ({ key: l.key, label: l.label }));

const LEAGUE_KEYS = new Set(SHOT_LEAGUES.map((l) => l.key));

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function numberParam(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

/** Kommaseparerad lista → filtrerad uppsättning, tom = allt. */
function listParam(raw: string | null, allowed: Set<string>): string[] | undefined {
  if (!raw) return undefined;
  const picked = raw.split(",").map((s) => s.trim()).filter((s) => allowed.has(s));
  return picked.length > 0 ? picked : undefined;
}

export async function GET(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();

  // Skottmodellen har en egen databas. Utan connection string finns inget att
  // läsa — svara tomt med en flagga i stället för att låta Prisma kasta.
  if (!hasShotsDb()) {
    return NextResponse.json({
      rows: [],
      meta: {
        leagues: [],
        fixtures: 0,
        pricedLines: 0,
        blendW: DEFAULT_BLEND_W,
        horizonDays: 7,
        missingOdds: false,
        dbConfigured: false,
      },
      leagues: LEAGUE_LIST,
    });
  }

  const url = new URL(req.url);
  const leagueKeys = listParam(url.searchParams.get("league"), LEAGUE_KEYS);
  const metrics = listParam(url.searchParams.get("metric"), new Set(SHOT_METRICS)) as ShotMetric[] | undefined;
  const horizonDays = numberParam(url.searchParams.get("days"), 7, 1, 30);
  const blendW = numberParam(url.searchParams.get("w"), DEFAULT_BLEND_W, 0, 1);
  const minEdge = numberParam(url.searchParams.get("minEdge"), 0, -1, 1);
  const limit = numberParam(url.searchParams.get("limit"), 300, 1, 1000);

  const data = await buildShotScreen({ leagueKeys, metrics, horizonDays, blendW, minEdge, limit });

  return NextResponse.json(
    { ...data, meta: { ...data.meta, dbConfigured: true }, leagues: LEAGUE_LIST },
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } }
  );
}
