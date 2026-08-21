/**
 * Batch OddsPortal CLV scrape for featured markets (h2h / totals / spreads).
 *
 *   npx tsx scripts/scrapeClv.ts                         # dry-run: list + scrape, no DB writes
 *   npx tsx scripts/scrapeClv.ts --confirm               # write closingOdds
 *   npx tsx scripts/scrapeClv.ts --confirm --since-days 90 --limit 50
 *   npx tsx scripts/scrapeClv.ts --confirm --since 2026-05-01
 *   npx tsx scripts/scrapeClv.ts --list                  # list candidates only (no browser)
 *
 * Local only (Playwright). Schedule via Task Scheduler, e.g. every hour.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import {
  captureClosingFromOddsPortal,
  listFeaturedClvCandidates,
} from "../lib/clvOddsPortalBatch";

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const listOnly = process.argv.includes("--list");
  const dryRun = !confirm;
  const limitRaw = argValue("--limit");
  const sinceRaw = argValue("--since");
  const sinceDaysRaw = argValue("--since-days");
  const graceRaw = argValue("--grace-minutes");
  const allowLive = process.argv.includes("--allow-live");

  const limit = limitRaw ? Number(limitRaw) : 50;
  const sinceDate = sinceRaw ? new Date(sinceRaw) : undefined;
  const sinceDays = sinceDaysRaw
    ? Number(sinceDaysRaw)
    : sinceDate
      ? undefined
      : 14;
  const graceMinutes = graceRaw ? Number(graceRaw) : 15;

  console.log(`Mode: ${listOnly ? "LIST" : dryRun ? "DRY-RUN" : "CONFIRM"}`);
  if (sinceDate) console.log(`Since: ${sinceDate.toISOString().slice(0, 10)}`);
  else if (sinceDays) console.log(`Since-days: ${sinceDays}`);
  console.log(`Limit: ${limit}`);
  console.log(
    `Post-kickoff: ${allowLive ? "off (--allow-live)" : `on (grace ${graceMinutes} min)`}`
  );

  if (listOnly) {
    const candidates = await listFeaturedClvCandidates({
      prisma,
      limit,
      sinceDate,
      sinceDays,
      graceMinutes,
      postKickoffOnly: !allowLive,
    });
    console.log(`\n${candidates.length} kandidater:`);
    for (const b of candidates) {
      const when = b.eventAt ? b.eventAt.toISOString().slice(0, 16) : "?";
      console.log(
        `  ${b.id.slice(0, 8)}  ${when}  ${b.market.padEnd(7)}  ${b.event}  (${b.selection} @ ${b.odds})`
      );
    }
    return;
  }

  if (dryRun) {
    console.warn(
      "Dry-run scrapar OddsPortal men skriver inte till DB. Använd --confirm för att spara."
    );
  }

  const result = await captureClosingFromOddsPortal({
    prisma,
    dryRun,
    limit: Number.isFinite(limit) ? limit : 50,
    sinceDate,
    sinceDays: sinceDate ? undefined : sinceDays,
    graceMinutes: Number.isFinite(graceMinutes) ? graceMinutes : 15,
    postKickoffOnly: !allowLive,
  });

  console.log(
    `\nKandidater ${result.candidates}, scrapade ${result.attempted}, uppdaterade ${result.updated}, misslyckade ${result.failed}`
  );
  for (const d of result.details) console.log(`  ${d}`);

  console.log(
    dryRun
      ? `\nDry-run klar. Kör med --confirm för att spara ${result.updated} closing-odds.`
      : `\nKlart: ${result.updated} closing uppdaterade.`
  );

  if (result.failed > 0 && result.updated === 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
