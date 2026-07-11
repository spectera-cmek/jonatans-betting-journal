// Backfill the detailed market taxonomy — marketCategory ("vad", e.g. "Skott på
// mål") and marketScope (player|team|match) — for every existing bet. Derived
// from the free-text selection, the imported legs JSON and the event. Pure
// best-effort: scope is left null ("Okänd") when nothing is conclusive. Existing
// non-empty manual category/scope values are preserved.
//
//   npm run recategorize:detail              # dry-run: print resulting distributions
//   npm run recategorize:detail -- --confirm # write marketCategory/marketScope to the DB
//   npm run recategorize:detail -- --sample 15

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { categorizeDetail, type LegLike } from "../lib/categorize";

function pad(n: number, w = 6) {
  return String(n).padStart(w);
}

function dist(rows: { key: string; n: number }[]) {
  return rows
    .sort((a, b) => b.n - a.n)
    .map((r) => `   ${pad(r.n)}  ${r.key}`)
    .join("\n");
}

const scopeLabel = (s: string | null) =>
  s === "player" ? "Spelare" : s === "team" ? "Lag" : s === "match" ? "Match" : "Okänd";

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const sampleN = args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1]) || 15 : 0;

  const prisma = new PrismaClient();
  try {
    const bets = await prisma.bet.findMany({
      select: {
        id: true,
        event: true,
        selection: true,
        legs: true,
        homeTeam: true,
        awayTeam: true,
        marketCategory: true,
        marketScope: true,
      },
    });
    console.log(`Loaded ${bets.length} bets.`);

    const byCategory = new Map<string, number>();
    const byScope = new Map<string, number>();
    const updates: { id: string; marketCategory: string | null; marketScope: string | null }[] = [];
    const samples: string[] = [];

    for (const b of bets) {
      let legs: LegLike[] = [];
      try {
        legs = JSON.parse(b.legs || "[]");
      } catch {
        /* ignore */
      }
      const inferred = categorizeDetail(
        b.selection,
        b.event,
        legs,
        b.homeTeam,
        b.awayTeam
      );
      const marketCategory = b.marketCategory ?? inferred.marketCategory;
      const marketScope = b.marketScope ?? inferred.marketScope;
      byCategory.set(marketCategory, (byCategory.get(marketCategory) || 0) + 1);
      byScope.set(scopeLabel(marketScope), (byScope.get(scopeLabel(marketScope)) || 0) + 1);
      if (b.marketCategory === null || b.marketScope === null)
        updates.push({ id: b.id, marketCategory, marketScope });
      if (samples.length < sampleN)
        samples.push(`  ${marketCategory.padEnd(16)} ${scopeLabel(marketScope).padEnd(8)} | ${b.selection || b.event}`);
    }

    console.log(`\n=== By marketCategory (${byCategory.size} categories) ===`);
    console.log(dist([...byCategory].map(([key, n]) => ({ key, n }))));
    console.log("\n=== By marketScope ===");
    console.log(dist([...byScope].map(([key, n]) => ({ key, n }))));
    if (sampleN) {
      console.log(`\n=== First ${sampleN} samples ===`);
      console.log(samples.join("\n"));
    }

    if (!confirm) {
      console.log("\nDRY RUN — nothing written. Re-run with --confirm to write marketCategory/marketScope.");
      return;
    }

    let done = 0;
    for (const u of updates) {
      await prisma.bet.update({
        where: { id: u.id },
        data: { marketCategory: u.marketCategory, marketScope: u.marketScope },
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
