/**
 * Hämta closing odds i efterhand ur The Odds API:s historik.
 *
 *   npx tsx scripts/backfillHistoricalClv.ts                        # dry-run, 30 spel
 *   npx tsx scripts/backfillHistoricalClv.ts --confirm              # spara
 *   npx tsx scripts/backfillHistoricalClv.ts --confirm --since-days 90 --limit 200 --max-credits 5000
 *
 * Krediter: 1 per matchlista, 10 per marknad och match. Taket (--max-credits)
 * gäller körningen; --min-remaining lämnar en buffert kvar av månadskvoten.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { hasOddsApiKey } from "../lib/oddsApi";
import { captureHistoricalClv } from "../lib/clvHistorical";

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function num(flag: string, fallback: number): number {
  const raw = Number(argValue(flag));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

async function main() {
  const confirm = process.argv.includes("--confirm");

  if (!hasOddsApiKey()) {
    console.error("ODDS_API_KEY saknas i .env.local");
    process.exit(1);
  }

  const sinceDays = num("--since-days", 60);
  const limit = num("--limit", confirm ? 100 : 30);
  const maxCredits = num("--max-credits", 3000);
  const minRemaining = num("--min-remaining", 500);

  console.log(`Läge:      ${confirm ? "SPARAR" : "DRY-RUN"}`);
  console.log(`Fönster:   ${sinceDays} dagar bakåt`);
  console.log(`Tak:       ${limit} spel, ${maxCredits} krediter (buffert ${minRemaining})\n`);

  const result = await captureHistoricalClv({
    prisma,
    dryRun: !confirm,
    sinceDays,
    limit,
    maxCredits,
    minRemaining,
    deadlineMs: Date.now() + 30 * 60 * 1000,
  });

  for (const d of result.details) console.log(`  ${d}`);

  console.log(
    `\n${result.scanned} genomsökta · ${result.eligible} hämtbara · ${result.linked} länkade · ` +
      `${result.closingUpdated} closing · ${result.failed} miss`
  );
  console.log(
    `Krediter: ${result.creditsSpent} spenderade, ${result.remaining ?? "?"} kvar av månadskvoten.`
  );
  if (result.stopped) console.log(`Stoppad: ${result.stopped}`);
  if (!confirm) console.log("\nDry-run — kör med --confirm för att spara.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
