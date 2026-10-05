/**
 * Laddar ner och tolkar HLTV-demos → demofakta (positioner, utility, setups,
 * ekonomi, timeouts, öppningsdueller …) i CS2-databasen.
 *
 *   npm run cs2:demos                                  # dry-run: kö och GB-budget
 *   npm run cs2:demos -- --confirm --upcoming          # bara lag med match inom 7 dagar
 *   npm run cs2:demos -- --confirm --max-gb 20 --max-series 30
 *   npm run cs2:demos -- --confirm --team 9565 --maps-per-team-map 10 --months 4
 *   npm run cs2:demos -- --confirm --file C:\demos\x.dem --match 2380001
 *   npm run cs2:demos -- --confirm --reanalyze         # räkna om ur lokala cachen
 *   npm run cs2:demos -- --confirm --redo-match 2398725,2398730   # ladda ner och tolka om just dessa
 *
 * Arkiven raderas efter tolkning (--keep-demos behåller dem). Kvar blir en
 * komprimerad, normaliserad kopia per karta i .cache/cs2/demos/norm.
 * Kör `npm run cs2:ingest -- --confirm` först — demos kopplas till kartor
 * och scoreboards som redan finns i databasen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { cs2Prisma as prisma, hasCs2Db } from "../../lib/cs2Db";
import { HltvSession, CS2_CACHE_DIR, headedFromArgs } from "../../lib/cs2/hltv/session";
import { loadDemoparser } from "../../lib/cs2/demo/parseDemo";
import { processDemoFile } from "../../lib/cs2/demo/process";
import { reanalyzeCached, runDemoQueue } from "../../lib/cs2/demo/run";
import { updateDerivedRoles } from "../../lib/cs2/roles";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}
function numberArg(flag: string, fallback: number): number {
  const n = Number(argValue(flag));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function listArg(flag: string): number[] {
  return (argValue(flag) ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function main() {
  if (!hasCs2Db()) {
    console.error("CS2_DATABASE_URL saknas i .env.local — se .env.local.example.");
    process.exit(1);
  }
  const confirm = process.argv.includes("--confirm");
  const cacheDir = CS2_CACHE_DIR;

  if (process.argv.includes("--reanalyze")) {
    if (!confirm) return console.log("--reanalyze skriver om demofakta. Lägg till --confirm.");
    await reanalyzeCached(prisma, cacheDir, !process.argv.includes("--all"), console.log);
    await updateDerivedRoles(prisma);
    return;
  }

  const file = argValue("--file");
  if (file) {
    const matchId = numberArg("--match", 0);
    if (!matchId) return console.error("--file kräver --match <HLTV-match-id>");
    if (!confirm) return console.log(`Skulle tolka ${file} för match ${matchId}. Lägg till --confirm.`);
    const api = await loadDemoparser();
    const res = await processDemoFile(prisma, api, file, matchId, cacheDir);
    if (!res) console.log("Demons karta finns inte i matchen — kör cs2:ingest för matchen först.");
    else console.log(res);
    await updateDerivedRoles(prisma);
    return;
  }

  const opts = {
    confirm,
    upcomingOnly: process.argv.includes("--upcoming"),
    days: numberArg("--days", 7),
    teams: listArg("--team"),
    perTeamMap: numberArg("--maps-per-team-map", 10),
    months: numberArg("--months", 4),
    maxGb: numberArg("--max-gb", 20),
    maxSeries: numberArg("--max-series", 40),
    keepDemos: process.argv.includes("--keep-demos"),
    retryFailed: process.argv.includes("--retry-failed"),
    cacheDir,
    redoMatches: listArg("--redo-match"),
  };
  console.log(`Läge: ${confirm ? "CONFIRM" : "DRY-RUN"} · ${opts.upcomingOnly ? "lag med kommande match" : "bevakade lag"} · ${opts.perTeamMap} kartor per lag och karta, ${opts.months} mån`);

  const api = confirm ? await loadDemoparser() : null;
  const session = new HltvSession({ headed: headedFromArgs() });
  try {
    const s = await runDemoQueue(prisma, session, api, opts, console.log);
    console.log("");
    if (!confirm) {
      console.log(`Kö: ${s.queued} serier ≈ ${s.estimatedGb} GB nedladdning (raderas efter tolkning).`);
      console.log(`Med --max-gb ${opts.maxGb} och --max-series ${opts.maxSeries} tas de första i kön. Kör om med --confirm.`);
      return;
    }
    console.log(`Klart: ${s.processedSeries} serier, ${s.processedMaps} kartor, ${s.downloadedGb} GB nedladdat.`);
    const diffs = s.results.filter((r) => r.killDiffs.length > 0);
    if (diffs.length > 0) {
      console.log(`\nKill-avvikelser mot HLTV på ${diffs.length} kartor (spelarlänk eller rundavgränsning):`);
      for (const r of diffs.slice(0, 10))
        console.log(`  karta ${r.mapId} ${r.mapName}: ${r.killDiffs.map((d) => `${d.nickname} demo ${d.demo}/HLTV ${d.hltv}`).join(", ")}`);
    }
    const missing = new Set(s.results.flatMap((r) => r.missingFields));
    if (missing.size > 0) console.log(`\nFält som demoparsern inte gav: ${[...missing].join(", ")} — rapportera så kan normaliseringen anpassas.`);
    if (s.stoppedBy) console.log(`\nStoppad av ${s.stoppedBy === "gb" ? "GB-taket" : "serietaket"} — kör igen för att fortsätta.`);
    if (s.errors.length > 0) {
      console.log(`\n${s.errors.length} fel:`);
      for (const e of s.errors.slice(0, 20)) console.log(`  ✗ ${e}`);
    }
    await updateDerivedRoles(prisma);
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
