/**
 * Pinnacles stängningsodds för spelade NBA-matcher ur OddsPapi:s historik —
 * underlaget för en backtest mot den skarpaste marknaden.
 *
 *   npm run nba:odds-history -- --from 2026-01-01 --to 2026-06-30 --confirm
 *
 * Kostnad: historiken är gratis, men matcherna måste först kopplas till
 * OddsPapi-fixtures via /fixtures, som är debiterat: ett anrop per 9 dagar
 * (en hel säsong ≈ 25 anrop). --max-calls sätter taket (standard 25).
 * Utan --confirm skrivs bara ut vad som skulle hända.
 *
 * Historiken finns från januari 2026. Historik-endpointen har 5 s cooldown,
 * så 600 matcher tar runt en timme. Kan avbrytas och köras igen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { hasOddspapiKey, oddspapiCallsThisRun } from "../../lib/oddspapi";
import { captureHistoricalClosing, linkHistoricalFixtures } from "../../lib/nba/oddspapiCapture";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  if (!hasNbaDb() || !hasOddspapiKey()) {
    console.error("NBA_DATABASE_URL och ODDSPAPI_KEY måste finnas i .env.local");
    process.exit(1);
  }
  const from = new Date(`${arg("--from") ?? "2026-01-01"}T00:00:00Z`);
  const to = new Date(`${arg("--to") ?? new Date().toISOString().slice(0, 10)}T23:59:59Z`);
  const maxCalls = Number(arg("--max-calls")) || 25;
  const unlinked = await db.nbaGame.count({ where: { status: "final", startAt: { gte: from, lte: to }, oddspapiFixtureId: null } });
  const windows = Math.ceil((to.getTime() - from.getTime()) / (9 * 864e5));
  console.log(`${unlinked} spelade matcher saknar OddsPapi-koppling. Koppling kostar upp till ${Math.min(windows, maxCalls)} anrop.`);
  if (!process.argv.includes("--confirm")) {
    console.log("Kör igen med --confirm för att hämta.");
    return;
  }
  if (unlinked > 0) {
    const l = await linkHistoricalFixtures(db, { from, to, maxCalls, log: (m) => console.log(`  ${m}`) });
    console.log(`Kopplade ${l.linked} matcher med ${l.calls} anrop`);
  }
  const r = await captureHistoricalClosing(db, { from, to, log: (m) => console.log(`  ${m}`) });
  console.log(`Klart: ${r.games} matcher, ${r.saved} stängningspriser, ${r.empty} utan historik. Debiterade anrop: ${oddspapiCallsThisRun()}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
