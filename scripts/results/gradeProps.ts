/**
 * Rättar props och statistikmarknader (spelarskott, poäng, returer, hörnor,
 * lagskott, BTTS …) i fotboll, basket och hockey ur matchstatistik.
 *
 * Källor, i tur och ordning (lib/statSources): ESPN för fotboll och NBA,
 * NHL:s officiella API för NHL — öppna API:er, ingen nyckel. Sofascore är
 * reserv för ligor de inte täcker (via Scrapling; --no-sofascore stänger av).
 *
 *   npm run props:grade                    # skriver förslag, rör inte databasen
 *   npm run props:grade -- --confirm       # rättar dem via settleBets (backup först)
 *   npm run props:grade -- --user jonatan --limit 50
 *   npm run props:grade -- --no-sofascore  # bara ESPN/NHL, ingen Python
 *
 * Resultatet hamnar i .claude/tmp/results-props-<datum>.json i samma format som
 * scripts/agent/settleBets.ts läser, så det går att granska — och ändra —
 * innan något skrivs. Allt som inte går att avgöra säkert (kort, kombinationer,
 * spelare som inte spelade, okända fält) listas med skäl och lämnas åt handen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { classifyPropBet, dataNeeded, gradeProp, type PropBet } from "../../lib/propsGrading";
import { sourceRegistry } from "../../lib/statSources";
import { JsonCache } from "../../lib/statSources/http";
import { SofascoreBlockedError, SofascoreBudgetError, SofascoreClient } from "../../lib/sofascore/client";

const OUT_DIR = path.join(".claude", "tmp");
/** Så länge efter avspark innan en match räknas som klar att rätta. */
const MIN_AGE_MS = 3 * 3_600_000;
const SPORTS = ["Football", "Basketball", "Ice Hockey"];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const username = argValue("--user")?.toLowerCase();
  const limit = Number(argValue("--limit")) || 200;

  const prisma = new PrismaClient();
  const http = new JsonCache();
  let sofa: SofascoreClient | null = null;
  let sofaOn = !process.argv.includes("--no-sofascore");
  const sourcesFor = sourceRegistry({
    http,
    sofascore: () => (sofa ??= new SofascoreClient()),
    sofascoreEnabled: () => sofaOn,
  });
  const results: { id: string; outcome: string; reason: string }[] = [];
  const skipped: { bet: PropBet; reason: string }[] = [];
  const bySource = new Map<string, number>();

  try {
    let userId: string | undefined;
    if (username) {
      const user = await prisma.user.findUnique({ where: { username } });
      if (!user) throw new Error(`användaren "${username}" finns inte`);
      userId = user.id;
    }
    const bets = await prisma.bet.findMany({
      where: {
        outcome: "pending",
        sport: { in: SPORTS },
        eventAt: { not: null, lt: new Date(Date.now() - MIN_AGE_MS) },
        ...(userId ? { userId } : {}),
      },
      orderBy: { eventAt: "asc" },
      take: limit,
    });
    console.log(`${bets.length} öppna bets i fotboll/basket/hockey med avspark för mer än 3 h sedan.\n`);

    for (const b of bets) {
      const bet: PropBet = b;
      const c = classifyPropBet(bet);
      if (!c.ok) {
        skipped.push({ bet, reason: c.reason });
        continue;
      }
      const needs = dataNeeded(c.need);
      const reasons: string[] = [];
      let done = false;
      // Källorna i tur och ordning; första som kan rätta vinner.
      for (const src of sourcesFor(c.need.sport, bet.league)) {
        try {
          const event = await src.findEvent(bet);
          if (!event) {
            reasons.push(`${src.name}: hittade ingen entydig match`);
            continue;
          }
          const data =
            event.status === "finished"
              ? await src.loadData(event, needs)
              : { source: src.name, event, stats: null, lineups: null };
          const g = gradeProp(bet, c.need, data);
          if (g.ok) {
            results.push({ id: bet.id, outcome: g.outcome, reason: g.reason });
            bySource.set(src.name, (bySource.get(src.name) ?? 0) + 1);
            console.log(`  ✓ ${g.outcome.padEnd(5)} ${bet.event} · ${bet.selection}\n           ${g.reason}`);
            done = true;
            break;
          }
          reasons.push(`${src.name}: ${g.reason}`);
          if (g.final) break; // gäller oavsett källa (ej spelad, spelaren inte med)
        } catch (err) {
          if (src.name === "Sofascore" && (err instanceof SofascoreBlockedError || err instanceof SofascoreBudgetError)) {
            // Reserven spärrad: hoppa över den resten av körningen, rätta resten med ESPN/NHL.
            sofaOn = false;
            console.log(`  (Sofascore stängs av för resten av körningen: ${err.message.split("\n")[0]})`);
          }
          reasons.push(`${src.name}: fel — ${err instanceof Error ? err.message.split("\n")[0] : err}`);
        }
      }
      if (!done) skipped.push({ bet, reason: reasons.join(" · ") || "ingen källa täcker ligan" });
    }
  } finally {
    await (sofa as SofascoreClient | null)?.close();
    await prisma.$disconnect();
  }

  if (skipped.length) {
    console.log(`\nLämnas åt handen (${skipped.length}):`);
    for (const s of skipped) console.log(`  – ${s.bet.event} · ${s.bet.selection}: ${s.reason}`);
  }
  const srcSummary = [...bySource].map(([k, n]) => `${k} ${n}`).join(", ") || "inga";
  const sofaCalls = sofa ? ` · Sofascore ${(sofa as SofascoreClient).fetched} anrop` : "";
  console.log(`\nRättade per källa: ${srcSummary}. ESPN/NHL: ${http.fetched} anrop, ${http.cacheHits} ur cachen${sofaCalls}.`);

  if (results.length === 0) {
    console.log("Inga bets att rätta.");
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `results-props-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\n${results.length} rättade förslag i ${file}`);

  if (!confirm) {
    console.log("Granska filen. Kör sedan med --confirm, eller: npx tsx scripts/agent/settleBets.ts --file " + file);
    return;
  }
  // settleBets tar backup, hoppar över bets som inte längre är pending och
  // skriver BetSettlement-raderna som all annan rättning.
  const res = spawnSync("npx", ["tsx", path.join("scripts", "agent", "settleBets.ts"), "--file", file], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exitCode = res.status ?? 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
