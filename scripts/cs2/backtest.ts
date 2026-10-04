/**
 * Walk-forward-backtest av CS2-modellen på allt i databasen.
 *
 *   npm run cs2:backtest                 # skriver ut resultatet
 *   npm run cs2:backtest -- --save       # sparar det också (visas under Facit på /cs2)
 *   npm run cs2:backtest -- --months 12 --refit-days 7 --warmup 150
 *
 * Varje karta prissätts bara med kartor som spelats före den. Resultatet
 * säger om kartvinnarmodellen slår myntkast, om rundlinjerna är kalibrerade
 * och vilken dispersion φ kills-modellen borde ha (se DEFAULT_KILL_PHI).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { cs2Prisma as prisma, hasCs2Db } from "../../lib/cs2Db";
import { runBacktest, type BacktestMap } from "../../lib/cs2/backtest";
import { CS2_MODEL_VERSION } from "../../lib/cs2/pricing";

function numberArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

async function main() {
  if (!hasCs2Db()) {
    console.error("CS2_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const since = new Date(Date.now() - numberArg("--months", 12) * 30 * 86_400_000);
  const rows = await prisma.cs2Map.findMany({
    where: { playedAt: { gte: since }, statsFetchedAt: { not: null } },
    include: { playerStats: { where: { side: "all" }, select: { playerId: true, teamId: true, kills: true, headshots: true } } },
    orderBy: { playedAt: "asc" },
  });
  const maps: BacktestMap[] = rows.map((r) => ({ ...r, players: r.playerStats }));
  console.log(`${maps.length} kartor sedan ${since.toISOString().slice(0, 10)}`);
  const s = runBacktest(maps, { refitDays: numberArg("--refit-days", 7), warmupMaps: numberArg("--warmup", 150) });

  console.log(`\nKartvinnare (n=${s.mapWinner.n}): log-loss ${s.mapWinner.logLoss.toFixed(4)} mot myntkast ${s.mapWinner.baselineLogLoss.toFixed(4)} · Brier ${s.mapWinner.brier.toFixed(4)} · träff ${pct(s.mapWinner.accuracy)}`);
  console.log(`Rundor (n=${s.rounds.n}): medelfel ${s.rounds.meanError.toFixed(2)} · MAE ${s.rounds.mae.toFixed(2)} · log-loss Ö${s.rounds.overLine} ${s.rounds.logLoss.toFixed(4)}`);
  console.log(`Kills (n=${s.kills.n}): medelfel ${s.kills.meanError.toFixed(2)} · MAE ${s.kills.mae.toFixed(2)} · över fair line ${pct(s.kills.overRate)} (kalibrerat ≈ 50 %) · skattat φ ${s.kills.phi?.toFixed(1) ?? "∞ (Poisson)"}`);
  for (const [name, cal] of [["Kartvinnare", s.mapWinner.calibration], ["Kills över", s.kills.calibration]] as const) {
    console.log(`\n${name} — kalibrering (predikterat → utfall, n):`);
    for (const b of cal) console.log(`  ${pct(b.predicted).padStart(7)} → ${pct(b.observed).padStart(7)}  (${b.n})`);
  }
  for (const n of s.notes) console.log(`\n⚠ ${n}`);

  if (process.argv.includes("--save")) {
    await prisma.cs2BacktestRun.create({ data: { modelVersion: CS2_MODEL_VERSION, summary: s as unknown as object } });
    console.log("\nSparat — syns under Facit på /cs2.");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
