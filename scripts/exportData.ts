/**
 * Full JSON safety export for the current Postgres database.
 *
 * Raw SELECTs deliberately avoid coupling the export to the generated Prisma
 * shape, so it can run immediately before an additive schema push. The output
 * contains account and betting data, is git-ignored and must never be committed.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

async function main() {
  const [users, bets, settings, syncLogs] = await Promise.all([
    prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "User" ORDER BY "createdAt" ASC`,
    prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "Bet" ORDER BY "createdAt" ASC`,
    prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "Setting" ORDER BY "id" ASC`,
    prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM "SyncLog" ORDER BY "ranAt" ASC`,
  ]);
  let settlements: Array<Record<string, unknown>> = [];
  try {
    settlements = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "BetSettlement" ORDER BY "createdAt" ASC
    `;
  } catch {
    // The table is absent on the first export before this feature is deployed.
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    counts: {
      users: users.length,
      bets: bets.length,
      settings: settings.length,
      syncLogs: syncLogs.length,
      settlements: settlements.length,
    },
    users,
    bets,
    settings,
    syncLogs,
    settlements,
  };

  const outPath = join(process.cwd(), "prisma", "data-export.json");
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log(
    `Exporterade ${users.length} användare, ${bets.length} bets, ${settings.length} settings, ${syncLogs.length} sync-loggar och ${settlements.length} rättningshändelser`
  );
  console.log(`→ ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
