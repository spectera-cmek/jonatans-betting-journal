/**
 * Engångsrättning 2026-11-23: Unibet-linjer som sparats som hela matchens men
 * som är kartans.
 *
 * Kambi sätter inget kartnummer på marknaderna för kartan som spelas härnäst,
 * och `scopeOf` läste det som hela matchen. Spelarnas kills- och
 * headshots-linjer hamnade därför på scope "match", där modellen summerar alla
 * kartor: bokens 15,5 kills jämfördes med modellens ~45 och varje linje fick
 * edge. Se `kambiScope` i lib/cs2/kambi.ts.
 *
 *   npx tsx scripts/cs2/rescope-2026-11-23.ts                 # visar bara vad som skulle ändras
 *   npx tsx scripts/cs2/rescope-2026-11-23.ts --confirm --backup-dir "<huvudmappen>/.claude/backups"
 *
 * Linjerna flyttas till scope "map1" — oddshistoriken är riktig, bara nivån var
 * fel. Modellpriserna (Cs2Projection) raderas i stället för att räknas om: de
 * skulle behöva prissättas med dagens ratings, som redan innehåller matchen de
 * skulle förutsäga. Ett facit med facit i handen är inget facit.
 *
 * Kör aldrig före att rättningen är live i huvudmappen — annars skriver nästa
 * `cs2:update` tillbaka raderna i gammal form.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import path from "node:path";
import { cs2Prisma as db, hasCs2Db } from "../../lib/cs2Db";

/** Marknader där en omärkt Kambi-etikett betyder kartan, inte serien. */
const MAP_LEVEL = ["kills", "headshots"];

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  if (!hasCs2Db()) throw new Error("CS2_DATABASE_URL saknas");
  const confirm = process.argv.includes("--confirm");
  const backupDir = arg("--backup-dir") ?? ".claude/backups";

  const where = { source: "kambi", scope: "match", market: { in: MAP_LEVEL } } as const;
  const lines = await db.cs2Line.findMany({ where, orderBy: { id: "asc" } });
  const ids = lines.map((l) => l.id);
  const projections = await db.cs2Projection.findMany({ where: { lineId: { in: ids } } });
  const settled = projections.filter((p) => p.settledAt != null);

  const perMarket = new Map<string, number>();
  for (const l of lines) perMarket.set(l.market, (perMarket.get(l.market) ?? 0) + 1);
  const matches = new Set(lines.map((l) => l.matchId));

  console.log(`Linjer att flytta till karta 1: ${lines.length} i ${matches.size} matcher`);
  console.log(`  per marknad: ${[...perMarket].map(([m, n]) => `${m} ${n}`).join(", ")}`);
  console.log(`Projektioner att radera: ${projections.length} (${settled.length} avgjorda)`);
  const lineVals = lines.map((l) => l.line).filter((x): x is number => x != null);
  if (lineVals.length)
    console.log(
      `  linjernas spann: ${Math.min(...lineVals)}–${Math.max(...lineVals)} ` +
        `(en spelare gör ~15–20 kills per karta och ~45–55 per Bo3 — spannet visar att det är kartlinjer)`
    );

  if (!confirm) {
    console.log("\nTorrkörning. Lägg till --confirm för att skriva.");
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `cs2-rescope-2026-11-23-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), lines, projections }, null, 2), "utf8");
  console.log(`Backup: ${file}`);

  const [p, l] = await db.$transaction([
    db.cs2Projection.deleteMany({ where: { lineId: { in: ids } } }),
    db.cs2Line.updateMany({ where: { id: { in: ids } }, data: { scope: "map1" } }),
  ]);
  console.log(`Flyttade ${l.count} linjer till karta 1 och raderade ${p.count} projektioner.`);
  console.log("Kör sedan: npm run cs2:lines — så prissätts matcherna som inte spelats om, på rätt nivå.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
