/**
 * Jämför bolagens historiska linjer med Pinnacles i samma match och tidpunkt.
 * Hittar datafel som omvänt tecken på spreaden eller fel linje i stegen.
 * Läser bara.
 *
 *   npm run nba:check-books -- unibet.se betsson bet365
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { oddspapiBookmaker } from "../../lib/oddspapi";

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const ref = oddspapiBookmaker();
  const books = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!books.length) {
    console.error("Ange bolag, t.ex. npm run nba:check-books -- unibet.se betsson bet365");
    process.exit(1);
  }
  const rows = await db.nbaOdds.findMany({
    where: { book: { in: [ref, ...books] }, source: { in: ["oddspapi-bet", "oddspapi-history"] }, market: { in: ["spread", "total"] } },
    select: { gameId: true, book: true, market: true, source: true, line: true, price1: true, price2: true },
  });
  const games = new Map(
    (await db.nbaGame.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.gameId))] } }, select: { id: true, startAt: true, homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true } })).map((g) => [g.id, g])
  );
  const teams = new Map((await db.nbaTeam.findMany()).map((t) => [t.id, t.abbr]));
  const key = (r: { gameId: number; market: string; source: string }) => `${r.gameId}|${r.market}|${r.source}`;
  const pin = new Map(rows.filter((r) => r.book === ref).map((r) => [key(r), r]));

  for (const book of books) {
    console.log(`\n== ${book} mot ${ref}`);
    for (const market of ["spread", "total"]) {
      for (const source of ["oddspapi-bet", "oddspapi-history"]) {
        const pairs = rows
          .filter((r) => r.book === book && r.market === market && r.source === source && r.line != null)
          .map((r) => ({ r, p: pin.get(key(r)) }))
          .filter((x) => x.p?.line != null);
        if (!pairs.length) continue;
        const diffs = pairs.map((x) => x.r.line! - x.p!.line!);
        const abs = diffs.map(Math.abs).sort((a, b) => a - b);
        const big = pairs.filter((x) => Math.abs(x.r.line! - x.p!.line!) > 3);
        // Omvänt tecken: Pinnacle har en tydlig favorit och bolaget har samma siffra åt andra hållet.
        const flipped = market === "spread" ? pairs.filter((x) => Math.abs(x.p!.line!) >= 2 && Math.abs(x.r.line! + x.p!.line!) <= 1.5).length : 0;
        console.log(
          `  ${market.padEnd(6)} ${source === "oddspapi-bet" ? "speltid  " : "stängning"} n=${pairs.length}  snittskillnad ${(diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2)}  ` +
            `median |skillnad| ${abs[Math.floor(abs.length / 2)].toFixed(1)}  >3 p ifrån: ${big.length}` +
            (market === "spread" ? `  omvänt tecken: ${flipped}` : "")
        );
        for (const x of big.slice(0, 4)) {
          const g = games.get(x.r.gameId);
          const name = g ? `${teams.get(g.awayTeamId)}@${teams.get(g.homeTeamId)} ${g.startAt.toISOString().slice(0, 10)} (${g.awayScore}-${g.homeScore})` : x.r.gameId;
          console.log(`      ${name}: ${ref} ${x.p!.line} (${x.p!.price1}/${x.p!.price2})  ${book} ${x.r.line} (${x.r.price1}/${x.r.price2})`);
        }
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
