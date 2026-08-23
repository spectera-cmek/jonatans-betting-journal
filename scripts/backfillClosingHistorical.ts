/**
 * True closing lines from The Odds API's /historical snapshots.
 *
 *   npx tsx scripts/backfillClosingHistorical.ts                       # dry-run
 *   npx tsx scripts/backfillClosingHistorical.ts --confirm --limit 25
 *   npx tsx scripts/backfillClosingHistorical.ts --confirm --since-days 90 \
 *     --max-credits 2000
 *
 * Requires a PAID Odds API plan: a snapshot costs 10 × markets × regions. The
 * run groups bets per event so that price is paid once per event, prints what
 * each call actually cost, and stops on either --max-credits or the plan's own
 * remaining balance (see DEFAULT_CREDIT_RESERVE) rather than draining the quota
 * the nightly settle run depends on.
 *
 * Safe to re-run: a captured bet is marked clvFinal and never re-fetched.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { hasOddsApiKey } from "../lib/oddsApi";
import { captureHistoricalClosing, DEFAULT_CREDIT_RESERVE } from "../lib/clvHistorical";
import { oddsApiCreditStatus } from "../lib/oddsApiUsage";

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function num(flag: string, fallback: number): number {
  const raw = argValue(flag);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const dryRun = !confirm;
  const limit = num("--limit", 50);
  const sinceDays = num("--since-days", 400);
  const graceMinutes = num("--grace-minutes", 0);
  const maxCredits = argValue("--max-credits") ? num("--max-credits", 0) : undefined;
  const creditReserve = num("--credit-reserve", DEFAULT_CREDIT_RESERVE);
  const regions = argValue("--regions") ?? "eu";

  if (!hasOddsApiKey()) {
    console.error("ODDS_API_KEY is not set in .env.local");
    process.exit(1);
  }

  const before = await oddsApiCreditStatus();
  console.log(`Mode:        ${dryRun ? "DRY-RUN (inget skrivs)" : "CONFIRM"}`);
  console.log(`Window:      senaste ${sinceDays} dagar, minst ${graceMinutes} min efter avspark`);
  console.log(`Limit:       ${limit} bets · regions=${regions}`);
  console.log(
    `Credits:     ${before.remaining ?? "okänt"} kvar` +
      (maxCredits != null ? ` · tak ${maxCredits} denna körning` : "") +
      ` · reserv ${creditReserve}`
  );
  console.log("");

  const result = await captureHistoricalClosing({
    prisma,
    dryRun,
    limit,
    sinceDays,
    graceMinutes,
    regions,
    maxCredits,
    creditReserve,
  });

  for (const line of result.details) console.log(`  ${line}`);
  console.log("");
  console.log(
    `Klart: ${result.closingUpdated} stängning, ${result.failed} misslyckade, ` +
      `${result.events} event, ${result.creditsSpent} krediter.`
  );
  if (result.stoppedEarly) console.log(`Avbröts: ${result.stoppedEarly}`);
  if (dryRun && result.closingUpdated > 0) {
    console.log("Kör om med --confirm för att spara.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
