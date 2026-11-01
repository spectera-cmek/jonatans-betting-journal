import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { nbaPrisma, hasNbaDb } from "@/lib/nbaDb";
import { noNbaDb } from "@/lib/nba/api";
import { NBA_EDGE_THRESHOLD, isFlagged } from "@/lib/nba/params";

export const dynamic = "force-dynamic";

const ll = (p: number, y: number) => -(y * Math.log(Math.max(1e-6, p)) + (1 - y) * Math.log(Math.max(1e-6, 1 - p)));

// GET /api/nba/facit — hur modellens sparade priser gått (live) och sparade
// backtest-körningar (npm run nba:backtest -- --save).
export async function GET() {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const [settled, runs] = await Promise.all([
    nbaPrisma.nbaProjection.findMany({ where: { actual: { not: null } } }),
    nbaPrisma.nbaBacktestRun.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const live = ["ml", "spread", "total"].map((market) => {
    const rows = settled.filter((p) => p.market === market);
    const decided = rows.filter((p) => p.actual !== 0.5);
    const withMarket = decided.filter((p) => p.pMarket != null);
    let bets = 0;
    let profit = 0;
    for (const p of rows) {
      const e1 = p.edge1 ?? -1;
      const e2 = p.edge2 ?? -1;
      const side1 = e1 >= e2;
      if (!isFlagged(Math.max(e1, e2), side1 ? p.price1 : p.price2)) continue;
      bets++;
      if (p.actual === 0.5) continue;
      const won = side1 ? p.actual === 1 : p.actual === 0;
      const price = side1 ? p.price1 : p.price2;
      profit += won && price ? price - 1 : -1;
    }
    const avg = (f: (p: (typeof decided)[number]) => number, l = decided) => (l.length ? l.reduce((a, p) => a + f(p), 0) / l.length : null);
    return {
      market,
      n: decided.length,
      logLossModel: avg((p) => ll(p.pModel, p.actual!)),
      logLossFinal: avg((p) => ll(p.pFinal, p.actual!)),
      logLossMarket: avg((p) => ll(p.pMarket!, p.actual!), withMarket),
      nMarket: withMarket.length,
      bets,
      roi: bets ? profit / bets : null,
    };
  });
  return NextResponse.json({
    dbConfigured: true,
    threshold: NBA_EDGE_THRESHOLD,
    live,
    runs: runs.map((r) => ({ id: r.id, createdAt: r.createdAt, modelVersion: r.modelVersion, fromDate: r.fromDate, toDate: r.toDate, games: r.games, metrics: r.metrics })),
  });
}
