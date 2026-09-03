/**
 * Stamp provenance on closing odds that predate the `closingSource` column.
 *
 * Every closingOdds row written before that column existed is of unknown
 * origin: three capture paths used three different baselines, and a BetHero CSV
 * import wrote de-vigged *fair* odds into the same field. Beating a fair price
 * is an edge estimate, not closing line value, so the two must not be averaged
 * together — but we cannot tell them apart after the fact.
 *
 * So: mark the unknown ones `legacy` (counted separately from verified CLV),
 * and pass the BetHero CSVs to reclassify the rows they actually cover.
 *
 *   npx tsx scripts/markClosingSource.ts                       # dry-run
 *   npx tsx scripts/markClosingSource.ts --confirm             # write `legacy`
 *   npx tsx scripts/markClosingSource.ts --csv a.csv --csv b.csv --confirm
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

/**
 * Pull the identifying columns out of a BetHero export. The header names vary
 * between exports, so match them case-insensitively on substrings rather than
 * on exact labels.
 */
function parseBetHeroKeys(csvPath: string): Set<string> {
  const text = readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return new Set();

  const split = (line: string): string[] =>
    // naive CSV: quoted fields may contain commas
    (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
      .map((c) => c.replace(/,$/, "").trim().replace(/^"|"$/g, "").replace(/""/g, '"'))
      .slice(0, -1);

  const header = split(lines[0]).map((h) => h.toLowerCase());
  const find = (...needles: string[]) =>
    header.findIndex((h) => needles.some((n) => h.includes(n)));
  const iEvent = find("event", "match", "game");
  const iSel = find("selection", "bet", "pick");
  const iOdds = find("odds", "price");
  if (iEvent === -1 || iSel === -1 || iOdds === -1) {
    console.warn(`  ${csvPath}: could not find event/selection/odds columns — skipped`);
    return new Set();
  }

  const keys = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const odds = Number((cells[iOdds] ?? "").replace(",", "."));
    if (!Number.isFinite(odds)) continue;
    keys.add(betKey(cells[iEvent], cells[iSel], odds));
  }
  return keys;
}

/** Loose identity for a bet: event + selection + the price taken. */
function betKey(event: string | null, selection: string | null, odds: number): string {
  const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm(event)}|${norm(selection)}|${odds.toFixed(2)}`;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const csvPaths = argValues("--csv");
  console.log(`Mode: ${confirm ? "CONFIRM" : "DRY-RUN"}`);

  const unstamped = await prisma.bet.findMany({
    where: { closingOdds: { not: null }, closingSource: null },
    select: { id: true, event: true, selection: true, odds: true, placedAt: true },
  });
  console.log(`\n${unstamped.length} bet(s) with closing odds and no source.`);
  if (unstamped.length === 0) return;

  let betheroKeys = new Set<string>();
  for (const p of csvPaths) {
    const keys = parseBetHeroKeys(p);
    console.log(`  ${p}: ${keys.size} row(s)`);
    keys.forEach((k) => betheroKeys.add(k));
  }

  const bethero = betheroKeys.size
    ? unstamped.filter((b) => betheroKeys.has(betKey(b.event, b.selection, b.odds)))
    : [];
  const betheroIds = new Set(bethero.map((b) => b.id));
  const legacy = unstamped.filter((b) => !betheroIds.has(b.id));

  console.log(`\n  bethero_fair: ${bethero.length}`);
  console.log(`  legacy:       ${legacy.length}`);
  if (!csvPaths.length) {
    console.log(
      "\n  No --csv given, so nothing is classified as BetHero fair odds. Re-run with\n" +
        "  the exports to reclassify — `legacy` is already excluded from verified CLV."
    );
  }

  if (!confirm) {
    console.log("\nDry-run — nothing written. Re-run with --confirm.");
    return;
  }

  if (bethero.length) {
    await prisma.bet.updateMany({
      where: { id: { in: bethero.map((b) => b.id) } },
      data: { closingSource: "bethero_fair" },
    });
  }
  if (legacy.length) {
    await prisma.bet.updateMany({
      where: { id: { in: legacy.map((b) => b.id) } },
      data: { closingSource: "legacy" },
    });
  }
  console.log(`\nWrote ${bethero.length + legacy.length} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
