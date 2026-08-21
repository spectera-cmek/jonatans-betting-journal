/**
 * Läser in skott- och hörnodds till ShotOddsSnapshot — underlaget backtestet
 * mäter modellen mot.
 *
 *   npx tsx scripts/shots/ingestOdds.ts --league allsvenskan
 *   npx tsx scripts/shots/ingestOdds.ts --league allsvenskan --confirm
 *   npx tsx scripts/shots/ingestOdds.ts --league all --limit 200 --confirm
 *   npx tsx scripts/shots/ingestOdds.ts --league laliga --upcoming --confirm
 *   npx tsx scripts/shots/ingestOdds.ts --league all --refresh --confirm   # hämta om allt
 *
 * Default är färdigspelade matcher (facit för backtestet). --upcoming hämtar i
 * stället kommande matcher, vilket är vad edge-screenen behöver.
 *
 * Ett anrop per match. Kör statistiken först — oddsen behövs inte förrän
 * modellen ska utvärderas.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import {
  hasTheStatsApiKey,
  getMatchOdds,
  extractShotLines,
  TheStatsApiError,
} from "../../lib/theStatsApi";
import { SHOT_LEAGUES, findLeague, type ShotLeague } from "../../lib/shotData";

import { shotsPrisma as prisma, hasShotsDb } from "../../lib/shotsDb";

import { THROTTLE_MS, sleep, withRetry } from "./rateLimit";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function numberArg(flag: string, fallback: number): number {
  const raw = argValue(flag);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function ingestLeague(
  league: ShotLeague,
  limit: number,
  upcoming: boolean,
  confirm: boolean,
  refresh: boolean
) {
  console.log(`\n=== ${league.label} ===`);

  // Färdigspelade matchers stängningsodds ändras aldrig — har vi rader för dem
  // är ett nytt anrop bara bränd kvot. Kommande matchers priser rör sig, så
  // där hämtas alltid om. --refresh tvingar om även historiken.
  let skip = new Set<string>();
  if (!upcoming && !refresh) {
    const done = await prisma.shotOddsSnapshot.findMany({
      where: { match: { leagueKey: league.key } },
      distinct: ["matchId"],
      select: { matchId: true },
    });
    skip = new Set(done.map((d) => d.matchId));
  }

  // Ingen uppslagning mot API:et: leagueKey sattes redan av shots:ingest.
  const all = await prisma.shotMatch.findMany({
    where: upcoming
      ? { leagueKey: league.key, status: "scheduled", kickoffAt: { gte: new Date() } }
      : { leagueKey: league.key, status: "finished" },
    orderBy: { kickoffAt: upcoming ? "asc" : "desc" },
    select: { id: true, kickoffAt: true, homeTeamName: true, awayTeamName: true },
  });
  const matches = all.filter((m) => !skip.has(m.id)).slice(0, limit);

  if (skip.size > 0) console.log(`  ${skip.size} matcher har redan odds — hoppas över`);
  console.log(`  ${matches.length} ${upcoming ? "kommande" : "färdigspelade"} matcher att hämta`);
  if (!confirm) {
    console.log(`  → ${matches.length} /odds-anrop skulle göras med --confirm`);
    for (const m of matches.slice(0, 3)) {
      console.log(`     ex: ${m.kickoffAt.toISOString().slice(0, 10)} ${m.homeTeamName}–${m.awayTeamName}`);
    }
    return { fetched: 0, rows: 0, failed: 0 };
  }

  let fetched = 0;
  let rows = 0;
  let failed = 0;
  for (const m of matches) {
    try {
      const res = await withRetry(() => getMatchOdds(m.id));
      const lines = extractShotLines(res);
      for (const l of lines) {
        const where = {
          matchId_bookmaker_metric_side_line_isClosing: {
            matchId: m.id,
            bookmaker: l.bookmaker,
            metric: l.metric,
            side: l.side,
            line: l.line,
            isClosing: l.isClosing,
          },
        };
        const data = { overOdds: l.overOdds, underOdds: l.underOdds, capturedAt: new Date() };
        await prisma.shotOddsSnapshot.upsert({
          where,
          create: { matchId: m.id, bookmaker: l.bookmaker, metric: l.metric, side: l.side, line: l.line, isClosing: l.isClosing, ...data },
          update: data,
        });
      }
      rows += lines.length;
      fetched += 1;
      if (fetched % 25 === 0) console.log(`  … ${fetched}/${matches.length} (${rows} prisrader)`);
    } catch (err) {
      failed += 1;
      const msg = err instanceof TheStatsApiError ? `${err.statusCode} ${err.code}` : String(err);
      console.error(`  ✗ ${m.id}: ${msg}`);
      if (err instanceof TheStatsApiError && (err.statusCode === 401 || err.statusCode === 403)) throw err;
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`  Klart: ${fetched} matcher, ${rows} prisrader, ${failed} misslyckade`);
  return { fetched, rows, failed };
}

async function main() {
  if (!hasShotsDb()) {
    console.error("SHOTS_DATABASE_URL saknas i .env.local — skottmodellen har en egen databas.");
    process.exit(1);
  }

  if (!hasTheStatsApiKey()) {
    console.error("THESTATSAPI_KEY saknas i .env.local");
    process.exit(1);
  }

  const confirm = process.argv.includes("--confirm");
  const upcoming = process.argv.includes("--upcoming");
  const refresh = process.argv.includes("--refresh");
  const leagueKey = argValue("--league") ?? "all";
  const limit = numberArg("--limit", 500);

  const leagues =
    leagueKey === "all" ? SHOT_LEAGUES : [findLeague(leagueKey)].filter((l): l is ShotLeague => l !== null);
  if (leagues.length === 0) {
    console.error(`Okänd liga "${leagueKey}". Välj bland: ${SHOT_LEAGUES.map((l) => l.key).join(", ")}, all`);
    process.exit(1);
  }

  console.log(`Läge: ${confirm ? "CONFIRM (skriver till DB)" : "DRY-RUN"}`);
  console.log(`Ligor: ${leagues.map((l) => l.label).join(", ")} · ${upcoming ? "kommande" : "färdigspelade"} matcher`);
  console.log(`Tak: ${limit} /odds-anrop per liga (ett anrop per match)`);

  let fetched = 0;
  let rows = 0;
  let failed = 0;
  for (const league of leagues) {
    const r = await ingestLeague(league, limit, upcoming, confirm, refresh);
    fetched += r.fetched;
    rows += r.rows;
    failed += r.failed;
  }

  console.log(`\nTotalt: ${fetched} matcher, ${rows} prisrader, ${failed} misslyckade`);
  if (!confirm) console.log("Kör om med --confirm för att spara.");
}

main()
  .catch((err) => {
    console.error(err instanceof TheStatsApiError ? `${err.statusCode} ${err.code}: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
