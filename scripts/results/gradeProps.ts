/**
 * Rättar props och statistikmarknader (spelarskott, poäng, returer, hörnor,
 * lagskott, BTTS …) i fotboll, basket och hockey ur Sofascores matchdata.
 * Hämtas via Scrapling (npm run scrapling:setup en gång).
 *
 *   npm run props:grade                    # skriver förslag, rör inte databasen
 *   npm run props:grade -- --confirm       # rättar dem via settleBets (backup först)
 *   npm run props:grade -- --user jonatan --limit 50
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
import {
  classifyPropBet,
  dataNeeded,
  findEventForBet,
  gradeProp,
  type MatchData,
  type PropBet,
} from "../../lib/propsGrading";
import { sofaPaths, utcDate, type SofaSport } from "../../lib/sofascore/api";
import {
  SOFA_MAX_AGE,
  SofascoreBlockedError,
  SofascoreBudgetError,
  SofascoreClient,
} from "../../lib/sofascore/client";
import { parseEvents, parseLineups, parseStatistics, type SofaEvent } from "../../lib/sofascore/parse";

const OUT_DIR = path.join(".claude", "tmp");
/** Så länge efter avspark innan en match räknas som klar att rätta. */
const MIN_AGE_MS = 3 * 3_600_000;
const SPORTS = ["Football", "Basketball", "Ice Hockey"];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Dagslistor per sport och datum, så samma dag bara hämtas en gång. */
class EventIndex {
  private readonly days = new Map<string, SofaEvent[]>();
  constructor(private readonly client: SofascoreClient) {}

  async around(sport: SofaSport, at: Date): Promise<SofaEvent[]> {
    const out: SofaEvent[] = [];
    for (const shift of [-1, 0, 1]) {
      const date = utcDate(new Date(at.getTime() + shift * 86_400_000));
      const key = `${sport}/${date}`;
      if (!this.days.has(key)) {
        // En dag som ligger helt bakåt i tiden ändras inte längre.
        const old = Date.now() - new Date(`${date}T00:00:00Z`).getTime() > 3 * 86_400_000;
        const json = await this.client.get(sofaPaths.scheduledEvents(sport, date), old ? SOFA_MAX_AGE.finished : SOFA_MAX_AGE.schedule);
        this.days.set(key, parseEvents(json).events);
      }
      out.push(...this.days.get(key)!);
    }
    return out;
  }
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const username = argValue("--user")?.toLowerCase();
  const limit = Number(argValue("--limit")) || 200;

  const prisma = new PrismaClient();
  const client = new SofascoreClient();
  const index = new EventIndex(client);
  const results: { id: string; outcome: string; reason: string }[] = [];
  const skipped: { bet: PropBet; reason: string }[] = [];

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
      try {
        const event = findEventForBet(bet, await index.around(c.need.sport, bet.eventAt!));
        if (!event) {
          skipped.push({ bet, reason: "hittade ingen entydig match hos Sofascore" });
          continue;
        }
        const needs = dataNeeded(c.need);
        const finished = event.status === "finished";
        const data: MatchData = {
          event,
          stats: finished && needs.stats ? parseStatistics((await client.get(sofaPaths.statistics(event.id), SOFA_MAX_AGE.finished)) ?? {}) : null,
          lineups: finished && needs.lineups ? parseLineups((await client.get(sofaPaths.lineups(event.id), SOFA_MAX_AGE.finished)) ?? {}) : null,
        };
        const g = gradeProp(bet, c.need, data);
        if (g.ok) {
          results.push({ id: bet.id, outcome: g.outcome, reason: g.reason });
          console.log(`  ✓ ${g.outcome.padEnd(5)} ${bet.event} · ${bet.selection}\n           ${g.reason}`);
        } else {
          skipped.push({ bet, reason: g.reason });
        }
      } catch (err) {
        if (err instanceof SofascoreBlockedError || err instanceof SofascoreBudgetError) throw err;
        skipped.push({ bet, reason: `fel: ${err instanceof Error ? err.message : err}` });
      }
    }
  } finally {
    await client.close();
    await prisma.$disconnect();
  }

  if (skipped.length) {
    console.log(`\nLämnas åt handen (${skipped.length}):`);
    for (const s of skipped) console.log(`  – ${s.bet.event} · ${s.bet.selection}: ${s.reason}`);
  }
  console.log(`\nSofascore: ${client.fetched} anrop, ${client.cacheHits} ur cachen.`);

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
