/**
 * Städar bort det TheStatsAPI lämnade i databaserna, sedan källan togs bort
 * ur projektet (oktober 2026).
 *
 *   npm run purge:thestatsapi              # dry-run: visar vad som skulle tas bort
 *   npm run purge:thestatsapi -- --confirm # tar bort
 *
 * Två delar:
 *  1. Skottmodellens databas: matcher med TheStatsAPI-id ("mt_…"). Raderingen
 *     tar med sig allt som hänger på matcherna (cascade): odds, projektioner och
 *     den avvecklade oddsjämförelsens historik (MarketPrice, EvSnapshot).
 *     Hämta matcherna på nytt med `npm run shots:ingest -- --confirm` (Sofascore).
 *  2. Bet-loggen: gamla länkar på bets (externalRef "mt_…", sportKey "tsa:…")
 *     nollställs. Betten, deras resultat och closing-odds rörs inte.
 *
 * Kan inte ångras — dry-run först. Gör gärna `npm run db:export` innan.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { hasShotsDb, shotsPrisma } from "../lib/shotsDb";

async function main() {
  const confirm = process.argv.includes("--confirm");
  console.log(`Läge: ${confirm ? "CONFIRM (tar bort)" : "DRY-RUN (inget ändras)"}\n`);

  if (hasShotsDb()) {
    const mt = { matchId: { startsWith: "mt_" } };
    const [matches, odds, projections, prices, snapshots] = await Promise.all([
      shotsPrisma.shotMatch.count({ where: { id: { startsWith: "mt_" } } }),
      shotsPrisma.shotOddsSnapshot.count({ where: mt }),
      shotsPrisma.shotProjection.count({ where: mt }),
      shotsPrisma.marketPrice.count({ where: mt }),
      shotsPrisma.evSnapshot.count({ where: mt }),
    ]);
    console.log("Skottmodellen (SHOTS_DATABASE_URL):");
    console.log(`  ${matches} matcher från TheStatsAPI (mt_…)`);
    console.log(`  följer med: ${odds} odds, ${projections} projektioner, ${prices} MarketPrice, ${snapshots} EvSnapshot`);
    if (confirm && matches > 0) {
      const { count } = await shotsPrisma.shotMatch.deleteMany({ where: { id: { startsWith: "mt_" } } });
      console.log(`  ✓ ${count} matcher borttagna (med allt som hängde på dem)`);
    }
  } else {
    console.log("Skottmodellen: ingen SHOTS_DATABASE_URL — hoppar över.");
  }

  const prisma = new PrismaClient();
  try {
    const where = { OR: [{ externalRef: { startsWith: "mt_" } }, { sportKey: { startsWith: "tsa:" } }] };
    const bets = await prisma.bet.count({ where });
    console.log("\nBet-loggen (DATABASE_URL):");
    console.log(`  ${bets} bets med gamla TheStatsAPI-länkar (externalRef mt_… / sportKey tsa:…)`);
    if (confirm && bets > 0) {
      const { count } = await prisma.bet.updateMany({ where, data: { externalRef: null, sportKey: null } });
      console.log(`  ✓ ${count} länkar nollställda — betten och deras closing-odds är kvar`);
    }
  } finally {
    await prisma.$disconnect();
    await shotsPrisma.$disconnect();
  }

  if (!confirm) console.log("\nInget ändrat. Kör med --confirm för att ta bort.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
