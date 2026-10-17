/**
 * Den dagliga körningen: HLTV-inläsning, demos för lag med kommande matcher,
 * Unibets linjer för kommande matcher, facit för sparade linjer och roller.
 * Tänkt för Schemaläggaren i Windows.
 *
 *   npm run cs2:update                     # allt, med försiktiga tak
 *   npm run cs2:update -- --max-gb 10 --no-demos
 *   npm run cs2:update -- --no-lines       # utan Unibet-linjerna
 *   npm run cs2:update -- --all-lines      # linjer även för matcher utan bevakat lag
 *   npm run cs2:lines                      # bara Unibet-linjerna (= --only-lines), utan webbläsare
 *
 * Linjerna hämtas vid varje körning och sparas i en ny version bara när
 * oddsen ändrats. Kör oftare än en gång om dagen för att få oddsen närmare
 * matchstart — det är den senaste versionen som räknas i facit.
 *
 * Inget skrivs i dry-run-läge här — update kör alltid skarpt, men med samma
 * sidtak och GB-tak som de enskilda skripten.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { cs2Prisma as prisma, hasCs2Db } from "../../lib/cs2Db";
import { HltvSession, CS2_CACHE_DIR, headedFromArgs } from "../../lib/cs2/hltv/session";
import { runIngest } from "../../lib/cs2/pipeline";
import { runDemoQueue } from "../../lib/cs2/demo/run";
import { loadDemoparser } from "../../lib/cs2/demo/parseDemo";
import { settleProjections } from "../../lib/cs2/settle";
import { captureKambiLines } from "../../lib/cs2/lineStore";
import { KAMBI_BOOKMAKER } from "../../lib/cs2/kambi";
import { updateDerivedRoles } from "../../lib/cs2/roles";

function numberArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Unibets linjer för kommande matcher. Ett fel här ska inte stoppa resten av körningen. */
async function captureLines(step: string) {
  console.log(`${step}${KAMBI_BOOKMAKER}-linjer för kommande matcher`);
  try {
    const l = await captureKambiLines(
      prisma,
      { days: numberArg("--days", 7), trackedOnly: !process.argv.includes("--all-lines"), delayMs: 1000 },
      (m) => console.log(`    ${m}`)
    );
    console.log(`   ${l.found}/${l.matches} matcher hos ${KAMBI_BOOKMAKER}, ${l.saved} linjer sparade, ${l.unchanged} oförändrade, ${l.skipped} hoppade över`);
    if (l.errors.length) console.log(`   ${l.errors.length} fel, första: ${l.errors[0]}`);
  } catch (e) {
    // Kambi är inget officiellt API — ett fel här ska inte stoppa facit och roller.
    console.log(`   hoppar över linjerna: ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  if (!hasCs2Db()) {
    console.error("CS2_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  // Snabbläget: bara linjerna, utan HLTV-webbläsaren — tänkt att köras nära matchstart.
  if (process.argv.includes("--only-lines")) {
    await captureLines("");
    return;
  }
  const session = new HltvSession({ headed: headedFromArgs(), maxPages: numberArg("--max-pages", 600) });
  try {
    console.log("1/5 HLTV");
    const s = await runIngest(
      prisma,
      session,
      { confirm: true, topN: numberArg("--top", 50), months: numberArg("--months", 6), ranking: "vrs", extraTeams: [], skipRanking: false, upcomingDays: numberArg("--days", 7) },
      console.log
    );
    console.log(`   ${s.matchesWritten} matcher, ${s.mapsWritten} kartor, ${s.fetched} sidor hämtade${s.stoppedByBudget ? " (sidtaket nått)" : ""}`);
    if (s.errors.length) console.log(`   ${s.errors.length} fel, första: ${s.errors[0]}`);

    if (!process.argv.includes("--no-demos")) {
      console.log("2/5 Demos för lag med kommande matcher");
      const api = await loadDemoparser().catch((e) => {
        console.log(`   hoppar över demos: ${e instanceof Error ? e.message : e}`);
        return null;
      });
      if (api) {
        const d = await runDemoQueue(
          prisma,
          session,
          api,
          { confirm: true, upcomingOnly: true, days: numberArg("--days", 7), teams: [], perTeamMap: numberArg("--maps-per-team-map", 10), months: 4, maxGb: numberArg("--max-gb", 15), maxSeries: numberArg("--max-series", 25), keepDemos: false, retryFailed: false, cacheDir: CS2_CACHE_DIR },
          (m) => console.log(`  ${m}`)
        );
        console.log(`   ${d.processedSeries}/${d.queued} serier, ${d.processedMaps} kartor, ${d.downloadedGb} GB`);
      }
    }
    if (!process.argv.includes("--no-lines")) await captureLines("3/5 ");
    console.log("4/5 Facit för sparade linjer");
    console.log(`   ${await settleProjections(prisma)} linjer avgjorda`);
    console.log("5/5 Roller");
    console.log(`   ${await updateDerivedRoles(prisma)} spelare`);
  } finally {
    await session.close();
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
