/**
 * Walk-forward-backtest av NBA-modellen mot slutresultat och stängningspris.
 * Läser bara — skriver något först med --save.
 *
 *   npm run nba:backtest                               # nuvarande säsong
 *   npm run nba:backtest -- --from 2025-11-15 --to 2026-04-15
 *   npm run nba:backtest -- --book pinnacle            # bara en boks stängning
 *   npm run nba:backtest -- --line bet                 # mot Pinnacles pris 12 h före start + CLV
 *                                                      (kräver npm run nba:odds-history först)
 *   npm run nba:backtest -- --line bet --lineup actual # som ovan, men modellen vet vilka som spelade (fusk)
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
import { loadHistory, loadStints } from "../../lib/nba/store";
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
/** --line bet: utvärdera mot speltidspriset, med stängningen som facit för CLV. */
const BET_RANK: Record<string, number> = { "oddspapi-bet": 0 };

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
  const betMode = arg("--line") === "bet";
  const evalRank = betMode ? BET_RANK : SOURCE_RANK;
  // Mot speltidspriset är det ärliga att bara veta det som var känt på morgonen.
  const lineupArg = arg("--lineup");
  const lineup: "actual" | "prev" = lineupArg === "actual" || lineupArg === "prev" ? lineupArg : betMode ? "prev" : "actual";
  console.log(
    lineup === "prev"
      ? "Laguppställning: förra matchens spelare (inga besked från matchdagen) — --lineup actual för de som faktiskt spelade"
      : "Laguppställning: de som faktiskt spelade (vet sena strykningar)"
  );
  const params = paramOverrides();
  const changed = Object.entries(params).filter(([k, v]) => (DEFAULT_NBA_PARAMS as unknown as Record<string, number>)[k] !== v);
  if (changed.length) console.log(`Parametrar: ${changed.map(([k, v]) => `${k}=${v}`).join(", ")}`);

  console.log(`Laddar historik …`);
  const h = await loadHistory(db, new Date(from.getTime() - 420 * 864e5));
  // Stintar för RAPM bara när den används (de är många).
  const stints = params.rapmK > 0 ? await loadStints(db, new Date(from.getTime() - 800 * 864e5)) : undefined;
  if (stints) console.log(`${stints.length} stintar för RAPM`);
  const games = await db.nbaGame.findMany({
    where: { status: "final", startAt: { gte: from, lte: to }, homeScore: { not: null }, boxFetchedAt: { not: null } },
    orderBy: { startAt: "asc" },
    include: { odds: { where: { source: { in: [...Object.keys(SOURCE_RANK), ...Object.keys(BET_RANK)] } }, orderBy: { capturedAt: "desc" } } },
  });
  const list: BacktestGame[] = [];
  const closing = new Map<number, ClosingQuote[]>();
  const closeLines = new Map<number, ClosingQuote[]>();
  const pick = (g: (typeof games)[number], m: NbaMarket, rank: Record<string, number>) =>
    g.odds
      .filter((o) => o.market === m && o.capturedAt <= g.startAt && o.source in rank && (!book || o.book === book))
      .sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9) || b.capturedAt.getTime() - a.capturedAt.getTime())[0];
  for (const g of games) {
    list.push({ id: g.id, t: g.startAt.getTime(), homeId: g.homeTeamId, awayId: g.awayTeamId, neutral: g.neutral, seasonType: g.seasonType, homeScore: g.homeScore!, awayScore: g.awayScore! });
    const q: ClosingQuote[] = [];
    const cl: ClosingQuote[] = [];
    for (const m of ["ml", "spread", "total"] as NbaMarket[]) {
      const c = pick(g, m, evalRank);
      if (c) q.push({ market: m, line: c.line, price1: c.price1, price2: c.price2, book: c.book });
      const k = pick(g, m, SOURCE_RANK);
      if (k) cl.push({ market: m, line: k.line, price1: k.price1, price2: k.price2, book: k.book });
    }
    if (betMode && !q.length) {
      list.pop(); // utan speltidspris finns inget att utvärdera
      continue;
    }
    closing.set(g.id, q);
    if (betMode) closeLines.set(g.id, cl);
  }
  console.log(`${list.length} matcher ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}, ${sims} simuleringar per match`);
  let last = 0;
  if (betMode && !list.length) {
    console.log("Inga matcher med speltidspris — kör npm run nba:odds-history -- --confirm först.");
    return;
  }
  const r = runBacktest(h, list, closing, {
    sims,
    params,
    closeLines: betMode ? closeLines : undefined,
    stints,
    lineup,
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
  console.log(`Marginal  MAE modell ${f(r.margin.maeModel)} (samma matcher som marknaden: ${f(r.margin.maeModelSame)})  marknad ${f(r.margin.maeMarket)}  bias ${f(r.margin.bias)}  spridning verklig ${f(r.margin.residualSd)} / sim ${f(r.margin.simSd)}`);
  console.log(`Total     MAE modell ${f(r.total.maeModel)} (samma matcher som marknaden: ${f(r.total.maeModelSame)})  marknad ${f(r.total.maeMarket)}  bias ${f(r.total.bias)}  spridning verklig ${f(r.total.residualSd)} / sim ${f(r.total.simSd)}`);
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
  for (const [mk, buckets] of Object.entries(r.ats)) {
    if (!buckets) continue;
    console.log(
      `Picks ${mk.padEnd(6)} ` +
        buckets
          .map(
            (b) =>
              `${b.minEdge}+: ${b.w}-${b.l}-${b.p} ${b.hit == null ? "—" : (b.hit * 100).toFixed(1) + " %"}${b.roi == null ? "" : ` ROI ${(b.roi * 100).toFixed(1)} %`}` +
              (b.clv == null ? "" : ` CLV ${b.clv >= 0 ? "+" : ""}${b.clv.toFixed(2)} p${b.clvBeat == null ? "" : ` (${(b.clvBeat * 100).toFixed(0)} % slog stängningen)`}`)
          )
          .join("   ")
    );
  }
  for (const [mk, c] of Object.entries(r.clv ?? {})) {
    if (!c) continue;
    const [a, b] = mk === "total" ? ["över", "under"] : ["hemma", "borta"];
    const side = (x: { n: number; clv: number | null; beat: number | null }) =>
      `${x.n} st, CLV ${x.clv == null ? "—" : `${x.clv >= 0 ? "+" : ""}${x.clv.toFixed(2)} p`}${x.beat == null ? "" : ` (${(x.beat * 100).toFixed(0)} %)`}`;
    console.log(
      `CLV-koll ${mk.padEnd(6)} modellens ${a}: ${side(c.side1)}   modellens ${b}: ${side(c.side2)}   ` +
        `alltid ${a}: ${side(c.always1)}   t = ${c.t == null ? "—" : c.t.toFixed(1)}`
    );
  }
  if (r.clv) console.log("CLV-koll: positiv CLV på båda sidorna och t > 2 = skicklighet. Bara på en sida, lika stor som \"alltid\" = linjerna driver bara.");
  console.log(
    betMode
      ? "Break-even vid −110 (1,91): 52,4 %. Picks mot Pinnacle vid speltid. CLV = poäng linjen rörde sig mot modellens sida till stängning — positiv CLV över många spel är det starkaste tecknet på en riktig edge."
      : "Break-even vid −110 (1,91): 52,4 %. Picks räknas mot stängningslinjen — svårare än första linjen."
  );
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
