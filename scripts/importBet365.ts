// Import / sync real bet history from a bet365 account-statement PDF.
//
// Usage:
//   npm run import:bet365                 # dry-run: parse + print stats, DB untouched
//   npm run import:bet365 -- --confirm    # INCREMENTAL: settle pending + add new slips
//                                         #   (matches on slip ref, never wipes, keeps
//                                         #    manually-added bets & enrichment)
//   npm run import:bet365 -- --confirm --wipe   # full reset: delete all, re-import
//   npm run import:bet365 -- --sample 8   # also print first N parsed slips
//
// Parsing + DB logic live in lib/bet365.mts (shared with the in-app import button).
// Profit is taken from the ACTUAL payout column (after tax), not recomputed.

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import {
  parseSlipsFromBuffer,
  slipOutcome,
  combinedOdds,
  importSlips,
  CONTROL_STAKE,
  CONTROL_PAYOUT,
  UNIT_KR,
  type Slip,
} from "../lib/bet365";

const PDF_PATH = process.env.BET365_PDF || "./statement.pdf";

function fmt(n: number): string {
  return n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printStats(slips: Slip[]) {
  let stake = 0;
  let payout = 0;
  const byOutcome: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let noOdds = 0;
  let zeroStake = 0;
  for (const s of slips) {
    stake += s.stakeKr;
    payout += s.payoutKr;
    const o = slipOutcome(s);
    byOutcome[o] = (byOutcome[o] || 0) + 1;
    byType[s.type] = (byType[s.type] || 0) + 1;
    if (combinedOdds(s) === null && o !== "void") noOdds++;
    if (s.stakeKr === 0 && o !== "pending") zeroStake++;
  }

  console.log(`\nParsed slips: ${slips.length}`);
  console.log("By type:", byType);
  console.log("By outcome:", byOutcome);
  console.log(`Slips with odds truncated in source PDF (non-void): ${noOdds} (estimated from payout where won)`);
  console.log(`Slips with unreadable stake (non-pending): ${zeroStake}`);
  if (CONTROL_STAKE > 0 && CONTROL_PAYOUT > 0) {
    console.log(`\nSum stake:   ${fmt(stake)} kr   (control ${fmt(CONTROL_STAKE)} kr, diff ${fmt(stake - CONTROL_STAKE)} / ${((stake / CONTROL_STAKE - 1) * 100).toFixed(2)}%)`);
    console.log(`Sum payout:  ${fmt(payout)} kr   (control ${fmt(CONTROL_PAYOUT)} kr, diff ${fmt(payout - CONTROL_PAYOUT)} / ${((payout / CONTROL_PAYOUT - 1) * 100).toFixed(2)}%)`);
  } else {
    console.log(`\nSum stake:   ${fmt(stake)} kr`);
    console.log(`Sum payout:  ${fmt(payout)} kr`);
  }
  console.log(`Net P/L:     ${fmt(payout - stake)} kr  = ${fmt((payout - stake) / UNIT_KR)} units`);
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const wipe = args.includes("--wipe");
  const sampleN = args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1]) || 8 : 0;

  console.log(`Reading ${PDF_PATH} ...`);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const slips = await parseSlipsFromBuffer(data);

  printStats(slips);

  if (sampleN) {
    console.log(`\n--- First ${sampleN} slips ---`);
    for (const s of slips.slice(0, sampleN)) {
      console.log(`\n[${s.date}] ${s.ref} ${s.type}  stake=${s.stakeKr} payout=${s.payoutKr} -> ${slipOutcome(s)} odds=${combinedOdds(s)}`);
      for (const l of s.legs) console.log(`   * "${l.selection}" | ${l.event} | mkt=${l.market} | odds=${l.odds} | ${l.outcome}`);
    }
  }

  if (!confirm) {
    console.log("\nDRY RUN — database not touched.");
    console.log("  --confirm         incremental: settle pending + add new (recommended)");
    console.log("  --confirm --wipe  full reset: delete all + re-import");
    return;
  }

  const prisma = new PrismaClient();
  try {
    if (wipe) {
      const existing = await prisma.bet.count();
      console.log(`\n--wipe: deleting ${existing} existing bets, then re-importing ...`);
    } else {
      console.log(`\n--confirm: incremental import (matching on slip ref) ...`);
    }
    const summary = await importSlips(prisma, slips, {
      wipe,
      onProgress: (done, total) => {
        if (done % 500 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
      },
    });
    console.log("\nDone.");
    if (summary.wiped) {
      console.log(`  Imported ${summary.added} bets (wiped first).`);
    } else {
      console.log(`  Added new:        ${summary.added}`);
      console.log(`  Newly settled:    ${summary.settled}`);
      console.log(`  Updated (outcome/profit changed): ${summary.updated}`);
      console.log(`  importRef backfilled: ${summary.refBackfilled}`);
      console.log(`  Unchanged:        ${summary.unchanged}`);
    }
    console.log(`  Net P/L over parsed slips: ${fmt(summary.netUnits)} units (${fmt(summary.netUnits * UNIT_KR)} kr)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
