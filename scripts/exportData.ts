/**
 * One-time data export — run this while the Prisma provider is still `sqlite`.
 *
 * Dumps every Bet / Setting / SyncLog row from the local SQLite database to
 * prisma/data-export.json, so it can be re-imported into Postgres (Neon) with
 * scripts/importData.ts after the cloud database has been provisioned.
 *
 *   npm run db:export
 *
 * The output file holds your real betting history — it is git-ignored and must
 * never be committed.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

async function main() {
  const [bets, settings, syncLogs] = await Promise.all([
    prisma.bet.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.setting.findMany(),
    prisma.syncLog.findMany({ orderBy: { ranAt: "asc" } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    counts: { bets: bets.length, settings: settings.length, syncLogs: syncLogs.length },
    bets,
    settings,
    syncLogs,
  };

  const outPath = join(process.cwd(), "prisma", "data-export.json");
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log(
    `Exporterade ${bets.length} bets, ${settings.length} settings, ${syncLogs.length} sync-loggar`
  );
  console.log(`→ ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
