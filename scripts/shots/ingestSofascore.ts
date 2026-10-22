/**
 * Läser in fixtures och lagnivåstatistik från Sofascore till ShotMatch — samma
 * underlag som shots:ingest hämtar från TheStatsAPI, men utan nyckel.
 * Hämtas via Scrapling (npm run scrapling:setup en gång).
 *
 *   npm run shots:ingest:sofascore -- --league allsvenskan
 *   npm run shots:ingest:sofascore -- --league allsvenskan --confirm
 *   npm run shots:ingest:sofascore -- --league all --seasons 2 --confirm
 *   npm run shots:ingest:sofascore -- --league laliga --limit 100 --confirm
 *
 * Raderna får egna id:n så de aldrig krockar med TheStatsAPI:s:
 *   match "ss_<eventId>", lag "ss_t_<teamId>", liga "ss_ut_<uniqueTournamentId>".
 * En liga ska ha EN källa — modellen räknar alla rader med samma leagueKey,
 * så finns TheStatsAPI-rader (mt_…) för ligan stannar skriptet där.
 *
 * Utan --confirm görs bara listningsanropen: skriptet skriver ut hur många
 * matcher som saknar statistik och stannar. Färdiga matcher hämtas aldrig om
 * (statsFetchedAt), så avbrutna körningar kan återupptas rakt av.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { SHOT_LEAGUES, findLeague, type ShotLeague } from "../../lib/shotData";
import { shotsPrisma as prisma, hasShotsDb } from "../../lib/shotsDb";
import { sofaPaths } from "../../lib/sofascore/api";
import {
  SOFA_MAX_AGE,
  SofascoreBlockedError,
  SofascoreBudgetError,
  SofascoreClient,
} from "../../lib/sofascore/client";
import { parseEvents, parseSeasons, parseStatistics, shotTotals, type SofaEvent } from "../../lib/sofascore/parse";

/** Säkerhetstak per säsong och riktning — en säsong är ~10–15 sidor. */
const MAX_PAGES = 40;
/** En spelad match utan statistik kan få den senare. Efter två dygn ger vi upp. */
const STATS_GRACE_MS = 2 * 86_400_000;

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function numberArg(flag: string, fallback: number): number {
  const raw = argValue(flag);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ssMatchId = (eventId: number) => `ss_${eventId}`;
const ssTeamId = (teamId: number) => `ss_t_${teamId}`;

async function listSeasonEvents(
  client: SofascoreClient,
  ut: number,
  seasonId: number,
  current: boolean
): Promise<SofaEvent[]> {
  const out = new Map<number, SofaEvent>();
  // Äldre säsonger ändras inte; den pågående läses om var tredje timme.
  const maxAge = current ? SOFA_MAX_AGE.schedule : SOFA_MAX_AGE.finished;
  for (const dir of current ? (["last", "next"] as const) : (["last"] as const)) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await client.get(sofaPaths.seasonEvents(ut, seasonId, dir, page), maxAge);
      if (json === null) break; // 404 = inga fler sidor
      const { events, hasNextPage } = parseEvents(json);
      for (const e of events) if (e.uniqueTournamentId === null || e.uniqueTournamentId === ut) out.set(e.id, e);
      if (!hasNextPage) break;
    }
  }
  return [...out.values()];
}

async function upsertFixtures(league: ShotLeague, ut: number, events: SofaEvent[]): Promise<number> {
  for (const e of events) {
    const data = {
      leagueKey: league.key,
      competitionId: `ss_ut_${ut}`,
      seasonId: e.seasonId != null ? `ss_s_${e.seasonId}` : null,
      matchday: e.round,
      kickoffAt: e.startAt,
      status: e.status,
      homeTeamId: ssTeamId(e.homeTeam.id),
      awayTeamId: ssTeamId(e.awayTeam.id),
      homeTeamName: e.homeTeam.name,
      awayTeamName: e.awayTeam.name,
    };
    // Rör inte statistikfälten här — bara fixture-metadatan.
    await prisma.shotMatch.upsert({ where: { id: ssMatchId(e.id) }, create: { id: ssMatchId(e.id), ...data }, update: data });
  }
  return events.length;
}

async function ingestLeague(
  client: SofascoreClient,
  league: ShotLeague,
  seasonCount: number,
  limit: number,
  confirm: boolean,
  useDb: boolean
) {
  console.log(`\n=== ${league.label} ===`);
  const ut = league.sofascoreId!;

  if (useDb) {
    const foreign = await prisma.shotMatch.count({ where: { leagueKey: league.key, id: { startsWith: "mt_" } } });
    if (foreign > 0) {
      console.log(
        `  ✗ Ligan har redan ${foreign} matcher från TheStatsAPI (mt_…). Två källor i samma liga skulle räknas dubbelt i modellen,\n` +
          `    så Sofascore hoppas över här. Fortsätt med shots:ingest för den här ligan, eller ta bort mt_-raderna först.`
      );
      return { fetched: 0, failed: 0, budget: 0 };
    }
  }

  const seasons = parseSeasons(await client.get(sofaPaths.seasons(ut), SOFA_MAX_AGE.seasons)).slice(0, seasonCount);
  if (seasons.length === 0) {
    console.error(`  Inga säsonger hittades för unique-tournament ${ut}`);
    return { fetched: 0, failed: 0, budget: 0 };
  }
  console.log(`  Säsonger: ${seasons.map((s) => s.year || s.name).join(", ")}`);

  const alreadyFetched = useDb
    ? new Set(
        (
          await prisma.shotMatch.findMany({
            where: { leagueKey: league.key, statsFetchedAt: { not: null } },
            select: { id: true },
          })
        ).map((r) => r.id)
      )
    : new Set<string>();

  const finished: SofaEvent[] = [];
  for (const [i, season] of seasons.entries()) {
    const events = await listSeasonEvents(client, ut, season.id, i === 0);
    const done = events.filter((e) => e.status === "finished");
    finished.push(...done);
    if (confirm) {
      const n = await upsertFixtures(league, ut, events);
      console.log(`  ${season.year || season.name}: ${n} fixtures sparade (${done.length} färdigspelade)`);
    } else {
      console.log(`  ${season.year || season.name}: ${events.length} matcher (${done.length} färdigspelade)`);
    }
  }

  const pending = finished
    .filter((e) => !alreadyFetched.has(ssMatchId(e.id)))
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  console.log(`  Statistik saknas för ${pending.length} färdigspelade matcher`);
  if (!confirm) {
    console.log(`  → ${Math.min(pending.length, limit)} /statistics-anrop skulle göras med --confirm`);
    return { fetched: 0, failed: 0, budget: pending.length };
  }

  let fetched = 0;
  let failed = 0;
  for (const e of pending.slice(0, limit)) {
    try {
      const json = await client.get(sofaPaths.statistics(e.id), SOFA_MAX_AGE.finished);
      if (json === null && Date.now() - e.startAt.getTime() < STATS_GRACE_MS) {
        console.log(`  … ${e.homeTeam.name}–${e.awayTeam.name}: ingen statistik än, provas nästa körning`);
        continue;
      }
      const t = shotTotals(parseStatistics(json ?? {}));
      await prisma.shotMatch.update({
        where: { id: ssMatchId(e.id) },
        data: { ...t, statsFetchedAt: new Date() },
      });
      fetched += 1;
      if (fetched % 25 === 0) console.log(`  … ${fetched}/${Math.min(pending.length, limit)}`);
    } catch (err) {
      if (err instanceof SofascoreBlockedError || err instanceof SofascoreBudgetError) throw err;
      failed += 1;
      console.error(`  ✗ ${ssMatchId(e.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`  Klart: ${fetched} hämtade, ${failed} misslyckade`);
  return { fetched, failed, budget: 0 };
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const useDb = hasShotsDb();
  if (confirm && !useDb) {
    console.error("SHOTS_DATABASE_URL saknas i .env.local — skottmodellen har en egen databas.");
    process.exit(1);
  }
  const leagueKey = argValue("--league") ?? "all";
  const seasonCount = numberArg("--seasons", 2);
  const limit = numberArg("--limit", 10_000);

  const candidates =
    leagueKey === "all" ? SHOT_LEAGUES : [findLeague(leagueKey)].filter((l): l is ShotLeague => l !== null);
  const leagues = candidates.filter((l) => l.sofascoreId != null);
  if (leagues.length === 0) {
    const known = SHOT_LEAGUES.filter((l) => l.sofascoreId != null).map((l) => l.key);
    console.error(`Okänd liga (eller utan sofascoreId) "${leagueKey}". Välj bland: ${known.join(", ")}, all`);
    process.exit(1);
  }

  console.log(`Läge: ${confirm ? "CONFIRM (skriver till DB)" : "DRY-RUN"} · källa: Sofascore via Scrapling`);
  console.log(`Ligor: ${leagues.map((l) => l.label).join(", ")} · ${seasonCount} säsong(er)`);
  if (limit < 10_000) console.log(`Tak den här körningen: ${limit} /statistics-anrop per liga`);
  if (!confirm) console.log("Dry-run gör listningsanropen men hämtar ingen statistik.");
  if (!useDb) console.log("(Ingen SHOTS_DATABASE_URL — budgeten räknas utan hänsyn till det som redan finns.)");

  const client = new SofascoreClient();
  let fetched = 0;
  let failed = 0;
  let budget = 0;
  try {
    for (const league of leagues) {
      const r = await ingestLeague(client, league, seasonCount, limit, confirm, useDb);
      fetched += r.fetched;
      failed += r.failed;
      budget += r.budget;
    }
  } catch (err) {
    if (err instanceof SofascoreBudgetError) console.log(`\n${err.message}`);
    else throw err;
  } finally {
    await client.close();
  }

  console.log(`\nSofascore: ${client.fetched} anrop, ${client.cacheHits} ur cachen`);
  if (confirm) {
    console.log(`Totalt: ${fetched} matchstatistik hämtad, ${failed} misslyckade`);
  } else {
    console.log(`Total anropsbudget: ${budget} /statistics-anrop`);
    console.log("Kör om med --confirm för att spara.");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
