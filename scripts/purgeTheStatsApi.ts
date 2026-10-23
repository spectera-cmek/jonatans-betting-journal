/**
 * Städar bort det TheStatsAPI lämnade i databaserna, sedan källan togs bort
 * ur projektet (oktober 2026).
 *
 *   npm run purge:thestatsapi              # dry-run: visar vad som skulle tas bort
 *   npm run purge:thestatsapi -- --confirm # tar bort
 *
 * Gamla länkar på bets (externalRef "mt_…", sportKey "tsa:…") nollställs.
 * Betten, deras resultat och closing-odds rörs inte. (Skottmodellen, som
 * också hade TheStatsAPI-data, är borttagen tillsammans med sin databas.)
 *
 * Kan inte ångras — dry-run först. Gör gärna `npm run db:export` innan.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";

/** Värden ur en connection string som säger vilken databas det gäller, utan lösenord. */
function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "(inte satt)";
  } catch {
    return "(ogiltig adress)";
  }
}

/** Prismas långa fel → första begripliga raden. */
function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const line = msg.split("\n").find((l) => /Can't reach|Authentication|does not exist|timed out|ECONN|ENOTFOUND/i.test(l));
  return (line ?? msg.split("\n").filter(Boolean).pop() ?? msg).trim();
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  console.log(`Läge: ${confirm ? "CONFIRM (tar bort)" : "DRY-RUN (inget ändras)"}\n`);

  const prisma = new PrismaClient();
  console.log(`Bet-loggen (DATABASE_URL, ${hostOf(process.env.DATABASE_URL)}):`);
  try {
    const where = { OR: [{ externalRef: { startsWith: "mt_" } }, { sportKey: { startsWith: "tsa:" } }] };
    const bets = await prisma.bet.count({ where });
    console.log(`  ${bets} bets med gamla TheStatsAPI-länkar (externalRef mt_… / sportKey tsa:…)`);
    if (confirm && bets > 0) {
      const { count } = await prisma.bet.updateMany({ where, data: { externalRef: null, sportKey: null } });
      console.log(`  ✓ ${count} länkar nollställda — betten och deras closing-odds är kvar`);
    }
  } catch (err) {
    console.log(`  ✗ Databasen svarar inte: ${shortError(err)}`);
  } finally {
    await prisma.$disconnect();
  }

  if (!confirm) console.log("\nInget ändrat. Kör med --confirm för att ta bort.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
