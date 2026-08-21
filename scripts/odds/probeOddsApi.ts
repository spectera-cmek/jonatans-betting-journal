/**
 * Mäter vad The Odds API faktiskt levererar innan något byggs på den.
 *
 *   npm run odds:probe -- --sports                      # 0 krediter
 *   npm run odds:probe -- --league laliga --regions eu,se  # 2 krediter
 *   npm run odds:probe                                  # 3 krediter, h2h
 *   npm run odds:probe -- --markets h2h,totals,spreads  # 9 krediter
 *
 * Fem frågor skriptet svarar på, alla sådana som annars upptäcks först när en
 * inläsning redan kostat kvot:
 *
 *   1. Vad kostar ett anrop, enligt x-requests-last?
 *   2. Vilken region ger de svenska böckerna? Dokumentationen listar bara
 *      us/us2/uk/au/eu, men bokmakarlistan märker Betsson och NordicBet med
 *      `se`. Kör en liga med --regions eu,se innan allt läses in.
 *   3. Bär börsflödet orderdjup? (Dokumentationen säger nej. Kontrollera.)
 *   4. Finns totals/spreads alls för fotboll, eller bara för US-sporter?
 *   5. Går matcherna att koppla till fixturerna i ShotMatch?
 *
 * Fråga 3 är den som avgör arkitekturen. Utan djup kan The Odds API inte
 * ersätta TheStatsAPI som börskälla — se ODDS_API_HAS_NO_DEPTH i lib/oddsApiMap.
 *
 * Börja alltid med EN liga. Går något fel kostade det två krediter i stället
 * för nio, och felmeddelandet räknar upp giltiga regioner.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { getOddsWithQuota, getSports, hasOddsApiKey, type OddsEvent } from "../../lib/oddsApi";
import {
  bookmakerSlugFor,
  extractOddsApiPrices,
  matchFixture,
  ODDS_API_DEFAULT_MARKETS,
  ODDS_API_DEFAULT_REGIONS,
  ODDS_API_SPORT_KEY,
  type FixtureCandidate,
  type RawOddsEvent,
} from "../../lib/oddsApiMap";
import { shotsPrisma as prisma, hasShotsDb } from "../../lib/shotsDb";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const leagueArg = argValue("--league");
const LEAGUES = leagueArg ? [leagueArg] : Object.keys(ODDS_API_SPORT_KEY);
const REGIONS = argValue("--regions") ?? ODDS_API_DEFAULT_REGIONS;
const MARKETS = argValue("--markets") ?? ODDS_API_DEFAULT_MARKETS;

/** Fältnamn som skulle betyda att börsdjup ändå finns med. */
const DEPTH_HINTS = ["size", "liquidity", "available", "amount", "matched", "volume"];

function findDepthFields(events: OddsEvent[]): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (DEPTH_HINTS.some((h) => k.toLowerCase().includes(h))) found.add(k);
      walk(v);
    }
  };
  walk(events);
  return [...found];
}

async function main() {
  if (!hasOddsApiKey()) {
    console.error("ODDS_API_KEY saknas. Lägg in den i .env.local och kör om:");
    console.error('  ODDS_API_KEY="din-nyckel"');
    process.exit(1);
  }

  // /sports kostar ingen kvot. Bra första kontroll att nyckeln alls lever.
  const sports = await getSports();
  const soccer = sports.filter((s) => s.key.startsWith("soccer_") && s.active);
  console.log(`Nyckeln fungerar. ${sports.length} sporter, varav ${soccer.length} aktiva fotbollsligor.`);
  for (const key of Object.values(ODDS_API_SPORT_KEY)) {
    const hit = sports.find((s) => s.key === key);
    console.log(`  ${hit ? "✓" : "✗"} ${key}${hit ? ` — ${hit.title}` : " SAKNAS"}`);
  }
  const unknownLeague = LEAGUES.find((l) => !ODDS_API_SPORT_KEY[l]);
  if (unknownLeague) {
    console.error(`\nOkänd liga "${unknownLeague}". Välj bland: ${Object.keys(ODDS_API_SPORT_KEY).join(", ")}`);
    process.exit(1);
  }
  if (process.argv.includes("--sports")) return;

  const markets = MARKETS;
  const cost = markets.split(",").length * REGIONS.split(",").length * LEAGUES.length;
  console.log(
    `\nHämtar ${markets} för ${LEAGUES.length} liga(or) · regions=${REGIONS} · ~${cost} krediter\n`
  );

  const fixtures = hasShotsDb()
    ? await prisma.shotMatch.findMany({
        where: {
          leagueKey: { in: LEAGUES },
          status: "scheduled",
          kickoffAt: { gte: new Date() },
        },
        select: { id: true, leagueKey: true, kickoffAt: true, homeTeamName: true, awayTeamName: true },
      })
    : [];

  const allBooks = new Map<string, number>();
  const unknownBooks = new Map<string, number>();
  const marketsSeen = new Map<string, number>();
  const depthFields = new Set<string>();
  let quotaLine = "";

  for (const leagueKey of LEAGUES) {
    const sportKey = ODDS_API_SPORT_KEY[leagueKey];
    const { data: events, quota } = await getOddsWithQuota(sportKey, { regions: REGIONS, markets });
    quotaLine = `kvar ${quota.remaining ?? "?"} · använt ${quota.used ?? "?"} · detta anrop ${quota.last ?? "?"}`;

    for (const f of findDepthFields(events)) depthFields.add(f);

    const candidates: FixtureCandidate[] = fixtures
      .filter((f) => f.leagueKey === leagueKey)
      .map((f) => ({ id: f.id, kickoffAt: f.kickoffAt, homeTeamName: f.homeTeamName, awayTeamName: f.awayTeamName }));

    let matched = 0;
    const unmatched: string[] = [];
    let rowTotal = 0;

    for (const ev of events) {
      const { rows, unknownBookmakers } = extractOddsApiPrices(ev as unknown as RawOddsEvent);
      rowTotal += rows.length;
      // Vilka marknader som FAKTISKT kom tillbaka. Dokumentationen säger att
      // spreads och totals "mainly" finns för US-sporter; det här visar om de
      // finns för fotboll utan att någon behöver gissa.
      for (const b of ev.bookmakers ?? []) {
        for (const m of b.markets ?? []) {
          marketsSeen.set(m.key, (marketsSeen.get(m.key) ?? 0) + 1);
        }
      }
      for (const b of ev.bookmakers ?? []) {
        const slug = bookmakerSlugFor(b.key);
        if (slug) allBooks.set(slug, (allBooks.get(slug) ?? 0) + 1);
      }
      for (const u of unknownBookmakers) unknownBooks.set(u, (unknownBooks.get(u) ?? 0) + 1);

      const hit = matchFixture(ev, candidates);
      if (hit) matched += 1;
      else unmatched.push(`${ev.commence_time.slice(0, 16)} ${ev.home_team} – ${ev.away_team}`);
    }

    console.log(`=== ${leagueKey} (${sportKey}) ===`);
    console.log(`  ${events.length} matcher · ${rowTotal} prisrader · ${candidates.length} fixturer i DB`);
    console.log(`  kopplade: ${matched}/${events.length}`);
    if (unmatched.length) {
      console.log(`  OKOPPLADE (${unmatched.length}):`);
      for (const u of unmatched.slice(0, 10)) console.log(`     ${u}`);
      if (unmatched.length > 10) console.log(`     … och ${unmatched.length - 10} till`);
    }
    console.log(`  kvot: ${quotaLine}\n`);
  }

  console.log("=== Marknader som faktiskt returnerades ===");
  for (const key of markets.split(",")) {
    const n = marketsSeen.get(key) ?? 0;
    console.log(`  ${key.padEnd(12)} ${n === 0 ? "0 — finns INTE för fotboll" : n}`);
  }
  for (const [key, n] of marketsSeen) {
    if (!markets.split(",").includes(key)) console.log(`  ${key.padEnd(12)} ${n} (bonus, ej begärd)`);
  }

  console.log("\n=== Böcker som returnerades (antal matcher) ===");
  for (const [slug, n] of [...allBooks].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${slug.padEnd(22)} ${n}`);
  }
  if (unknownBooks.size) {
    console.log("\n=== Okända böcker — lägg till i ODDS_API_BOOKMAKER_SLUG om de är värda att spela hos ===");
    for (const [key, n] of [...unknownBooks].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${key.padEnd(22)} ${n}`);
    }
  }

  console.log("\n=== Börsdjup ===");
  if (depthFields.size === 0) {
    console.log("  Inga djupfält i svaret. Bekräftar ODDS_API_HAS_NO_DEPTH:");
    console.log("  börsen kan användas som andra åsikt, men inte som likviditetsprövad referens.");
    console.log("  TheStatsAPI måste därför behållas för börsdjupet.");
  } else {
    console.log(`  Hittade fält: ${[...depthFields].join(", ")}`);
    console.log("  Kontrollera om de bär orderdjup — i så fall kan börsen läsas härifrån också.");
  }
  console.log(`\nSlutlig kvot: ${quotaLine}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
