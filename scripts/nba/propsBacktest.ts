/**
 * Backtest för spelarprops mot riktiga boxscores. Läser bara.
 *
 *   npm run nba:props-backtest
 *   npm run nba:props-backtest -- --from 2026-01-01 --to 2026-02-28
 *   npm run nba:props-backtest -- --prop usageSigma=0.15 --prop minutesSd=0.15
 *
 * Det finns inga historiska prop-linjer, så modellen jämförs med det naiva
 * sättet (spelarens snitt de senaste 10 matcherna) och mot en låtsaslinje på
 * det snittet. Täckningen (10–90 %) ska ligga nära 80 %.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { loadHistory } from "../../lib/nba/store";
import { runPropsBacktest } from "../../lib/nba/propsBacktest";
import { DEFAULT_PROP_PARAMS, PROP_LABEL, type PropParams, type PropStat } from "../../lib/nba/props";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const from = new Date(`${arg("--from") ?? "2025-12-01"}T00:00:00Z`);
  const to = arg("--to") ? new Date(`${arg("--to")}T23:59:59Z`) : new Date("2026-06-30T23:59:59Z");
  const pp: PropParams = { ...DEFAULT_PROP_PARAMS, sims: Number(arg("--sims")) || 1500 };
  process.argv.forEach((a, i) => {
    if (a !== "--prop") return;
    const [k, v] = String(process.argv[i + 1] ?? "").split("=");
    if (!(k in pp) || !Number.isFinite(Number(v))) throw new Error(`Okänd prop-parameter: ${process.argv[i + 1]}`);
    (pp as unknown as Record<string, number>)[k] = Number(v);
  });
  console.log("Laddar historik …");
  const h = await loadHistory(db, new Date(from.getTime() - 420 * 864e5));
  const games = await db.nbaGame.findMany({
    where: { status: "final", startAt: { gte: from, lte: to }, boxFetchedAt: { not: null }, homeScore: { not: null } },
    orderBy: { startAt: "asc" },
  });
  // Var tredje match räcker för stabila siffror och tar en tredjedel av tiden.
  const step = Number(arg("--every")) || 3;
  const list = games
    .filter((_, i) => i % step === 0)
    .map((g) => ({ id: g.id, t: g.startAt.getTime(), homeId: g.homeTeamId, awayId: g.awayTeamId, neutral: g.neutral, homeScore: g.homeScore!, awayScore: g.awayScore! }));
  console.log(`${list.length} matcher (var ${step}:e), spelare med minst 15 projicerade minuter`);
  let last = 0;
  const r = runPropsBacktest(h, list, {
    propParams: pp,
    onProgress: (d, n) => {
      if (d - last >= 50 || d === n) {
        last = d;
        process.stdout.write(`\r  ${d}/${n}`);
      }
    },
  });
  console.log("\n");
  console.log("Stat          n     MAE modell / naiv   bias   täckning 10–90   log loss modell / naiv");
  for (const [k, m] of Object.entries(r)) {
    console.log(
      `${PROP_LABEL[k as PropStat].padEnd(12)} ${String(m.n).padStart(5)}   ${m.maeModel.toFixed(2).padStart(6)} / ${m.maeNaive.toFixed(2).padEnd(6)}   ${m.biasModel.toFixed(2).padStart(5)}   ${(m.coverage80 * 100).toFixed(1).padStart(5)} %          ${m.logLossModel.toFixed(4)} / ${m.logLossNaive.toFixed(4)}`
    );
  }
  console.log("\nLägre MAE och log loss = bättre. Täckningen ska vara ~80 %: under = för smal fördelning, över = för bred.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
