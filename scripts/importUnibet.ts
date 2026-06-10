// Import real bet history from a Unibet "Transaktionshistorik" CSV export.
//
// Usage:
//   npm run import:unibet -- <file.csv>                # dry-run: parse + print stats
//   npm run import:unibet -- <file.csv> --confirm --user <username>
//                                                      # incremental import into that account
//   npm run import:unibet -- <file.csv> --sample 10    # also print first N coupons
//
// --user is required with --confirm: coupons are imported into that account's log.
//
// The CSV is a transaction ledger (no team names / odds / markets). Parsing + DB logic
// live in lib/unibet.ts. Profit is taken from the actual cash movements (after tax),
// never recomputed from odds. Cash deposits/withdrawals are ignored.

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import {
  parseCouponRows,
  buildCoupons,
  couponOutcome,
  couponOdds,
  importCoupons,
  UNIT_KR,
  type Coupon,
} from "../lib/unibet";

function fmt(n: number): string {
  return n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printStats(coupons: Coupon[]) {
  const usable = coupons.filter((c) => c.hasStake && c.stakeKr > 0);
  let stake = 0;
  let payout = 0;
  const byOutcome: Record<string, number> = {};
  for (const c of usable) {
    stake += c.stakeKr;
    payout += c.payoutKr;
    const o = couponOutcome(c);
    byOutcome[o] = (byOutcome[o] || 0) + 1;
  }
  console.log(`\nParsed coupons: ${coupons.length}  (usable with stake: ${usable.length})`);
  console.log("By outcome:", byOutcome);
  console.log(`\nSum stake:   ${fmt(stake)} kr`);
  console.log(`Sum payout:  ${fmt(payout)} kr`);
  console.log(`Net P/L:     ${fmt(payout - stake)} kr  = ${fmt((payout - stake) / UNIT_KR)} units`);
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const sampleN = args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1]) || 8 : 0;
  const username = args.includes("--user")
    ? (args[args.indexOf("--user") + 1] || "").trim().toLowerCase()
    : "";
  // The file path is the first arg that isn't a flag or a flag's value.
  const flagValues = new Set([String(sampleN), username && args[args.indexOf("--user") + 1]]);
  const path = args.find((a) => !a.startsWith("--") && !flagValues.has(a));

  if (!path) {
    console.error("Usage: npm run import:unibet -- <file.csv> [--confirm --user <username>] [--sample N]");
    process.exit(1);
  }
  if (confirm && !username) {
    console.error("--confirm requires --user <username> (the account to import into).");
    process.exit(1);
  }

  console.log(`Reading ${path} ...`);
  const csv = fs.readFileSync(path, "utf8");
  const rows = parseCouponRows(csv);
  const coupons = buildCoupons(rows);

  printStats(coupons);

  if (sampleN) {
    console.log(`\n--- First ${sampleN} coupons ---`);
    for (const c of coupons.slice(0, sampleN)) {
      console.log(
        `[${c.placedAt?.toISOString().slice(0, 16) ?? "?"}] ${c.couponId}  stake=${c.stakeKr} payout=${c.payoutKr} profit=${c.profitKr} -> ${couponOutcome(c)} odds=${couponOdds(c)}`
      );
    }
  }

  if (!confirm) {
    console.log("\nDRY RUN — database not touched. Re-run with --confirm to import.");
    return;
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      console.error(`No user "${username}" found — register the account in the app first.`);
      process.exit(1);
    }
    console.log(`\n--confirm: incremental import for ${username} (matching on coupon id) ...`);
    const s = await importCoupons(prisma, coupons, user.id);
    console.log("\nDone.");
    console.log(`  Added new:        ${s.added}`);
    console.log(`  Updated:          ${s.updated}`);
    console.log(`  Unchanged:        ${s.unchanged}`);
    console.log(`  Skipped (no stake in window): ${s.skippedNoStake}`);
    console.log(`  Net P/L over imported coupons: ${fmt(s.netUnits)} units (${fmt(s.netUnits * UNIT_KR)} kr)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
