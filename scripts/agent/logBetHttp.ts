// Agent helper: log one or more bets from structured JSON, over Neon's HTTP
// endpoint instead of Prisma's TCP connection.
//
// Why HTTP: Claude Code cloud sessions can't open port 5432 to Neon (the
// network policy only allows HTTPS), so `scripts/agent/logBet.ts` (Prisma) can't
// connect there. This script talks to the same database over https via
// @neondatabase/serverless, so betslip logging works from a cloud session too.
// Locally it works just as well — DATABASE_URL points at Neon either way.
//
// Usage:
//   # one or more JSON files:
//   npx tsx scripts/agent/logBetHttp.ts bet1.json bet2.json [--user jonatan] [--dry]
//   # or a JSON object / array of objects on stdin (one command, many bets):
//   npx tsx scripts/agent/logBetHttp.ts --stdin <<'JSON'
//   [ { ...bet... }, { ...bet... } ]
//   JSON
//
// Each bet object uses the BetInput fields (lib/betInput.ts) plus:
//   stakeKr    stake in kronor; divided by the user's Setting.unitValue -> units
//   importRef  betslip reference; a matching ref for this user is skipped as a dupe
//   placedAt   ISO timestamp the bet was placed (defaults to now)
// Validation, market normalisation and category/scope inference are reused from
// buildBetData, so these rows look identical to app-created ones.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";
import { buildBetData, type BetInput } from "../../lib/betInput";

interface AgentBet extends BetInput {
  stakeKr?: number;
  importRef?: string | null;
  placedAt?: string | null;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

// A cuid-shaped id (c + time + counter + random blocks), because @default(cuid())
// is applied by the Prisma client we're bypassing, not by the database.
let counter = Math.floor(Math.random() * 1_000_000);
const tail = (s: string, n: number) => s.slice(-n).padStart(n, "0");
const block = () => tail(Math.floor(Math.random() * 36 ** 4).toString(36), 4);
const cuid = () =>
  "c" + tail(Date.now().toString(36), 8) + tail((counter++).toString(36), 4) + block() + block() + block();

function readInputs(): AgentBet[] {
  const files = process.argv.slice(2).filter((a) => a.endsWith(".json"));
  if (files.length) return files.map((f) => JSON.parse(readFileSync(f, "utf8")) as AgentBet);
  if (process.argv.includes("--stdin")) {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) throw new Error("--stdin angavs men ingen JSON kom in");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  throw new Error("Ange en eller flera .json-filer, eller --stdin med JSON på stdin.");
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL saknas i miljön (.env.local eller export).");
  if (dbUrl.includes("…")) throw new Error("DATABASE_URL är en maskerad platshållare — sätt den riktiga strängen.");

  const username = (arg("--user") ?? "jonatan").toLowerCase();
  const dry = process.argv.includes("--dry");
  const bets = readInputs();

  const sql = neon(dbUrl);
  const users = (await sql.query(`SELECT id FROM "User" WHERE username = $1`, [username])) as { id: string }[];
  const userId = users[0]?.id;
  if (!userId) throw new Error(`användaren "${username}" hittades inte`);
  const settings = (await sql.query(`SELECT "unitValue" FROM "Setting" WHERE "userId" = $1`, [userId])) as {
    unitValue: number;
  }[];
  const unitValue = settings[0]?.unitValue ?? 100;

  for (const input of bets) {
    const { stakeKr, importRef, placedAt, ...rest } = input;
    const label = rest.event ?? "(utan event)";

    // Dupe check: on the receipt reference when present, else on
    // event + selection + odds within a 2-day window around placement.
    const dupes = (importRef
      ? await sql.query(`SELECT id, event, selection FROM "Bet" WHERE "userId" = $1 AND "importRef" = $2`, [
          userId,
          importRef,
        ])
      : await sql.query(
          `SELECT id, event, selection FROM "Bet"
           WHERE "userId" = $1 AND event = $2 AND selection = $3 AND odds = $4
             AND "placedAt" > $5::timestamptz - interval '2 days'`,
          [userId, rest.event, rest.selection, rest.odds, placedAt ?? new Date().toISOString()]
        )) as { id: string; event: string; selection: string }[];
    if (dupes.length) {
      console.log(`SKIP: "${label}" finns redan (${dupes[0].id}: ${dupes[0].event} — ${dupes[0].selection})`);
      continue;
    }

    // kr -> units, rounded to kill float noise (134.01/100 -> 1.3401, not 1.34009999…).
    const stakeUnits =
      stakeKr != null && unitValue > 0 ? Math.round((stakeKr / unitValue) * 1e4) / 1e4 : rest.stakeUnits;
    const data = buildBetData({ ...rest, stakeUnits }, { partial: false }) as Record<string, unknown>;
    const row: Record<string, unknown> = {
      ...data,
      id: cuid(),
      userId,
      importRef: importRef ?? null,
      placedAt: placedAt ? new Date(placedAt) : new Date(),
      updatedAt: new Date(), // @updatedAt is set by Prisma, not by the database
    };
    for (const [k, v] of Object.entries(row)) if (v instanceof Date) row[k] = (v as Date).toISOString();

    if (dry) {
      console.log(`DRY: skulle skapa "${label}"\n${JSON.stringify(row, null, 2)}`);
      continue;
    }

    const cols = Object.keys(row);
    const insert = `INSERT INTO "Bet" (${cols.map((c) => `"${c}"`).join(", ")})
      VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
      RETURNING id, event, selection, odds, "stakeUnits", bookmaker, league, "eventAt", outcome`;
    const [bet] = (await sql.query(insert, Object.values(row))) as {
      id: string;
      event: string;
      selection: string;
      odds: number;
      stakeUnits: number;
      bookmaker: string | null;
      league: string | null;
      eventAt: string | null;
      outcome: string;
    }[];
    console.log(
      `OK ${bet.id}\n   ${bet.event} — ${bet.selection} @ ${bet.odds} | ${bet.stakeUnits}u | ${
        bet.bookmaker ?? "okänd bookmaker"
      } | ${bet.league ?? "—"} | ${bet.outcome}`
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
