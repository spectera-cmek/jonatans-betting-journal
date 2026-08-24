// Agent helper: settle open bets from a researched results file.
// Generalises the one-off settle-YYYY-MM-DD scripts: backs up affected rows first,
// then updates outcome + profitUnits + gradedAt and appends the reason to notes.
//
// Usage:
//   npx tsx scripts/agent/settleBets.ts --file <results.json> [--dry-run]
//
// results.json:
//   [{ "id": "<betId>", "outcome": "win|loss|push|void|half_win|half_loss",
//      "reason": "final result + source, e.g. 'CIN 4-2 PHI; Bleday 2 baser (MLB.com box score)'" }]
//
// Profit convention matches the app (lib/betting.ts): win => stake*(odds-1),
// loss => -stake, push/void => 0, half_win/half_loss => half of the above.
// Non-pending bets are skipped, never overwritten.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { assertDatabaseUrl, createPrismaClient, describeDbError } from "../../lib/prismaClient";
import { settleBet } from "../../lib/settlement";
import { profitUnits, type Outcome } from "../../lib/betting";

const SETTLE_OUTCOMES = new Set(["win", "loss", "push", "void", "half_win", "half_loss"]);
const BACKUP_DIR = ".claude/backups";

interface ResultEntry {
  id: string;
  outcome: string;
  reason: string;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const file = arg("--file");
  const dryRun = process.argv.includes("--dry-run");
  if (!file) {
    console.error("Usage: npx tsx scripts/agent/settleBets.ts --file <results.json> [--dry-run]");
    process.exit(1);
  }

  const results = JSON.parse(readFileSync(file, "utf8")) as ResultEntry[];
  if (!Array.isArray(results) || results.length === 0) {
    console.error("results.json must be a non-empty array of { id, outcome, reason }");
    process.exit(1);
  }
  for (const r of results) {
    if (!r.id || !SETTLE_OUTCOMES.has(r.outcome) || !r.reason) {
      console.error(`Invalid entry: ${JSON.stringify(r)}`);
      process.exit(1);
    }
  }

  assertDatabaseUrl();
  const prisma = createPrismaClient();
  try {
    const ids = results.map((r) => r.id);
    const before = await prisma.bet.findMany({ where: { id: { in: ids } } });

    if (!dryRun) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${BACKUP_DIR}/settle-before-${stamp}.json`;
      writeFileSync(backupPath, JSON.stringify(before, null, 2));
      console.log(`Backup: ${backupPath} (${before.length} rows)\n`);
    }

    const byId = new Map(before.map((b) => [b.id, b]));
    let netProfit = 0;
    let settled = 0;

    for (const r of results) {
      const bet = byId.get(r.id);
      if (!bet) {
        console.log(`!! MISSING ${r.id}`);
        continue;
      }
      if (bet.outcome !== "pending") {
        console.log(`~~ SKIP ${r.id} already ${bet.outcome}`);
        continue;
      }

      let p = +profitUnits(r.outcome as Outcome, bet.odds, bet.stakeUnits).toFixed(4);
      if (!dryRun) {
        const result = await settleBet(prisma, {
          betId: r.id,
          outcome: r.outcome as Outcome,
          source: "agent",
          reason: r.reason,
        });
        p = result.bet.profitUnits ?? 0;
      }
      netProfit += p;
      settled += 1;
      console.log(
        `${r.outcome.toUpperCase().padEnd(9)} ${p >= 0 ? "+" : ""}${p}u  ${bet.event} — ${bet.selection}`
      );
    }

    if (!dryRun && settled > 0) {
      await prisma.syncLog.create({
        data: { kind: "grade", summary: `Agent settled ${settled} bet(s), net ${netProfit.toFixed(3)}u.` },
      });
    }

    console.log(
      `\n${dryRun ? "DRY RUN — inget sparat. " : ""}Net: ${netProfit >= 0 ? "+" : ""}${netProfit.toFixed(3)}u över ${settled} rättade bets (${results.length} i filen).`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(describeDbError(e) ?? e);
  process.exit(1);
});
