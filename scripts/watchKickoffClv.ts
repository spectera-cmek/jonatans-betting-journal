/**
 * Long-running watcher: capture Odds API closing odds 10–30 min before kickoff.
 *
 *   npm run watch:kickoff-clv
 *
 * Sleeps until the next featured bet enters the pre-kickoff window, then captures.
 * Prefer installing the Windows Task Scheduler job for set-and-forget:
 *   npm run install:kickoff-clv-task
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { hasOddsApiKey } from "../lib/oddsApi";
import {
  captureClosingNearKickoff,
  nextFeaturedKickoffNeedingClv,
} from "../lib/clvOddsApi";

const prisma = new PrismaClient();

const BEFORE_MIN = 30;
const AFTER_MIN = 5;
const MIN_SLEEP_MS = 60_000; // 1 min
const MAX_SLEEP_MS = 10 * 60_000; // 10 min — never sleep longer so we don't miss windows
const IDLE_SLEEP_MS = 10 * 60_000; // no upcoming bets

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function tick(dryRun: boolean): Promise<void> {
  const result = await captureClosingNearKickoff({
    prisma,
    dryRun,
    beforeMinutes: BEFORE_MIN,
    afterMinutes: AFTER_MIN,
    limit: 40,
  });

  const stamp = new Date().toISOString().slice(11, 19);
  if (result.closingUpdated > 0 || result.linked > 0 || result.failed > 0) {
    console.log(
      `[${stamp}] kickoff-clv: linked ${result.linked}, closing ${result.closingUpdated}, fail ${result.failed}`
    );
    for (const d of result.details.slice(0, 12)) console.log(`  ${d}`);
  } else {
    console.log(`[${stamp}] kickoff-clv: idle (${result.details[0] ?? "ok"})`);
  }
}

async function sleepUntilNext(): Promise<void> {
  const windowOpensAt = await nextFeaturedKickoffNeedingClv({
    prisma,
    beforeMinutes: BEFORE_MIN,
  });

  if (!windowOpensAt) {
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] no upcoming featured kickoffs — sleep ${IDLE_SLEEP_MS / 60000}m`
    );
    await sleep(IDLE_SLEEP_MS);
    return;
  }

  const ms = windowOpensAt.getTime() - Date.now();
  if (ms <= 0) {
    // Already in window — short poll
    await sleep(MIN_SLEEP_MS);
    return;
  }

  const wait = Math.min(Math.max(ms, MIN_SLEEP_MS), MAX_SLEEP_MS);
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] next window ${windowOpensAt.toISOString().slice(0, 16)} — sleep ${(wait / 60000).toFixed(1)}m`
  );
  await sleep(wait);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const once = process.argv.includes("--once");
  const pollRaw = argValue("--poll-minutes");
  const pollMinutes = pollRaw ? Number(pollRaw) : NaN;
  const fixedPoll =
    Number.isFinite(pollMinutes) && pollMinutes > 0
      ? pollMinutes * 60_000
      : null;

  if (!hasOddsApiKey()) {
    console.error("ODDS_API_KEY is not set in .env.local");
    process.exit(1);
  }

  console.log(
    `Watching kickoff CLV window: T-${BEFORE_MIN} … T+${AFTER_MIN} min` +
      (dryRun ? " [dry-run]" : "") +
      (fixedPoll ? ` (fixed poll every ${pollMinutes}m)` : " (smart sleep)")
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick(dryRun);
    } catch (e) {
      console.error("[kickoff-clv] tick failed:", e);
    }

    if (once) break;

    if (fixedPoll) {
      await sleep(fixedPoll);
    } else {
      await sleepUntilNext();
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
