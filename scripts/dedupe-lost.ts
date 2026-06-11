// Dedupe exact-duplicate LOST bets (same coupon imported twice → shows up twice
// in the list). Keeps the oldest copy per group, deletes the rest.
//
//   npx tsx scripts/dedupe-lost.ts            # analyze only (dry run)
//   npx tsx scripts/dedupe-lost.ts --apply    # backup + delete extras
//
// A duplicate group = rows that render IDENTICALLY on the bets page (same
// day, event, selection, bookmaker, odds, stake, P/L, outcome) with outcome
// loss/half_loss — i.e. what the user literally sees twice in the list.
// Import refs are not shown in the UI, so they are reported but not compared.
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { prisma } from "../lib/db";

const APPLY = process.argv.includes("--apply");
const LOST = new Set(["loss", "half_loss"]);

function key(b: {
  placedAt: Date; eventAt: Date | null; event: string; selection: string;
  odds: number; stakeUnits: number; outcome: string; profitUnits: number | null; bookmaker: string | null;
}) {
  const d = b.eventAt ?? b.placedAt;
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  return [
    day, b.event, b.selection, b.odds, b.stakeUnits, b.outcome, b.profitUnits ?? "", b.bookmaker ?? "",
  ].join("|");
}

async function main() {
  const user = await prisma.user.findUnique({ where: { username: "jonatan" }, select: { id: true } });
  if (!user) throw new Error("user jonatan not found");

  const all = await prisma.bet.findMany({ where: { userId: user.id } });
  console.log(`Totalt ${all.length} bets i databasen.`);

  // Full backup before any deletion — every field, restorable as-is.
  const backupDir = join(__dirname, "..", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `bets-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify(all, null, 1));
  console.log(`Backup: ${backupPath}`);

  const groups = new Map<string, typeof all>();
  for (const b of all) {
    if (!LOST.has(b.outcome)) continue;
    const k = key(b);
    const g = groups.get(k);
    if (g) g.push(b); else groups.set(k, [b]);
  }

  const toDelete: string[] = [];
  let dupGroups = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    dupGroups++;
    g.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const refs = g.map((b) => b.importRef ?? "∅").join(", ");
    console.log(`DUBBLETT x${g.length}: ${g[0].event} | ${g[0].selection} | ${g[0].odds} @ ${g[0].stakeUnits}U | ${g[0].outcome} | refs: ${refs}`);
    for (const extra of g.slice(1)) toDelete.push(extra.id);
  }

  console.log(`\n${dupGroups} dubblettgrupper bland förlorade bets.`);
  console.log(`${toDelete.length} extrakopior att ta bort (en kopia behålls per grupp).`);

  if (APPLY && toDelete.length) {
    const { count } = await prisma.bet.deleteMany({ where: { id: { in: toDelete }, userId: user.id } });
    console.log(`\nRaderade ${count} rader.`);
    console.log(`Kvar i databasen: ${await prisma.bet.count({ where: { userId: user.id } })}`);
  } else if (!APPLY) {
    console.log(`\n(dry run — kör med --apply för att radera)`);
  }
}

main().finally(() => prisma.$disconnect());
