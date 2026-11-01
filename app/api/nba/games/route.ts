import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { nbaPrisma, hasNbaDb } from "@/lib/nbaDb";
import { noNbaDb } from "@/lib/nba/api";
import { NBA_EDGE_THRESHOLD, NBA_MAX_FLAG_ODDS } from "@/lib/nba/params";

export const dynamic = "force-dynamic";

// GET /api/nba/games?days=2 — kommande (och nyss spelade) matcher med
// modellens senaste projektioner. Projektionerna skrivs av npm run nba:update.
export async function GET(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const url = new URL(req.url);
  const days = Math.min(14, Math.max(1, Number(url.searchParams.get("days")) || 2));
  const past = url.searchParams.get("past") === "1";
  const now = Date.now();
  const where = past
    ? { status: "final", startAt: { gte: new Date(now - days * 864e5), lte: new Date(now) } }
    : { startAt: { gte: new Date(now - 4 * 3600e3), lte: new Date(now + days * 864e5) }, status: { in: ["scheduled", "live"] } };
  const [games, teams] = await Promise.all([
    nbaPrisma.nbaGame.findMany({ where, orderBy: { startAt: past ? "desc" : "asc" }, include: { projections: true, picks: true }, take: 120 }),
    nbaPrisma.nbaTeam.findMany(),
  ]);
  const t = new Map(teams.map((x) => [x.id, { id: x.id, abbr: x.abbr, name: x.name }]));
  const lastRun = await nbaPrisma.nbaProjection.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
  // Lagens V-F i grundserien den säsong matcherna spelas.
  const seasons = [...new Set(games.map((g) => g.season))];
  const finals = seasons.length
    ? await nbaPrisma.nbaGame.findMany({
        where: { season: { in: seasons }, seasonType: 2, status: "final" },
        select: { season: true, startAt: true, homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true },
      })
    : [];
  /** V-F före matchen (så att spelade matcher visar rekordet inför matchen). */
  const record = (teamId: number, season: number, before: Date) => {
    let w = 0;
    let l = 0;
    for (const f of finals) {
      if (f.season !== season || f.startAt >= before || f.homeScore == null || f.awayScore == null) continue;
      if (f.homeTeamId !== teamId && f.awayTeamId !== teamId) continue;
      const won = f.homeTeamId === teamId ? f.homeScore > f.awayScore : f.awayScore > f.homeScore;
      if (won) w++;
      else l++;
    }
    return `${w}-${l}`;
  };
  return NextResponse.json({
    dbConfigured: true,
    lastRun: lastRun?.updatedAt ?? null,
    threshold: NBA_EDGE_THRESHOLD,
    maxOdds: NBA_MAX_FLAG_ODDS,
    games: games.map((g) => ({
      id: g.id,
      startAt: g.startAt,
      status: g.status,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      home: t.get(g.homeTeamId),
      away: t.get(g.awayTeamId),
      homeRecord: record(g.homeTeamId, g.season, g.startAt),
      awayRecord: record(g.awayTeamId, g.season, g.startAt),
      picks: g.picks.map((k) => ({
        market: k.market,
        book: k.book,
        line: k.line,
        modelLine: k.modelLine,
        side: k.side,
        edgePts: k.edgePts,
        price: k.side === 1 ? k.price1 : k.price2,
        lockedAt: k.lockedAt,
        result: k.result,
        clv: k.clv,
      })),
      projections: g.projections.map((p) => ({
        market: p.market,
        line: p.line,
        pModel: p.pModel,
        pMarket: p.pMarket,
        pFinal: p.pFinal,
        fair1: p.fair1,
        fair2: p.fair2,
        book: p.book,
        price1: p.price1,
        price2: p.price2,
        edge1: p.edge1,
        edge2: p.edge2,
        homeMean: p.homeMean,
        awayMean: p.awayMean,
        actual: p.actual,
        updatedAt: p.updatedAt,
      })),
    })),
  });
}
