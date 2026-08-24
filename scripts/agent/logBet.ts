// Agent helper: log a bet from structured JSON (e.g. parsed from a betslip screenshot).
//
// Usage:
//   npx tsx scripts/agent/logBet.ts --file <bet.json> [--user <username>] [--dry-run]
//
// bet.json fields (see lib/betInput.ts BetInput) plus:
//   stakeKr   — stake in kronor; converted to units via the user's Setting.unitValue
//   importRef — betslip reference from the screenshot; duplicate refs are skipped
//   placedAt  — ISO timestamp when the bet was placed (defaults to now)
//
// Validation, market normalisation and marketCategory/marketScope inference are
// reused from lib/betInput.ts, so bets logged here look identical to app-created ones.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "fs";
import { assertDatabaseUrl, createPrismaClient, describeDbError } from "../../lib/prismaClient";
import { buildBetData, ValidationError, type BetInput } from "../../lib/betInput";
import { linkBetToOddsEvent } from "../../lib/eventLink";
import { tryLinkSingleFootballBet, isFootballBet } from "../../lib/clvCapture";
import { hasTheStatsApiKey, isStatsApiMatchRef } from "../../lib/theStatsApi";
import { maybeCaptureKickoffClvForBet } from "../../lib/clvOddsApi";
import { hasOddsApiKey } from "../../lib/oddsApi";

interface AgentBetInput extends BetInput {
  stakeKr?: number;
  importRef?: string | null;
  placedAt?: string | null;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const file = arg("--file");
  const username = (arg("--user") ?? "jonatan").toLowerCase();
  const dryRun = process.argv.includes("--dry-run");
  if (!file) {
    console.error("Usage: npx tsx scripts/agent/logBet.ts --file <bet.json> [--user <username>] [--dry-run]");
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(file, "utf8")) as AgentBetInput;
  assertDatabaseUrl();
  const prisma = createPrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) throw new Error(`user "${username}" not found — register the account first`);

    // Stake given in kronor -> units via the user's unit value.
    if (input.stakeUnits === undefined && input.stakeKr !== undefined) {
      const setting = await prisma.setting.findUnique({ where: { userId: user.id } });
      const unitValue = setting?.unitValue ?? 100;
      input.stakeUnits = input.stakeKr / unitValue;
    }

    if (input.importRef) {
      const existing = await prisma.bet.findFirst({
        where: { userId: user.id, importRef: input.importRef },
      });
      if (existing) {
        console.log(
          `SKIP: bet med importRef ${input.importRef} finns redan (${existing.id}: ${existing.event} — ${existing.selection})`
        );
        return;
      }
    }

    const data = buildBetData(input, { partial: false });
    if (input.importRef !== undefined) data.importRef = input.importRef;
    if (input.placedAt) data.placedAt = new Date(input.placedAt);

    if (dryRun) {
      console.log("DRY RUN — skulle skapa:");
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const bet = await prisma.bet.create({
      data: { ...(data as object), userId: user.id } as never,
    });
    if (!isStatsApiMatchRef(bet.externalRef)) {
      if (isFootballBet(bet) && hasTheStatsApiKey()) {
        await tryLinkSingleFootballBet(bet.id, prisma).catch(() => {});
      } else if (!bet.externalRef) {
        await linkBetToOddsEvent(prisma, bet).catch(() => {});
      }
    }
    if (hasOddsApiKey()) {
      const kickoff = await maybeCaptureKickoffClvForBet(bet.id, { prisma }).catch(() => null);
      if (kickoff && kickoff.closingUpdated > 0) {
        console.log(`  CLV: kickoff-capture (${kickoff.details.find((d) => d.includes("closing")) ?? "ok"})`);
      }
    }
    const linked = await prisma.bet.findUnique({ where: { id: bet.id } });
    const out = linked ?? bet;
    console.log(`OK: loggade bet ${out.id} för ${username}`);
    console.log(
      `  ${out.event} — ${out.selection} @ ${out.odds} | ${out.stakeUnits}u | ${out.bookmaker ?? "okänd bookmaker"}`
    );
    if (out.externalRef) {
      console.log(
        `  Länk: ${out.sportKey} / ${out.externalRef}${isStatsApiMatchRef(out.externalRef) ? " (TheStatsAPI/CLV)" : ""}`
      );
    } else if (isFootballBet(out)) {
      console.log("  CLV: ej länkad — sätt league (t.ex. Premier League) + home/away + eventAt");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  if (e instanceof ValidationError) console.error(`Valideringsfel: ${e.message}`);
  else console.error(describeDbError(e) ?? e);
  process.exit(1);
});
