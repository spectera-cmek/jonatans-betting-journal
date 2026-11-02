/**
 * Läser in NBA-matcher och boxscores från ESPN (gratis, ingen nyckel).
 *
 *   npm run nba:ingest                          # från förra säsongens start till idag
 *   npm run nba:ingest -- --from 2026-10-20     # ett eget intervall
 *   npm run nba:ingest -- --from 2026-10-20 --to 2026-10-31
 *   npm run nba:ingest -- --refresh             # hämta boxscores igen även om de finns
 *
 * Kan avbrytas och köras igen — matcher som redan har boxscore och stintar
 * hoppas över. Matcher inlästa innan stintar fanns hämtas om en gång.
 * En hel säsong tar runt 10–15 minuter (ESPN-anropen går med paus emellan).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { fetchScoreboard, fetchSummary } from "../../lib/nba/espn";
import { saveSummary, upsertGames } from "../../lib/nba/store";

/** Grundseriestart 2025–26 — två säsonger ger modellen gott om historik. */
const DEFAULT_FROM = "2025-10-21";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function parseDate(s: string | null, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Ogiltigt datum: ${s} (använd ÅÅÅÅ-MM-DD)`);
  return d;
}

export async function ingestRange(from: Date, to: Date, opts: { refresh?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? console.log;
  let games = 0;
  let boxes = 0;
  let errors = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += 864e5) {
    const day = new Date(t);
    let list;
    try {
      list = await fetchScoreboard(day);
    } catch (e) {
      errors++;
      log(`  ${day.toISOString().slice(0, 10)}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!list.length) continue;
    // Försäsong (1) och All-Star (4) säger inget om riktiga matcher.
    const real = list.filter((g) => g.seasonType === 2 || g.seasonType === 3 || g.seasonType === 5);
    games += await upsertGames(db, real);
    const finals = real.filter((g) => g.status === "final");
    const done = opts.refresh
      ? new Set<number>()
      : // Klar = boxscore och stintar redan försökta. Äldre matcher utan stintar hämtas om en gång.
        new Set(
          (
            await db.nbaGame.findMany({
              where: { id: { in: finals.map((g) => g.id) }, boxFetchedAt: { not: null }, stintsValid: { not: null } },
              select: { id: true },
            })
          ).map((g) => g.id)
        );
    for (const g of finals) {
      if (done.has(g.id)) continue;
      try {
        const s = await fetchSummary(g.id);
        if (s) {
          await saveSummary(db, s);
          boxes++;
        }
      } catch (e) {
        errors++;
        log(`  match ${g.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    log(`${day.toISOString().slice(0, 10)}: ${real.length} matcher, ${finals.filter((g) => !done.has(g.id)).length} nya boxscores`);
  }
  return { games, boxes, errors };
}

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local (se .env.local.example)");
    process.exit(1);
  }
  const from = parseDate(arg("--from"), new Date(`${DEFAULT_FROM}T12:00:00Z`));
  const to = parseDate(arg("--to"), new Date());
  console.log(`ESPN ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  const r = await ingestRange(from, to, { refresh: process.argv.includes("--refresh") });
  console.log(`Klart: ${r.games} matcher, ${r.boxes} boxscores${r.errors ? `, ${r.errors} fel` : ""}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/nba/ingest.ts")) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => db.$disconnect());
}
