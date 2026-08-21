/**
 * Läser in fixtures och lagnivåstatistik till ShotMatch — underlaget
 * skottmodellen tränar på.
 *
 *   npx tsx scripts/shots/ingestMatches.ts --league allsvenskan
 *   npx tsx scripts/shots/ingestMatches.ts --league allsvenskan --confirm
 *   npx tsx scripts/shots/ingestMatches.ts --league all --seasons 2 --confirm
 *   npx tsx scripts/shots/ingestMatches.ts --league laliga --limit 100 --confirm
 *
 * Utan --confirm görs bara de billiga listningsanropen: skriptet skriver ut
 * anropsbudgeten för statistiken och stannar. Färdiga matcher hämtas aldrig om
 * (statsFetchedAt), så avbrutna körningar kan återupptas rakt av.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import {
  hasTheStatsApiKey,
  listAllMatches,
  listSeasons,
  getMatchStats,
  matchTeamTotals,
  TheStatsApiError,
  type StatsMatch,
} from "../../lib/theStatsApi";
import { SHOT_LEAGUES, findLeague, resolveCompetition, type ShotLeague } from "../../lib/shotData";

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

async function upsertFixtures(leagueKey: string, competitionId: string, matches: StatsMatch[]): Promise<number> {
  let written = 0;
  for (const m of matches) {
    const data = {
      leagueKey,
      competitionId,
      seasonId: m.season_id ?? null,
      matchday: m.matchday ?? null,
      kickoffAt: new Date(m.utc_date),
      status: m.status,
      homeTeamId: m.home_team.id,
      awayTeamId: m.away_team.id,
      homeTeamName: m.home_team.name,
      awayTeamName: m.away_team.name,
    };
    // Rör inte statistikfälten här — bara fixture-metadatan.
    await prisma.shotMatch.upsert({ where: { id: m.id }, create: { id: m.id, ...data }, update: data });
    written += 1;
  }
  return written;
}

async function ingestLeague(league: ShotLeague, seasonCount: number, limit: number, confirm: boolean) {
  console.log(`\n=== ${league.label} ===`);
  const comp = await resolveCompetition(league);
  if (!comp) {
    console.error(`  Hittade ingen liga som matchar ${league.search.join(" / ")} i ${league.country}`);
    return { fetched: 0, failed: 0, budget: 0 };
  }
  console.log(`  ${comp.name} (${comp.id})`);

  const seasons = (await listSeasons(comp.id)).slice(0, seasonCount);
  if (seasons.length === 0) {
    console.error("  Inga säsonger hittades");
    return { fetched: 0, failed: 0, budget: 0 };
  }
  console.log(`  Säsonger: ${seasons.map((s) => s.year).join(", ")}`);

  // Färdigspelade matcher vi redan har statistik för ska inte räknas in i
  // budgeten — annars ser en återupptagen körning dyrare ut än den är.
  const alreadyFetched = new Set(
    (
      await prisma.shotMatch.findMany({
        where: { leagueKey: league.key, statsFetchedAt: { not: null } },
        select: { id: true },
      })
    ).map((r) => r.id)
  );

  let finishedListed = 0;
  for (const season of seasons) {
    const matches = await listAllMatches({ competitionId: comp.id, seasonId: season.id, stage: "regular" });
    const finished = matches.filter((m) => m.status === "finished");
    finishedListed += finished.filter((m) => !alreadyFetched.has(m.id)).length;
    if (confirm) {
      const n = await upsertFixtures(league.key, comp.id, matches);
      console.log(`  ${season.year}: ${n} fixtures sparade (${finished.length} färdigspelade)`);
    } else {
      console.log(`  ${season.year}: ${matches.length} matcher (${finished.length} färdigspelade)`);
    }
  }

  // I dry-run finns fixtures ännu inte i DB (de sparas bara med --confirm), så
  // budgeten räknas ur listningen. Annars skulle den alltid visa 0.
  if (!confirm) {
    console.log(`  Statistik saknas för ${finishedListed} färdigspelade matcher`);
    console.log(`  → ${Math.min(finishedListed, limit)} /stats-anrop skulle göras med --confirm`);
    return { fetched: 0, failed: 0, budget: finishedListed };
  }

  const pending = await prisma.shotMatch.findMany({
    where: { leagueKey: league.key, status: "finished", statsFetchedAt: null },
    orderBy: { kickoffAt: "desc" },
    select: { id: true, kickoffAt: true, homeTeamName: true, awayTeamName: true },
  });
  console.log(`  Statistik saknas för ${pending.length} färdigspelade matcher`);

  let fetched = 0;
  let failed = 0;
  for (const row of pending.slice(0, limit)) {
    try {
      const stats = await withRetry(() => getMatchStats(row.id));
      const t = matchTeamTotals(stats);
      await prisma.shotMatch.update({
        where: { id: row.id },
        data: {
          homeShots: t.shots?.home ?? null,
          awayShots: t.shots?.away ?? null,
          homeSot: t.sot?.home ?? null,
          awaySot: t.sot?.away ?? null,
          homeCorners: t.corners?.home ?? null,
          awayCorners: t.corners?.away ?? null,
          homeXg: t.xg?.home ?? null,
          awayXg: t.xg?.away ?? null,
          homePossession: t.possession?.home ?? null,
          awayPossession: t.possession?.away ?? null,
          statsFetchedAt: new Date(),
        },
      });
      fetched += 1;
      if (fetched % 25 === 0) console.log(`  … ${fetched}/${Math.min(pending.length, limit)}`);
    } catch (err) {
      failed += 1;
      const msg = err instanceof TheStatsApiError ? `${err.statusCode} ${err.code}` : String(err);
      console.error(`  ✗ ${row.id}: ${msg}`);
      // 401/403 betyder nyckel eller plan — fortsätt inte bränna anrop.
      if (err instanceof TheStatsApiError && (err.statusCode === 401 || err.statusCode === 403)) throw err;
    }
    await sleep(THROTTLE_MS);
  }
  console.log(`  Klart: ${fetched} hämtade, ${failed} misslyckade`);
  return { fetched, failed, budget: 0 };
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
  const leagueKey = argValue("--league") ?? "all";
  const seasonCount = numberArg("--seasons", 2);
  const limit = numberArg("--limit", 10_000);

  const leagues =
    leagueKey === "all" ? SHOT_LEAGUES : [findLeague(leagueKey)].filter((l): l is ShotLeague => l !== null);
  if (leagues.length === 0) {
    console.error(`Okänd liga "${leagueKey}". Välj bland: ${SHOT_LEAGUES.map((l) => l.key).join(", ")}, all`);
    process.exit(1);
  }

  const rough = leagues.reduce((s, l) => s + l.matchesPerSeason * seasonCount, 0);
  console.log(`Läge: ${confirm ? "CONFIRM (skriver till DB)" : "DRY-RUN"}`);
  console.log(`Ligor: ${leagues.map((l) => l.label).join(", ")} · ${seasonCount} säsong(er)`);
  console.log(`Grov förhandsuppskattning: ~${rough} /stats-anrop (exakt siffra räknas per liga nedan)`);
  if (limit < 10_000) console.log(`Tak den här körningen: ${limit} /stats-anrop per liga`);
  if (!confirm) console.log("Dry-run gör listningsanropen men hämtar ingen statistik.");

  let fetched = 0;
  let failed = 0;
  let budget = 0;
  for (const league of leagues) {
    const r = await ingestLeague(league, seasonCount, limit, confirm);
    fetched += r.fetched;
    failed += r.failed;
    budget += r.budget;
  }

  if (confirm) {
    console.log(`\nTotalt: ${fetched} matchstatistik hämtad, ${failed} misslyckade`);
  } else {
    console.log(`\nTotal anropsbudget: ${budget} /stats-anrop`);
    console.log("Kör om med --confirm för att spara.");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof TheStatsApiError ? `${err.statusCode} ${err.code}: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
