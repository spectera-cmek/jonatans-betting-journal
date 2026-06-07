// Re-derive sport / league / market for every bet from the stored `legs` JSON.
// No PDF needed — works entirely off the database.
//
//   npm run recategorize              # dry-run: print resulting distributions
//   npm run recategorize -- --confirm # write sport/league/market to the DB
//   npm run recategorize -- --sample 12

import { PrismaClient } from "@prisma/client";
import { categorizeBet, type LegLike } from "../lib/categorize";

function pad(n: number, w = 6) {
  return String(n).padStart(w);
}

function dist(rows: { key: string; n: number }[]) {
  return rows
    .sort((a, b) => b.n - a.n)
    .map((r) => `   ${pad(r.n)}  ${r.key}`)
    .join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const sampleN = args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1]) || 12 : 0;

  const prisma = new PrismaClient();
  try {
    const bets = await prisma.bet.findMany({
      select: { id: true, event: true, legs: true, betType: true },
    });
    console.log(`Loaded ${bets.length} bets.`);

    const bySport = new Map<string, number>();
    const byMarket = new Map<string, number>();
    const updates: { id: string; sport: string; league: string | null; market: string }[] = [];
    const samples: string[] = [];

    for (const b of bets) {
      let legs: LegLike[] = [];
      try {
        legs = JSON.parse(b.legs || "[]");
      } catch {
        /* ignore */
      }
      const { sport, league, market } = categorizeBet(b.event, legs);
      bySport.set(sport, (bySport.get(sport) || 0) + 1);
      byMarket.set(market, (byMarket.get(market) || 0) + 1);
      updates.push({ id: b.id, sport, league, market });
      if (samples.length < sampleN)
        samples.push(`  ${sport.padEnd(18)} ${(league || "-").padEnd(6)} ${market.padEnd(14)} | ${b.event}`);
    }

    console.log("\n=== By sport ===");
    console.log(dist([...bySport].map(([key, n]) => ({ key, n }))));
    console.log(`\n=== By market (${byMarket.size} categories) ===`);
    console.log(dist([...byMarket].map(([key, n]) => ({ key, n }))));
    if (sampleN) {
      console.log(`\n=== First ${sampleN} samples ===`);
      console.log(samples.join("\n"));
    }

    if (!confirm) {
      console.log("\nDRY RUN — nothing written. Re-run with --confirm to update sport/league/market.");
      return;
    }

    let done = 0;
    for (const u of updates) {
      await prisma.bet.update({
        where: { id: u.id },
        data: { sport: u.sport, league: u.league, market: u.market },
      });
      if (++done % 500 === 0) process.stdout.write(`\rUpdated ${done}/${updates.length}`);
    }
    console.log(`\rUpdated ${done}/${updates.length}. Done.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
