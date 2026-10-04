/**
 * Läser in lag, trupper, matcher, veton och kartstatistik från HLTV till
 * CS2-databasen.
 *
 *   npm run cs2:ingest                         # dry-run: budget, inget skrivs
 *   npm run cs2:ingest -- --confirm            # topp 50 (VRS), 6 månader
 *   npm run cs2:ingest -- --confirm --top 30 --months 3
 *   npm run cs2:ingest -- --confirm --team 9565   # ett extra lag (HLTV-id)
 *   npm run cs2:ingest -- --confirm --headless    # osynligt (standard är synligt fönster för Cloudflare)
 *   npm run cs2:ingest -- --confirm --reparse     # tolka om cachen, inget nätverk
 *
 * Varje sida cachas i .cache/cs2/html, så en avbruten körning fortsätter där
 * den slutade och en dry-run är aldrig bortkastad.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { cs2Prisma as prisma, hasCs2Db } from "../../lib/cs2Db";
import { HltvSession, headedFromArgs } from "../../lib/cs2/hltv/session";
import { runIngest, runReparse } from "../../lib/cs2/pipeline";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function numberArg(flag: string, fallback: number): number {
  const n = Number(argValue(flag));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listArg(flag: string): number[] {
  const out: number[] = [];
  process.argv.forEach((a, i) => {
    if (a !== flag) return;
    for (const part of (process.argv[i + 1] ?? "").split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  });
  return out;
}

async function main() {
  if (!hasCs2Db()) {
    console.error("CS2_DATABASE_URL saknas i .env.local — CS2-modulen har en egen databas. Se .env.local.example.");
    process.exit(1);
  }
  const confirm = process.argv.includes("--confirm");
  const reparse = process.argv.includes("--reparse");
  const session = new HltvSession({
    headed: headedFromArgs(),
    maxPages: numberArg("--max-pages", Number(process.env.CS2_HLTV_MAX_PAGES) || 1500),
    offline: reparse,
  });

  try {
    if (reparse) {
      if (!confirm) {
        console.log("--reparse skriver om databasen ur cachen. Lägg till --confirm för att köra.");
        return;
      }
      await runReparse(prisma, session, console.log);
      return;
    }

    const opts = {
      confirm,
      topN: numberArg("--top", 50),
      months: numberArg("--months", 6),
      ranking: (argValue("--ranking") === "hltv" ? "hltv" : "vrs") as "vrs" | "hltv",
      extraTeams: listArg("--team"),
      skipRanking: process.argv.includes("--skip-ranking"),
      upcomingDays: numberArg("--days", 7),
    };
    console.log(`Läge: ${confirm ? "CONFIRM (skriver till DB)" : "DRY-RUN"}`);
    console.log(`Topp ${opts.topN} (${opts.ranking}), senaste ${opts.months} månader, kommande ${opts.upcomingDays} dagar`);

    const s = await runIngest(prisma, session, opts, console.log);

    console.log("");
    console.log(`Bevakade lag: ${s.trackedTeams} · vid behov: ${s.onDemandTeams} · kommande matcher: ${s.upcomingMatches}`);
    if (confirm) {
      console.log(`Skrivet: ${s.matchesWritten} matcher, ${s.mapsWritten} kartor`);
    } else {
      console.log(`Budget: ${s.matchPagesNeeded} matchsidor + ~${s.mapStatsNeeded} mapstats-sidor`);
      const pages = s.matchPagesNeeded + s.mapStatsNeeded;
      console.log(`≈ ${pages} sidor ≈ ${Math.round((pages * 6) / 60)} min i nuvarande takt. Kör om med --confirm.`);
    }
    console.log(`Sidor: ${s.fetched} hämtade, ${s.cacheHits} ur cachen`);
    if (s.stoppedByBudget) console.log("Stoppad av sidtaket — kör igen för att fortsätta.");
    if (s.errors.length > 0) {
      console.log(`\n${s.errors.length} fel:`);
      for (const e of s.errors.slice(0, 30)) console.log(`  ✗ ${e}`);
      if (s.errors.length > 30) console.log(`  … och ${s.errors.length - 30} till`);
    }
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
