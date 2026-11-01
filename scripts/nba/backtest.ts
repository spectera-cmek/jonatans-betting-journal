/**
 * Walk-forward-backtest av NBA-modellen mot slutresultat och stängningspris.
 * Läser bara — skriver något först med --save.
 *
 *   npm run nba:backtest                               # nuvarande säsong
 *   npm run nba:backtest -- --from 2025-11-15 --to 2026-04-15
 *   npm run nba:backtest -- --book pinnacle            # bara en boks stängning
 *   npm run nba:backtest -- --sims 8000 --save         # spara körningen (visas under Facit)
 *   npm run nba:backtest -- --param usageK=0.4 --param rubberBand=0.05   # prova andra parametrar
 *
 * Stängningspris: Pinnacle via OddsPapi-historiken (npm run nba:odds-history)
 * om det finns, annars ESPN:s DraftKings-linje.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { loadHistory } from "../../lib/nba/store";
import { runBacktest, type BacktestGame, type ClosingQuote } from "../../lib/nba/backtest";
import { DEFAULT_NBA_BLEND_W, DEFAULT_NBA_PARAMS, NBA_MODEL_VERSION, type NbaModelParams } from "../../lib/nba/params";
import type { NbaMarket } from "../../lib/nba/pricing";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

/** --param namn=värde (kan upprepas) skriver över modellens parametrar. */
function paramOverrides(): NbaModelParams {
  const p: NbaModelParams = { ...DEFAULT_NBA_PARAMS };
  process.argv.forEach((a, i) => {
    if (a !== "--param") return;
    const [k, v] = String(process.argv[i + 1] ?? "").split("=");
    if (!(k in p) || !Number.isFinite(Number(v))) throw new Error(`Okänd parameter eller värde: ${process.argv[i + 1]}`);
    (p as unknown as Record<string, number>)[k] = Number(v);
  });
  return p;
}

const SOURCE_RANK: Record<string, number> = { "oddspapi-history": 0, oddspapi: 1, espn: 2 };

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const to = arg("--to") ? new Date(`${arg("--to")}T23:59:59Z`) : new Date();
  // Standard: från 1 december — modellen behöver några veckor av säsongen först.
  const defFrom = new Date(Date.UTC(to.getUTCMonth() >= 9 ? to.getUTCFullYear() : to.getUTCFullYear() - 1, 11, 1));
  const from = arg("--from") ? new Date(`${arg("--from")}T00:00:00Z`) : defFrom;
  const sims = Number(arg("--sims")) || 4000;
  const book = arg("--book");
  const params = paramOverrides();
  const changed = Object.entries(params).filter(([k, v]) => (DEFAULT_NBA_PARAMS as unknown as Record<string, number>)[k] !== v);
  if (changed.length) console.log(`Parametrar: ${changed.map(([k, v]) => `${k}=${v}`).join(", ")}`);

  console.log(`Laddar historik …`);
  const h = await loadHistory(db, new Date(from.getTime() - 420 * 864e5));
  const games = await db.nbaGame.findMany({
    where: { status: "final", startAt: { gte: from, lte: to }, homeScore: { not: null }, boxFetchedAt: { not: null } },
    orderBy: { startAt: "asc" },
    include: { odds: { where: { source: { in: Object.keys(SOURCE_RANK) } }, orderBy: { capturedAt: "desc" } } },
  });
  const list: BacktestGame[] = [];
  const closing = new Map<number, ClosingQuote[]>();
  for (const g of games) {
    list.push({ id: g.id, t: g.startAt.getTime(), homeId: g.homeTeamId, awayId: g.awayTeamId, neutral: g.neutral, homeScore: g.homeScore!, awayScore: g.awayScore! });
    const q: ClosingQuote[] = [];
    for (const m of ["ml", "spread", "total"] as NbaMarket[]) {
      const cands = g.odds
        .filter((o) => o.market === m && o.capturedAt <= g.startAt && (!book || o.book === book))
        .sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) || b.capturedAt.getTime() - a.capturedAt.getTime());
      const c = cands[0];
      if (c) q.push({ market: m, line: c.line, price1: c.price1, price2: c.price2, book: c.book });
    }
    closing.set(g.id, q);
  }
  console.log(`${list.length} matcher ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}, ${sims} simuleringar per match`);
  let last = 0;
  const r = runBacktest(h, list, closing, {
    sims,
    params,
    onProgress: (d, n) => {
      if (d - last >= 100 || d === n) {
        last = d;
        process.stdout.write(`\r  ${d}/${n}`);
      }
    },
  });
  console.log("\n");
  const f = (x: number | null | undefined, d = 2) => (x == null ? "—" : x.toFixed(d));
  console.log(`Matcher: ${r.games}   Stängningspris från: ${r.books.join(", ") || "—"}`);
  console.log(`Marginal  MAE modell ${f(r.margin.maeModel)}  marknad ${f(r.margin.maeMarket)}  bias ${f(r.margin.bias)}  spridning verklig ${f(r.margin.residualSd)} / sim ${f(r.margin.simSd)}`);
  console.log(`Total     MAE modell ${f(r.total.maeModel)}  marknad ${f(r.total.maeMarket)}  bias ${f(r.total.bias)}  spridning verklig ${f(r.total.residualSd)} / sim ${f(r.total.simSd)}`);
  console.log("");
  for (const [m, x] of Object.entries(r.markets)) {
    if (!x) continue;
    console.log(
      `${m.padEnd(7)} n=${x.n}  log loss modell ${f(x.logLossModel, 4)} marknad ${f(x.logLossMarket, 4)}  ` +
        `bästa vikt ${x.bestW} (nu ${DEFAULT_NBA_BLEND_W[m as NbaMarket]})  spel ≥5 %: ${x.bets}${x.roi != null ? `, ROI ${(x.roi * 100).toFixed(1)} %` : ""}`
    );
    console.log(`        ${x.blend.map((b) => `${b.w}:${b.logLoss.toFixed(4)}`).join("  ")}`);
  }
  console.log("");
  console.log("Läsguide: vikt 0 = bara marknaden. Om bästa vikt är 0 slår modellen inte marknaden än.");
  console.log("Bias > 0 = verkligheten högre än modellen. Sim-spridning ska ligga nära den verkliga.");

  if (process.argv.includes("--save")) {
    const run = await db.nbaBacktestRun.create({
      data: {
        modelVersion: NBA_MODEL_VERSION,
        fromDate: from,
        toDate: to,
        games: r.games,
        params: { ...params, sims, book, blendW: DEFAULT_NBA_BLEND_W } as object,
        metrics: JSON.parse(JSON.stringify(r)),
      },
    });
    console.log(`Sparad som körning #${run.id}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
