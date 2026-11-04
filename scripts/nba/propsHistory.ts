/**
 * Plockar ut prop-priserna ur OddsPapi-historiken (cachen i
 * .claude/oddspapi-history/) till ett kompakt dataset för backtester:
 *
 *   .claude/nba-props/series/<gameId>.json  — alla prisändringar 36 h före start
 *   .claude/nba-props/snapshots.jsonl       — huvudlinje (+ hela stegen) vid
 *                                             öppning, −6h, −3h, −1h och stängning
 *
 *   npm run nba:props-history                                # allt som finns i cachen
 *   npm run nba:props-history -- --from 2026-10-01 --fetch   # hämta saknade (gratis, ~5 s/match)
 *
 * Spelarna står som OddsPapi-id (historiken har inga namn) — kopplingen till
 * ESPN görs av nba:props-map. Läser bara databasen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { cachedHistory, historyCacheFile, readCachedHistory } from "../../lib/nba/historyCache";
import { loadIds, reclassifyPropMarkets, type PropMarketSpec } from "../../lib/oddspapi/markets";
import { extractPropSeries, firstOpen, mainRung, snapshotAt, SNAPSHOT_TIMES, unknownPlayerMarkets } from "../../lib/nba/propsHistory";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

export const PROPS_DIR = path.join(".claude", "nba-props");

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const ids = loadIds();
  const propMarkets: Record<string, PropMarketSpec> = reclassifyPropMarkets(ids?.basketballPropMarkets as Record<string, PropMarketSpec> | undefined);
  if (!Object.keys(propMarkets).length) {
    console.error("lib/oddspapi/ids.json saknar prop-marknader — kör npm run oddspapi:discover");
    process.exit(1);
  }
  const known: Record<string, unknown> = { ...(ids?.basketballMarkets ?? {}), ...(ids?.basketballPropMarkets ?? {}) };
  const books = (arg("--books") ?? "pinnacle,unibet.se,betsson").split(",").map((s) => s.trim()).filter(Boolean);
  const from = new Date(`${arg("--from") ?? "2026-01-01"}T00:00:00Z`);
  const to = arg("--to") ? new Date(`${arg("--to")}T23:59:59Z`) : new Date();
  const fetch = process.argv.includes("--fetch");
  const out = arg("--out") ?? PROPS_DIR;
  fs.mkdirSync(path.join(out, "series"), { recursive: true });

  const games = await db.nbaGame.findMany({
    where: { status: "final", startAt: { gte: from, lte: to }, oddspapiFixtureId: { not: null } },
    select: { id: true, startAt: true, seasonType: true, homeTeamId: true, awayTeamId: true, oddspapiFixtureId: true },
    orderBy: { startAt: "asc" },
  });
  console.log(`${games.length} matcher med OddsPapi-id ${from.toISOString().slice(0, 10)} – ${to.toISOString().slice(0, 10)}${fetch ? " (hämtar saknade)" : ""}`);

  const snapFile = path.join(out, "snapshots.jsonl");
  const snap = fs.createWriteStream(snapFile);
  const cov: Record<string, { games: number; players: number; byStat: Record<string, number> }> = {};
  const unknown = new Map<string, number>();
  let missing = 0;
  let empty = 0;
  let written = 0;
  for (const [i, g] of games.entries()) {
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${games.length}`);
    const h = fetch ? await cachedHistory(g.oddspapiFixtureId!, books) : readCachedHistory(g.oddspapiFixtureId!);
    if (!h) {
      if (fs.existsSync(historyCacheFile(g.oddspapiFixtureId!))) empty++;
      else missing++;
      continue;
    }
    for (const [k, n] of unknownPlayerMarkets(h, known)) unknown.set(k, (unknown.get(k) ?? 0) + n);
    const start = g.startAt.getTime();
    const series = extractPropSeries(h, propMarkets, books, start);
    if (!Object.keys(series).length) {
      empty++;
      continue;
    }
    fs.writeFileSync(
      path.join(out, "series", `${g.id}.json`),
      JSON.stringify({ gameId: g.id, fixtureId: g.oddspapiFixtureId, startAt: g.startAt.toISOString(), seasonType: g.seasonType, homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, books: series })
    );
    written++;
    for (const [book, byPid] of Object.entries(series)) {
      const c = (cov[book] ??= { games: 0, players: 0, byStat: {} });
      c.games++;
      c.players += Object.keys(byPid).length;
      for (const [pid, byStat] of Object.entries(byPid)) {
        for (const [stat, rungs] of Object.entries(byStat)) {
          c.byStat[stat] = (c.byStat[stat] ?? 0) + 1;
          const open = firstOpen(rungs);
          const times: Array<[string, number]> = [...(open != null ? [["open", open] as [string, number]] : []), ...Object.entries(SNAPSHOT_TIMES)];
          for (const [at, t] of times) {
            if (open == null || t < open) continue;
            const q = snapshotAt(rungs, t);
            const m = mainRung(q);
            if (!m) continue;
            snap.write(
              JSON.stringify({
                gameId: g.id,
                startAt: g.startAt.toISOString(),
                seasonType: g.seasonType,
                book,
                pid,
                stat,
                at,
                tSec: t,
                line: m.line,
                over: m.over,
                under: m.under,
                maxStake: m.maxStake,
                nRungs: q.length,
                rungs: q.length > 1 ? q.map((r) => [r.line, r.over, r.under]) : undefined,
              }) + "\n"
            );
          }
        }
      }
    }
  }
  await new Promise<void>((r) => snap.end(r));
  console.log(`\n${written} matcher sparade i ${out}/ · ${missing} saknas i cachen · ${empty} tomma`);
  console.log("\nTäckning per bok:");
  for (const [book, c] of Object.entries(cov)) {
    console.log(`  ${book.padEnd(10)} ${String(c.games).padStart(4)} matcher · ${(c.players / Math.max(1, c.games)).toFixed(1)} spelare/match · ${Object.entries(c.byStat).map(([s, n]) => `${s} ${n}`).join(" · ")}`);
  }
  if (unknown.size) {
    const top = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(`\n${unknown.size} okända marknads-id med spelare (id: spelar-serier): ${top.map(([k, n]) => `${k}: ${n}`).join(", ")}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
