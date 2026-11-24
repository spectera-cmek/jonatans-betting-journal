/**
 * Engångslagning 2026-11-24: HLTV bytte matchsidans layout kring 19 oktober
 * 2026 (vetot först, formatrutan sist, simulerat veto på kommande matcher).
 * Parsern läste format och LAN ur fel ruta och veto ur fel ruta, så varje
 * sida som hämtats sedan dess sparades som bo3, utan LAN/online och utan veto.
 * Rättat i lib/cs2/hltv/parse.ts; det här skriptet tolkar om de berörda
 * sidorna ur cachen (inget nätverk) och lagar databasen:
 *
 *  - format och lan där sidan säger något annat än databasen
 *  - vetot (och vetotexten) där databasen saknar veto men sidan har ett
 *  - linjer som blir omöjliga när formatet rättas — karthandikapp ±1,5 på en
 *    bo1 är rundhandikapp som slapp igenom spärren (lineInput.ts) för att
 *    matchen stod som bo3 — raderas med sina projektioner
 *
 *   npx tsx scripts/cs2/repair-hltv-layout-2026-11-24.ts                 # visar bara vad som skulle ändras
 *   npx tsx scripts/cs2/repair-hltv-layout-2026-11-24.ts --confirm --backup-dir "<huvudmappen>/.claude/backups"
 *   … --cache-dir "<huvudmappen>/.cache/cs2"                               # cachen ligger i huvudmappen
 *
 * Kör först när rättningen är live i huvudmappen: annars skriver de
 * schemalagda jobben tillbaka bo3 och tomt veto på kommande matcher.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import path from "node:path";
import { cs2Prisma as db, hasCs2Db } from "../../lib/cs2Db";
import { parseMatchPage } from "../../lib/cs2/hltv/parse";
import { HltvSession, CS2_CACHE_DIR } from "../../lib/cs2/hltv/session";
import { hltvUrls } from "../../lib/cs2/hltv/urls";
import { vetoRows } from "../../lib/cs2/ingest";
import { matchHandicapProblem } from "../../lib/cs2/lineInput";

/** Sidor hämtade från och med det här datumet kan ha den nya layouten. */
const LAYOUT_SINCE = new Date("2026-10-12T00:00:00Z");

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  if (!hasCs2Db()) throw new Error("CS2_DATABASE_URL saknas");
  const confirm = process.argv.includes("--confirm");
  const backupDir = arg("--backup-dir") ?? ".claude/backups";
  const session = new HltvSession({ offline: true, cacheDir: arg("--cache-dir") ?? CS2_CACHE_DIR });

  const matches = await db.cs2Match.findMany({
    where: { pageFetchedAt: { gte: LAYOUT_SINCE } },
    select: { id: true, slug: true, format: true, lan: true, status: true, startAt: true, vetoText: true, _count: { select: { vetoes: true, maps: true } } },
    orderBy: { startAt: "asc" },
  });

  type Fix = {
    id: number;
    before: { format: string; lan: boolean | null; vetoText: string | null; vetoes: number };
    format?: string;
    lan?: boolean;
    vetoes?: ReturnType<typeof vetoRows>;
    vetoText?: string;
  };
  const fixes: Fix[] = [];
  let missing = 0;
  const mapsMismatch: string[] = [];
  for (const m of matches) {
    let html: string;
    try {
      html = await session.getHtml(hltvUrls.match(m.id, m.slug ?? "x"));
    } catch {
      missing++;
      continue;
    }
    const page = parseMatchPage(html);
    const fix: Fix = { id: m.id, before: { format: m.format, lan: m.lan, vetoText: m.vetoText, vetoes: m._count.vetoes } };
    if (page.format && page.format !== m.format) fix.format = page.format;
    if (page.lan != null && page.lan !== m.lan) fix.lan = page.lan;
    if (page.vetoes.length > 0 && m._count.vetoes === 0) {
      fix.vetoes = vetoRows(m.id, page);
      fix.vetoText = page.vetoLines.join("\n");
    }
    // Rimlighetskontroll: en avgjord bo1 ska ha en karta, en bo3 två eller tre.
    const fmt = fix.format ?? m.format;
    if (m.status === "finished" && m._count.maps > 0 && (fmt === "bo1") !== (m._count.maps === 1))
      mapsMismatch.push(`${m.id} ${m.startAt.toISOString().slice(0, 10)} ${fmt}${fix.format ? ` (var ${m.format})` : ""}, ${m._count.maps} kartor i databasen, sidan: ${page.maps.filter((x) => x.played).length} spelade`);
    if (fix.format || fix.lan !== undefined || fix.vetoes) fixes.push(fix);
  }

  const fmtChanges = new Map<string, number>();
  for (const f of fixes) if (f.format) fmtChanges.set(`${f.before.format}→${f.format}`, (fmtChanges.get(`${f.before.format}→${f.format}`) ?? 0) + 1);
  console.log(`Matcher med sidor hämtade sedan ${LAYOUT_SINCE.toISOString().slice(0, 10)}: ${matches.length} (${missing} saknas i cachen)`);
  console.log(`Format att rätta: ${fixes.filter((f) => f.format).length} (${[...fmtChanges].map(([k, n]) => `${k} ${n}`).join(", ") || "inga"})`);
  console.log(`LAN/online att sätta: ${fixes.filter((f) => f.lan !== undefined).length}`);
  console.log(`Matcher som får tillbaka vetot: ${fixes.filter((f) => f.vetoes).length} (${fixes.reduce((s, f) => s + (f.vetoes?.length ?? 0), 0)} rader)`);
  console.log(`Avgjorda matcher där format och antal kartor ändå inte går ihop efter lagningen: ${mapsMismatch.length}`);
  for (const s of mapsMismatch) console.log(`  ${s}`);

  // Linjer som formaträttningen gör omöjliga.
  const newFormat = new Map(fixes.filter((f) => f.format).map((f) => [f.id, f.format!]));
  const lines = newFormat.size
    ? await db.cs2Line.findMany({ where: { matchId: { in: [...newFormat.keys()] }, market: "match_handicap" } })
    : [];
  const badLines = lines.filter((l) => matchHandicapProblem(l, newFormat.get(l.matchId)!) != null);
  const badIds = badLines.map((l) => l.id);
  const projections = badIds.length ? await db.cs2Projection.findMany({ where: { lineId: { in: badIds } } }) : [];
  console.log(`Omöjliga karthandikapp att radera: ${badLines.length} linjer i ${new Set(badLines.map((l) => l.matchId)).size} matcher, ${projections.length} projektioner (${projections.filter((p) => p.settledAt).length} avgjorda)`);
  for (const l of badLines) console.log(`  #${l.id} match ${l.matchId} (${newFormat.get(l.matchId)}) linje ${l.line} ${l.overOdds}/${l.underOdds}`);

  if (!confirm) {
    console.log("\nInget ändrat. Kör med --confirm --backup-dir <mapp> för att skriva.");
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `cs2-hltv-layout-2026-11-24-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ createdAt: new Date().toISOString(), matches: fixes.map((f) => ({ id: f.id, ...f.before })), lines: badLines, projections }, null, 2),
    "utf8"
  );
  console.log(`Backup: ${file}`);

  let done = 0;
  for (const f of fixes) {
    await db.$transaction([
      db.cs2Match.update({
        where: { id: f.id },
        data: {
          ...(f.format ? { format: f.format } : {}),
          ...(f.lan !== undefined ? { lan: f.lan } : {}),
          ...(f.vetoText ? { vetoText: f.vetoText } : {}),
        },
      }),
      ...(f.vetoes ? [db.cs2Veto.deleteMany({ where: { matchId: f.id } }), db.cs2Veto.createMany({ data: f.vetoes, skipDuplicates: true })] : []),
    ]);
    if (++done % 50 === 0) console.log(`  ${done}/${fixes.length}`);
  }
  const [p, l] = badIds.length
    ? await db.$transaction([db.cs2Projection.deleteMany({ where: { lineId: { in: badIds } } }), db.cs2Line.deleteMany({ where: { id: { in: badIds } } })])
    : [{ count: 0 }, { count: 0 }];
  console.log(`Lagat: ${done} matcher. Raderat: ${l.count} linjer och ${p.count} projektioner.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
