/**
 * Läser in kommande matcher OCH deras bookmakerpriser från The Odds API.
 *
 *   npm run odds:ingest                            # torrkörning
 *   npm run odds:ingest -- --confirm               # h2h, eu,se, 4 krediter
 *   npm run odds:ingest -- --regions eu --confirm
 *   npm run odds:ingest -- --league laliga --confirm
 *
 * The Odds API är enda källan sedan TheStatsAPI kopplades ur. Ett anrop per
 * LIGA ger hela ligan i ett svar, så en full uppdatering kostar fyra krediter
 * (2 ligor × h2h × 2 regioner). Alla kartlagda böcker skrivs, börsen och
 * Pinnacle inräknade; de sätter fair line i lib/marketOdds.ts.
 *
 * Fixtur och priser kommer ur SAMMA svar med samma event-id, så ingen fuzzy
 * matchning behövs — skriptet upsertar en ShotMatch per match och ersätter
 * dess priser. Schemalagda fixturer som API:et inte längre returnerar rensas
 * bort; det städar även undan gamla TheStatsAPI-fixturer vid övergången.
 *
 * Kör `npm run odds:probe` först om du är osäker på region eller täckning.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { getEventOddsWithQuota, getOddsWithQuota, hasOddsApiKey } from "../../lib/oddsApi";
import {
  extractOddsApiPrices,
  normalizeTeam,
  ODDS_API_ALT_MARKET,
  ODDS_API_REFERENCE_ONLY,
  ODDS_API_DEFAULT_MARKETS,
  ODDS_API_DEFAULT_REGIONS,
  ODDS_API_INGESTED_SLUGS,
  ODDS_API_SPORT_KEY,
  type RawOddsEvent,
} from "../../lib/oddsApiMap";
import { shotsPrisma as prisma, hasShotsDb } from "../../lib/shotsDb";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Nyckel för unikhetsindexet. "-" betyder linjelös marknad (1X2). */
const lineKeyOf = (line: number | null) => (line == null ? "-" : String(line));

interface LeagueResult {
  events: number;
  matched: number;
  rows: number;
  unmatched: string[];
  unknownBooks: Set<string>;
}

/**
 * Syntetiskt lag-id ur namnet. ShotMatch kräver icke-null team-id:n, men The
 * Odds API ger inga — och EV-skärmen läser dem aldrig. "oa:" märker ut att raden
 * är Odds-API-källad, inte TheStatsAPI-källad.
 */
const teamId = (name: string) => "oa:" + normalizeTeam(name).replace(/\s+/g, "-");

async function ingest(
  leagueKey: string,
  markets: string,
  regions: string,
  altTotals: boolean,
  confirm: boolean
): Promise<LeagueResult> {
  const sportKey = ODDS_API_SPORT_KEY[leagueKey];
  const now = new Date();

  const { data: events, quota } = await getOddsWithQuota(sportKey, { regions, markets });
  console.log(`\n=== ${leagueKey} (${sportKey}) ===`);
  console.log(`  ${events.length} matcher från API:et`);
  console.log(`  kvot: kvar ${quota.remaining ?? "?"} · detta anrop ${quota.last ?? "?"}`);

  const result: LeagueResult = {
    events: events.length, matched: 0, rows: 0, unmatched: [], unknownBooks: new Set(),
  };

  const capturedAt = new Date();
  const seenIds: string[] = [];
  let altCredits = 0;
  let altFailed = 0;

  for (const ev of events) {
    const { rows, unknownBookmakers } = extractOddsApiPrices(ev as unknown as RawOddsEvent);
    for (const u of unknownBookmakers) result.unknownBooks.add(u);
    // En match utan en enda kartlagd bok är inget att jämföra — hoppa den,
    // annars skulle en tom fixture ligga kvar på skärmen utan priser.
    if (rows.length === 0) {
      result.unmatched.push(`${ev.commence_time.slice(0, 16).replace("T", " ")} ${ev.home_team} – ${ev.away_team}`);
      continue;
    }
    result.matched += 1;
    seenIds.push(ev.id);

    const byKey = new Map<string, (typeof rows)[number] & { lineKey: string }>();
    for (const r of rows) {
      const lineKey = lineKeyOf(r.line);
      byKey.set(`${r.bookmaker}|${r.market}|${r.outcome}|${lineKey}`, { ...r, lineKey });
    }
    // Referensens alternativa totals-linjer. Utan dem tappas varje
    // över/under-marknad där böckerna ligger på en annan linje än Pinnacle.
    if (altTotals) {
      try {
        const alt = await getEventOddsWithQuota(sportKey, ev.id, {
          regions,
          markets: ODDS_API_ALT_MARKET,
        });
        altCredits += alt.quota.last ?? 0;
        const altRows = extractOddsApiPrices(alt.data as unknown as RawOddsEvent).rows;
        for (const r of altRows) {
          // Bara referensböckerna — se ODDS_API_ALT_MARKET.
          if (!ODDS_API_REFERENCE_ONLY.has(r.bookmaker) && r.bookmaker !== "pinnacle") continue;
          const lineKey = lineKeyOf(r.line);
          const k = `${r.bookmaker}|${r.market}|${r.outcome}|${lineKey}`;
          // Bulk-priset vinner när linjen redan finns — det är bokens huvudlinje.
          if (!byKey.has(k)) byKey.set(k, { ...r, lineKey });
        }
      } catch {
        // En match utan alternativa linjer är inget fel — huvudlinjerna finns kvar.
        altFailed += 1;
      }
    }

    result.rows += byKey.size;
    if (!confirm) continue;

    const kickoffAt = new Date(ev.commence_time);
    // Fixtur och priser kommer ur SAMMA svar med samma id — ingen fuzzy
    // matchning behövs längre. Fixturen upsertas, matchens priser ersätts helt.
    await prisma.$transaction([
      prisma.shotMatch.upsert({
        where: { id: ev.id },
        create: {
          id: ev.id,
          leagueKey,
          competitionId: sportKey,
          kickoffAt,
          status: "scheduled",
          homeTeamId: teamId(ev.home_team),
          awayTeamId: teamId(ev.away_team),
          homeTeamName: ev.home_team,
          awayTeamName: ev.away_team,
        },
        update: {
          kickoffAt,
          status: "scheduled",
          homeTeamName: ev.home_team,
          awayTeamName: ev.away_team,
        },
      }),
      prisma.marketPrice.deleteMany({ where: { matchId: ev.id } }),
      prisma.marketPrice.createMany({
        data: [...byKey.values()].map((r) => ({
          matchId: ev.id,
          bookmaker: r.bookmaker,
          market: r.market,
          outcome: r.outcome,
          line: r.line,
          lineKey: r.lineKey,
          odds: r.odds,
          layOdds: r.layOdds,
          backSize: r.backSize,
          laySize: r.laySize,
          capturedAt,
        })),
      }),
    ]);
  }

  // The Odds API är sanningen om vilka kommande matcher som finns. Schemalagda
  // fixturer i ligan som API:et INTE längre returnerar tas bort — det rensar
  // gamla TheStatsAPI-rader (mt_…) vid övergången och deras priser via cascade.
  // Bara status="scheduled" och kickoff i framtiden rörs; färdigspelade matcher
  // (skottmodellens historik) har status="finished" och lämnas orörda.
  if (confirm) {
    const removed = await prisma.shotMatch.deleteMany({
      where: {
        leagueKey,
        status: "scheduled",
        kickoffAt: { gte: now },
        id: { notIn: seenIds.length ? seenIds : ["__none__"] },
      },
    });
    if (removed.count > 0) console.log(`  rensade ${removed.count} inaktuella fixturer (+ deras priser)`);
  }

  console.log(`  ${result.matched}/${result.events} matcher med priser · ${result.rows} prisrader`);
  if (altTotals) {
    console.log(`  alternativa totals-linjer: ${altCredits} krediter${altFailed ? `, ${altFailed} matcher utan` : ""}`);
  }
  if (result.unmatched.length) {
    console.log(`  utan kartlagda böcker (${result.unmatched.length}):`);
    for (const u of result.unmatched.slice(0, 8)) console.log(`     ${u}`);
    if (result.unmatched.length > 8) console.log(`     … och ${result.unmatched.length - 8} till`);
  }
  return result;
}

async function main() {
  if (!hasShotsDb()) {
    console.error("SHOTS_DATABASE_URL saknas i .env");
    process.exit(1);
  }
  if (!hasOddsApiKey()) {
    console.error("ODDS_API_KEY saknas. Lägg in den i .env.local:");
    console.error('  ODDS_API_KEY="din-nyckel"');
    process.exit(1);
  }

  const confirm = process.argv.includes("--confirm");
  const markets = argValue("--markets") ?? ODDS_API_DEFAULT_MARKETS;
  const regions = argValue("--regions") ?? ODDS_API_DEFAULT_REGIONS;
  const altTotals = !process.argv.includes("--no-alt-totals");
  const key = argValue("--league") ?? "all";
  const leagues = key === "all" ? Object.keys(ODDS_API_SPORT_KEY) : [key];

  const unknownLeague = leagues.find((l) => !ODDS_API_SPORT_KEY[l]);
  if (unknownLeague) {
    console.error(`Okänd liga "${unknownLeague}". Välj bland: ${Object.keys(ODDS_API_SPORT_KEY).join(", ")}, all`);
    process.exit(1);
  }

  console.log(`Läge: ${confirm ? "CONFIRM (skriver till DB)" : "DRY-RUN"}`);
  console.log(`Marknader: ${markets} · regioner: ${regions} · ligor: ${leagues.join(", ")}`);
  console.log(
    `Kostnad: ~${markets.split(",").length * regions.split(",").length * leagues.length} krediter ` +
      "(1 per marknad OCH region, per liga)"
  );
  console.log(
    `Alternativa totals-linjer för referensen: ${altTotals ? "ja (2 krediter/match)" : "nej"}`
  );
  console.log(`Böcker som läses in: ${ODDS_API_INGESTED_SLUGS.join(", ")}`);

  let events = 0, matched = 0, rows = 0, skipped = 0;
  const unknownBooks = new Set<string>();
  for (const l of leagues) {
    const r = await ingest(l, markets, regions, altTotals, confirm);
    events += r.events;
    matched += r.matched;
    rows += r.rows;
    skipped += r.unmatched.length;
    for (const u of r.unknownBooks) unknownBooks.add(u);
  }

  console.log(`\nTotalt: ${matched}/${events} matcher med priser · ${rows} prisrader · ${skipped} utan kartlagda böcker`);
  if (unknownBooks.size) {
    console.log(`Okända böcker (lägg till i ODDS_API_BOOKMAKER_SLUG vid behov): ${[...unknownBooks].join(", ")}`);
  }
  if (!confirm) console.log("Kör om med --confirm för att spara.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
