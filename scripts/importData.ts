/**
 * One-time data import — run this AFTER the Postgres (Neon) database exists and
 * `npm run db:push` has created the tables. Reads prisma/data-export.json (produced
 * by scripts/exportData.ts) and inserts every row into the cloud database.
 *
 *   npm run db:import
 *
 * Safe to re-run: existing rows (matched by id) are skipped, not duplicated.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

/** JSON serialises DateTime as ISO strings — turn the date-ish fields back into Date. */
function toDate<T extends Record<string, unknown>>(row: T, keys: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) {
    if (out[k] != null && typeof out[k] === "string") out[k] = new Date(out[k] as string);
  }
  return out as T;
}

async function main() {
  const inPath = join(process.cwd(), "prisma", "data-export.json");
  const raw = JSON.parse(readFileSync(inPath, "utf8")) as {
    bets: Record<string, unknown>[];
    settings: Record<string, unknown>[];
    syncLogs: Record<string, unknown>[];
  };

  // Settings (singleton-ish) — upsert so re-runs stay idempotent.
  for (const s of raw.settings) {
    await prisma.setting.upsert({
      where: { id: s.id as number },
      update: s,
      create: s as any,
    });
  }

  // Insert in chunks: Postgres caps a single statement at ~65535 bind params, and
  // each bet has ~25 columns, so a full 8k-row createMany would blow that limit.
  const CHUNK = 500;
  const bets = raw.bets.map((b) =>
    toDate(b, ["placedAt", "eventAt", "gradedAt", "createdAt", "updatedAt"])
  );
  let betCount = 0;
  for (let i = 0; i < bets.length; i += CHUNK) {
    const res = await prisma.bet.createMany({
      data: bets.slice(i, i + CHUNK) as any,
      skipDuplicates: true,
    });
    betCount += res.count;
  }

  const syncLogs = raw.syncLogs.map((l) => toDate(l, ["ranAt"]));
  const logsRes = await prisma.syncLog.createMany({ data: syncLogs as any, skipDuplicates: true });

  console.log(
    `Importerade ${betCount} bets, ${raw.settings.length} settings, ${logsRes.count} sync-loggar till Postgres`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
