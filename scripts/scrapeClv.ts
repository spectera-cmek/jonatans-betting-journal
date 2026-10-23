/**
 * Batch OddsPortal CLV scrape for featured markets (h2h / totals / spreads).
 *
 *   npx tsx scripts/scrapeClv.ts                         # dry-run: list + scrape, no DB writes
 *   npx tsx scripts/scrapeClv.ts --confirm               # write closingOdds
 *   npx tsx scripts/scrapeClv.ts --confirm --since-days 90 --limit 50
 *   npx tsx scripts/scrapeClv.ts --confirm --since 2026-05-01
 *   npx tsx scripts/scrapeClv.ts --list                  # list candidates only (no browser)
 *   npx tsx scripts/scrapeClv.ts --scrapling             # fetch through Scrapling instead of Playwright
 *   npx tsx scripts/scrapeClv.ts --compare --limit 10    # both fetchers side by side, no DB writes
 *
 * Local only (Playwright / Scrapling). Schedule via Task Scheduler, e.g. every hour.
 * --scrapling is an experiment: run --compare on a handful of bets before
 * switching a scheduled run over.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { clvPct } from "../lib/betting";
import {
  captureClosingFromOddsPortal,
  compareOddsPortalFetchers,
  listFeaturedClvCandidates,
  type FetcherComparisonRow,
} from "../lib/clvOddsPortalBatch";
import type { ScrapeClosingResult } from "../lib/oddsPortal";

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
  const compare = process.argv.includes("--compare");
  const fetcher = process.argv.includes("--scrapling") ? "scrapling" : "playwright";

  const limit = limitRaw ? Number(limitRaw) : 50;
  const sinceDate = sinceRaw ? new Date(sinceRaw) : undefined;
  const sinceDays = sinceDaysRaw
    ? Number(sinceDaysRaw)
    : sinceDate
      ? undefined
      : 14;
  const graceMinutes = graceRaw ? Number(graceRaw) : 15;

  console.log(`Mode: ${listOnly ? "LIST" : compare ? "COMPARE (no DB writes)" : dryRun ? "DRY-RUN" : "CONFIRM"}`);
  if (!listOnly && !compare) console.log(`Fetcher: ${fetcher}`);
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

  if (compare) {
    const rows = await compareOddsPortalFetchers({
      prisma,
      limit: Number.isFinite(limit) ? limit : 50,
      sinceDate,
      sinceDays: sinceDate ? undefined : sinceDays,
      graceMinutes: Number.isFinite(graceMinutes) ? graceMinutes : 15,
      postKickoffOnly: !allowLive,
    });
    printComparison(rows);
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
    fetcher,
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

function cell(r: ScrapeClosingResult, yours: number): string {
  if (!r.ok || r.closingOdds == null) return `– (${r.code ?? "fel"})`;
  const pct = clvPct(yours, r.closingOdds);
  return `${r.closingOdds.toFixed(2)} ${r.bookmakerUsed ?? ""}${pct == null ? "" : ` ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}`;
}

function printComparison(rows: FetcherComparisonRow[]) {
  if (rows.length === 0) {
    console.log("\nInga kandidater att jämföra.");
    return;
  }
  // Startade inte Playwright alls är det samma fel på varje rad — säg det en gång.
  if (rows.every((r) => r.playwright.code === "browser_error")) {
    console.log(`\nPlaywright startade inte: ${rows[0].playwright.detail}`);
    if (/Executable doesn't exist|playwright install/i.test(rows[0].playwright.detail)) {
      console.log("  Ladda ner webbläsaren en gång med: npx playwright install chromium");
    }
  }
  let both = 0;
  let onlyPw = 0;
  let onlySc = 0;
  let differ = 0;
  console.log("");
  for (const { bet, playwright, scrapling } of rows) {
    const p = playwright.ok && playwright.closingOdds != null;
    const s = scrapling.ok && scrapling.closingOdds != null;
    if (p && s) both += 1;
    else if (p) onlyPw += 1;
    else if (s) onlySc += 1;
    const diff = p && s && Math.abs(playwright.closingOdds! - scrapling.closingOdds!) >= 0.02;
    if (diff) differ += 1;
    console.log(`${diff ? "≠" : " "} ${bet.event} · ${bet.selection} @ ${bet.odds.toFixed(2)}`);
    console.log(`    Playwright: ${cell(playwright, bet.odds)}`);
    console.log(`    Scrapling:  ${cell(scrapling, bet.odds)}`);
    if (!s && scrapling.detail) console.log(`                ${scrapling.detail}`);
  }
  console.log(
    `\n${rows.length} bets · båda fick odds ${both} · bara Playwright ${onlyPw} · bara Scrapling ${onlySc} · olika odds (≥0.02) ${differ}`
  );
  console.log("Olika odds är väntat när vägarna valt olika bolag eller linje — se bolagsnamnet.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
