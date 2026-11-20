/**
 * Engångsrensning 2026-11-20: rundhandikapp som sparats som karthandikapp och
 * exakta dubblettlinjer, med modellpriserna (Cs2Projection) som hör till dem.
 * Urvalet: lib/cs2/cleanup.ts.
 *
 *   npx tsx scripts/cs2/cleanup-2026-11-20.ts                 # visar bara vad som skulle tas bort
 *   npx tsx scripts/cs2/cleanup-2026-11-20.ts --confirm --backup-dir "<huvudmappen>/.claude/backups"
 *
 * Med --confirm skrivs först en backup (JSON med linjer och projektioner), och
 * sedan raderas allt i en transaktion. Samma körning sätter tillbaka matcher
 * vars demo bara markerats som misslyckad för att Cloudflare stoppade den
 * (demoStatus "failed" → "none"), så att demokön prövar dem igen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import path from "node:path";
import { cs2Prisma as db, hasCs2Db } from "../../lib/cs2Db";
import { cloudflareDemoFailures, selectCleanup } from "../../lib/cs2/cleanup";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  if (!hasCs2Db()) throw new Error("CS2_DATABASE_URL saknas");
  const confirm = process.argv.includes("--confirm");
  const backupDir = arg("--backup-dir") ?? ".claude/backups";

  const lines = await db.cs2Line.findMany();
  const matches = await db.cs2Match.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.matchId))] } }, select: { id: true, format: true } });
  const formats = new Map(matches.map((m) => [m.id, m.format]));
  const { roundHandicap, duplicates } = selectCleanup(lines, formats);
  const ids = [...new Set([...roundHandicap, ...duplicates])].sort((a, b) => a - b);

  const byId = new Map(lines.map((l) => [l.id, l]));
  const perFormat = new Map<string, number>();
  for (const id of roundHandicap) {
    const f = formats.get(byId.get(id)!.matchId) ?? "?";
    perFormat.set(f, (perFormat.get(f) ?? 0) + 1);
  }
  console.log(`Linjer totalt: ${lines.length}`);
  console.log(`Rundhandikapp sparade som karthandikapp: ${roundHandicap.length} (${[...perFormat].map(([f, n]) => `${f} ${n}`).join(", ")}) i ${new Set(roundHandicap.map((id) => byId.get(id)!.matchId)).size} matcher`);
  console.log(`Exakta dubbletter: ${duplicates.length}`);
  console.log(`Att ta bort (överlapp räknat en gång): ${ids.length}`);
  console.log("Bo5-rader på ±2,5:");
  for (const l of lines) {
    if (l.market !== "match_handicap" || formats.get(l.matchId) !== "bo5" || Math.abs(l.line ?? 0) !== 2.5) continue;
    console.log(`  #${l.id} match ${l.matchId} linje ${l.line} ${l.createdAt.toISOString()} → ${roundHandicap.includes(l.id) ? "rundor, tas bort" : "karthandikapp, behålls"}`);
  }

  const projections = await db.cs2Projection.findMany({ where: { lineId: { in: ids } } });
  console.log(`Projektioner som hör till: ${projections.length} (${projections.filter((p) => p.settledAt).length} avgjorda)`);

  const failedDemos = await db.cs2Match.findMany({ where: { demoStatus: "failed" }, select: { id: true, demoStatus: true, demoError: true } });
  const demoReset = cloudflareDemoFailures(failedDemos);
  console.log(`Demos som bara Cloudflare stoppade (prövas igen): ${demoReset.length} av ${failedDemos.length} misslyckade`);

  if (!confirm) {
    console.log("Inget raderat. Kör med --confirm --backup-dir <mapp> för att ta bort.");
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `cs2-cleanup-2026-11-20-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const demoBackup = failedDemos.filter((m) => demoReset.includes(m.id));
  fs.writeFileSync(
    file,
    JSON.stringify({ createdAt: new Date().toISOString(), roundHandicap, duplicates, lines: ids.map((id) => byId.get(id)), projections, demoReset: demoBackup }, null, 2),
    "utf8"
  );
  console.log(`Backup: ${file}`);

  const [p, l, d] = await db.$transaction([
    db.cs2Projection.deleteMany({ where: { lineId: { in: ids } } }),
    db.cs2Line.deleteMany({ where: { id: { in: ids } } }),
    db.cs2Match.updateMany({ where: { id: { in: demoReset } }, data: { demoStatus: "none", demoError: null } }),
  ]);
  console.log(`Raderat: ${l.count} linjer och ${p.count} projektioner. Demos som prövas igen: ${d.count}.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
