/**
 * Backfill CLV (closing odds) for older football bets via TheStatsAPI.
 *
 *   npx tsx scripts/backfillClv.ts                    # dry-run (consumes API quota!)
 *   npx tsx scripts/backfillClv.ts --confirm          # write to DB
 *   npx tsx scripts/backfillClv.ts --since 2026-06-01
 *   npx tsx scripts/backfillClv.ts --limit 50
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { PrismaClient } from "@prisma/client";
import { hasTheStatsApiKey } from "../lib/theStatsApi";
import { linkBetsToStatsMatches, captureClosingOdds } from "../lib/clvCapture";

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const dryRun = !confirm;
  const limitRaw = argValue("--limit");
  const sinceRaw = argValue("--since");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const sinceDate = sinceRaw ? new Date(sinceRaw) : undefined;

  if (!hasTheStatsApiKey()) {
    console.error("THESTATSAPI_KEY is not set in .env.local");
    process.exit(1);
  }

  console.warn(
    "⚠ Dry-run still calls TheStatsAPI and consumes your monthly quota. Use --confirm to write results."
  );

  const opts = {
    dryRun,
    limit: Number.isFinite(limit) ? limit : undefined,
    sinceDate,
    sinceDays: sinceDate ? undefined : 90,
    prisma,
  };

  console.log(`Mode: ${dryRun ? "DRY-RUN" : "CONFIRM"}`);
  if (sinceDate) console.log(`Since: ${sinceDate.toISOString().slice(0, 10)}`);
  if (opts.limit) console.log(`Limit: ${opts.limit}`);

  const link = await linkBetsToStatsMatches(opts);
  console.log(`\nLink: ${link.linked} bet(s)`);
  for (const d of link.details) console.log(`  ${d}`);

  const closing = await captureClosingOdds(opts);
  console.log(`\nClosing: ${closing.closingUpdated} bet(s)`);
  for (const d of closing.details) console.log(`  ${d}`);

  console.log(
    dryRun
      ? `\nDry-run klar. Kör med --confirm för att spara ${link.linked} länkar och ${closing.closingUpdated} closing-odds.`
      : `\nKlart: ${link.linked} länkade, ${closing.closingUpdated} closing uppdaterade.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
