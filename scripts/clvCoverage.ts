/**
 * Hur stor del av loggen kan få CLV — och varför inte resten?
 *
 *   npx tsx scripts/clvCoverage.ts
 *   npx tsx scripts/clvCoverage.ts --days 90
 *
 * Läser bara databasen, kostar inga krediter. Kör den efter en backfill för att
 * se om täckningen faktiskt rörde sig, och före för att veta vad som är möjligt:
 * ett hörnspel kan aldrig få closing från The Odds API, hur ofta man än synkar.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { oddsApiClvEligibility } from "../lib/clvEligibility";

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main() {
  const requested = Number(argValue("--days"));
  const windows = Number.isFinite(requested) && requested > 0 ? [requested] : [30, 90, 180];

  for (const days of windows) {
    const rows = await prisma.bet.findMany({
      where: { placedAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } },
      select: {
        betType: true,
        eventKind: true,
        market: true,
        marketCategory: true,
        marketScope: true,
        selection: true,
        line: true,
        sport: true,
        league: true,
        sportKey: true,
        eventAt: true,
        notes: true,
        boosted: true,
        closingOdds: true,
      },
    });
    if (rows.length === 0) continue;

    const eligible = rows.filter((r) => oddsApiClvEligibility(r).ok);
    const haveClosing = rows.filter((r) => r.closingOdds != null);
    const missing = eligible.filter((r) => r.closingOdds == null);
    const pct = (n: number) => `${((100 * n) / rows.length).toFixed(0)}%`;

    console.log(
      `${String(days).padStart(3)} dagar · ${rows.length} spel · ` +
        `${haveClosing.length} har closing (${pct(haveClosing.length)}) · ` +
        `${eligible.length} hämtbara via Odds API (${pct(eligible.length)}) · ` +
        `${missing.length} kvar att hämta`
    );
  }

  const rows = await prisma.bet.findMany({
    where: { placedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
    select: {
      betType: true,
      eventKind: true,
      market: true,
      marketCategory: true,
      marketScope: true,
      selection: true,
      line: true,
      sport: true,
      league: true,
      sportKey: true,
      eventAt: true,
      notes: true,
      boosted: true,
    },
  });

  const reasons = new Map<string, number>();
  for (const row of rows) {
    const verdict = oddsApiClvEligibility(row);
    if (!verdict.ok) reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
  }

  console.log("\nVarför spel inte kan få CLV (90 dagar, de 15 vanligaste skälen):");
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
