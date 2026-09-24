// Agent helper: did last night's Vercel cron run, and what did it do?
//
// Usage:
//   npx tsx scripts/agent/cronStatus.ts [--hours 36]
//
// Prints every syncLog row from the window. `cron:<job>` rows are written on
// every scheduled run (see app/api/cron/[job]/route.ts); a missing
// `cron:grade` row means the cron never fired. Exit code 2 in that case, so
// the morning routine cannot mistake a dead cron for a quiet night.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";

async function main() {
  const i = process.argv.indexOf("--hours");
  const hours = i >= 0 ? Number(process.argv[i + 1]) : 36;
  const since = new Date(Date.now() - hours * 3_600_000);

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.syncLog.findMany({
      where: { ranAt: { gte: since } },
      orderBy: { ranAt: "asc" },
    });
    for (const r of rows) {
      const at = r.ranAt.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });
      console.log(`${at}  ${r.kind.padEnd(14)} ${r.summary}`);
    }
    const graded = rows.some((r) => r.kind === "cron:grade");
    if (!graded) {
      console.log(`\nFEL: ingen cron:grade-körning de senaste ${hours} h — nattjobbet har inte kört.`);
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
