// Canonicalise the bookmaker column.
//
//   npx tsx scripts/backfillBookmakers.ts             # dry-run: show what would change
//   npx tsx scripts/backfillBookmakers.ts --confirm   # write
//
// The same book logged from a screenshot, a statement import and the form used
// to end up as several spellings ("PAF" vs "Paf", "bet 365" vs "Bet365"), which
// splits it into separate rows in the bookmaker filter, in analytics and in the
// CLV lookup that prefers the bet's own book. normalizeBookmaker() now folds
// those at write time; this backfills the history.
//
// Values that are not a bookmaker at all ("Okänd", "unknown") become NULL — the
// app renders that as "—" and treats it as "no bookmaker", which is what they
// meant. Dry-run is the default and a confirmed run backs up every affected row
// first, so a bad fold can be replayed in reverse.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdirSync, writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { normalizeBookmaker } from "../lib/constants";

const BACKUP_DIR = ".claude/backups";

async function main() {
  const confirm = process.argv.includes("--confirm");
  const prisma = new PrismaClient();

  try {
    const groups = await prisma.bet.groupBy({
      by: ["bookmaker"],
      where: { bookmaker: { not: null } },
      _count: { _all: true },
    });

    const changes = groups
      .map((g) => ({
        from: g.bookmaker as string,
        to: normalizeBookmaker(g.bookmaker),
        count: g._count._all,
      }))
      .filter((c) => c.to !== c.from)
      .sort((a, b) => b.count - a.count);

    if (!changes.length) {
      console.log("Inget att göra — alla bookmaker-värden är redan kanoniska.");
      return;
    }

    const rows = changes.reduce((sum, c) => sum + c.count, 0);
    console.log(`${changes.length} värden att slå ihop (${rows} rader):`);
    for (const c of changes) {
      console.log(`  "${c.from}" -> ${c.to === null ? "(tomt)" : `"${c.to}"`}  ${c.count} rader`);
    }

    if (!confirm) {
      console.log("\nDry-run. Kör med --confirm för att skriva.");
      return;
    }

    const affected = await prisma.bet.findMany({
      where: { bookmaker: { in: changes.map((c) => c.from) } },
      select: { id: true, bookmaker: true },
    });
    mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = `${BACKUP_DIR}/bookmakers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(backup, JSON.stringify(affected, null, 2));
    console.log(`\nBackup: ${backup} (${affected.length} rader)`);

    let written = 0;
    for (const c of changes) {
      const res = await prisma.bet.updateMany({
        where: { bookmaker: c.from },
        data: { bookmaker: c.to },
      });
      written += res.count;
      console.log(`  ${res.count} rader: "${c.from}" -> ${c.to === null ? "(tomt)" : `"${c.to}"`}`);
    }
    console.log(`Klart — ${written} rader uppdaterade.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
