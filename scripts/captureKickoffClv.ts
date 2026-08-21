/**
 * Near-kickoff CLV via The Odds API (live ≈ closing).
 *
 *   npx tsx scripts/captureKickoffClv.ts              # dry-run
 *   npx tsx scripts/captureKickoffClv.ts --confirm    # write closingOdds
 *   npx tsx scripts/captureKickoffClv.ts --confirm --before 30 --after 15
 *
 * Also runs automatically from `npm run sync` / Synka when TheStatsAPI is absent.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { hasOddsApiKey } from "../lib/oddsApi";
import { captureClosingNearKickoff } from "../lib/clvOddsApi";

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const dryRun = !confirm;
  const before = Number(argValue("--before") ?? "30");
  const after = Number(argValue("--after") ?? "5");
  const limit = Number(argValue("--limit") ?? "40");

  if (!hasOddsApiKey()) {
    console.error("ODDS_API_KEY is not set in .env.local");
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? "DRY-RUN" : "CONFIRM"}`);
  console.log(`Window: -${after} / +${before} min around kickoff`);
  console.log(`Limit: ${limit}`);

  const result = await captureClosingNearKickoff({
    prisma,
    dryRun,
    beforeMinutes: Number.isFinite(before) ? before : 30,
    afterMinutes: Number.isFinite(after) ? after : 5,
    limit: Number.isFinite(limit) ? limit : 40,
  });

  console.log(
    `\nLänkade ${result.linked}, closing ${result.closingUpdated}, miss ${result.failed}`
  );
  for (const d of result.details) console.log(`  ${d}`);

  console.log(
    dryRun
      ? `\nDry-run klar. Kör med --confirm för att spara.`
      : `\nKlart: ${result.closingUpdated} closing uppdaterade.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
