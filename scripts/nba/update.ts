/**
 * Den dagliga NBA-körningen. Tänkt för Schemaläggaren i Windows, som cs2:update.
 *
 *   npm run nba:update                 # resultat, skador, odds (1 OddsPapi-anrop), projektioner
 *   npm run nba:update -- --no-odds    # utan OddsPapi (ESPN:s linjer används om de finns)
 *   npm run nba:update -- --hours 48   # projicera matcher inom 48 h (standard 36)
 *   npm run nba:closing                # nära tip-off: skador + odds som stängning + projektioner
 *
 * Steg:
 *   1. ESPN: de senaste 3 dagarnas resultat och boxscores, och kommande matcher
 *   2. ESPN:s skadelista och DraftKings-linjer för kommande matcher (gratis)
 *   3. OddsPapi: alla NBA-matchers odds i ett anrop (hoppas över utan nyckel)
 *   4. Modellen: minuter → simulering → pris mot marknaden, sparas i NbaProjection
 *   5. Facit för spelade matcher
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { fetchInjuries, fetchScoreboard, fetchSummary } from "../../lib/nba/espn";
import { saveInjuries, saveSummary, upsertGames } from "../../lib/nba/store";
import { ingestRange } from "./ingest";
import { captureNbaOdds } from "../../lib/nba/oddspapiCapture";
import { hasOddspapiKey, oddspapiCallsThisRun, OddspapiError, quotaLeft } from "../../lib/oddspapi";
import { projectUpcoming, settlePicks, settleProjections } from "../../lib/nba/pipeline";

function numberArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local (se .env.local.example)");
    process.exit(1);
  }
  const closing = process.argv.includes("--closing");
  const now = Date.now();

  if (!closing) {
    console.log("1/5 ESPN: resultat och kommande matcher");
    const r = await ingestRange(new Date(now - 3 * 864e5), new Date(now), { log: () => {} });
    let upcoming = 0;
    for (let d = 1; d <= 3; d++) {
      const list = (await fetchScoreboard(new Date(now + d * 864e5))).filter((g) => g.seasonType !== 1 && g.seasonType !== 4);
      upcoming += await upsertGames(db, list);
    }
    console.log(`   ${r.boxes} nya boxscores, ${upcoming} kommande matcher${r.errors ? `, ${r.errors} fel` : ""}`);
  }

  console.log(`${closing ? "1/3" : "2/5"} ESPN: skadelistan`);
  const inj = await saveInjuries(db, await fetchInjuries());
  console.log(`   ${inj} spelare på listan`);
  // ESPN:s matchsidor har DraftKings-linjen även före match — gratis reserv
  // när OddsPapi saknas eller kvoten är slut.
  const hours = closing ? 4 : numberArg("--hours", 36);
  const soon = await db.nbaGame.findMany({
    where: { status: "scheduled", startAt: { gte: new Date(now - 3600e3), lte: new Date(now + hours * 3600e3) } },
    select: { id: true },
  });
  let espnLines = 0;
  for (const g of soon) {
    try {
      const s = await fetchSummary(g.id);
      if (s?.odds) {
        await saveSummary(db, s);
        espnLines++;
      }
    } catch {
      /* en enskild match ska inte stoppa körningen */
    }
  }
  console.log(`   DraftKings-linjer för ${espnLines}/${soon.length} kommande matcher`);

  console.log(`${closing ? "2/3" : "3/5"} OddsPapi${closing ? " (stängning)" : ""}`);
  if (process.argv.includes("--no-odds")) console.log("   hoppar över (--no-odds)");
  else if (!hasOddspapiKey()) console.log("   ODDSPAPI_KEY saknas — hoppar över, ESPN:s linjer används där de finns");
  else {
    try {
      const c = await captureNbaOdds(db, { closing, log: (m) => console.log(`   ${m}`) });
      console.log(`   ${c.matched}/${c.fixtures} matcher kopplade, ${c.saved} nya priser`);
      if (c.unmatched.length) console.log(`   ej kopplade: ${c.unmatched.slice(0, 5).join("; ")}${c.unmatched.length > 5 ? " …" : ""}`);
    } catch (e) {
      const msg = e instanceof OddspapiError && e.quotaExceeded ? "månadens kvot är slut" : e instanceof Error ? e.message : String(e);
      console.log(`   hoppar över oddsen: ${msg}`);
    }
    const q = await quotaLeft();
    console.log(`   ${oddspapiCallsThisRun()} anrop nu${q ? `, ${q.used}/${q.limit} använda denna månad` : ""}`);
  }

  console.log(`${closing ? "3/3" : "4/5"} Modellen`);
  const p = await projectUpcoming(db, { hours, log: (m) => console.log(`   ${m}`) });
  console.log(`   ${p.games} matcher projicerade, ${p.flagged} priser med edge ≥ 5 %`);

  if (!closing) {
    console.log("5/5 Facit");
    console.log(`   ${await settleProjections(db)} projektioner och ${await settlePicks(db)} låsta picks rättade`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
