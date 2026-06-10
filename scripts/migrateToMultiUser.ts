// One-off migration: single-user → multi-user. Creates (or finds) the owner's
// account and claims every row that doesn't belong to anyone yet.
//
// Usage:
//   MIGRATE_PASSWORD=... npm run db:migrate-users -- --user jonatan
//   (PowerShell:  $env:MIGRATE_PASSWORD = "..."; npm run db:migrate-users -- --user jonatan)
//
// The password comes from the MIGRATE_PASSWORD env var, never argv, so it
// doesn't end up in shell history. Idempotent: re-running claims any bets the
// old single-user deployment created after the previous run, and never touches
// rows that already have a userId.
//
// Run order (see plan): phase-A schema push (optional userId) must be live
// before this runs; the NOT NULL push (phase D) only after this reports 0
// unclaimed rows.

import { config } from "dotenv";
config({ path: ".env.local" });
config(); // also load .env for DATABASE_URL

import { PrismaClient } from "@prisma/client";
import { hashPassword, validatePassword, validateUsername } from "../lib/password";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const username = args.includes("--user")
    ? (args[args.indexOf("--user") + 1] || "").trim().toLowerCase()
    : "";
  if (!username) {
    console.error("Usage: npm run db:migrate-users -- --user <username>   (password via MIGRATE_PASSWORD env)");
    process.exit(1);
  }
  const usernameErr = validateUsername(username);
  if (usernameErr) {
    console.error(usernameErr);
    process.exit(1);
  }

  // Existing user → keep their password; new user → MIGRATE_PASSWORD required.
  let user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    const password = process.env.MIGRATE_PASSWORD || "";
    const passwordErr = validatePassword(password);
    if (passwordErr) {
      console.error(`MIGRATE_PASSWORD: ${passwordErr}`);
      process.exit(1);
    }
    user = await prisma.user.create({
      data: { username, passwordHash: await hashPassword(password) },
    });
    console.log(`Created user "${username}" (${user.id}).`);
  } else {
    console.log(`User "${username}" already exists (${user.id}) — reusing.`);
  }

  // Claim all ownerless bets (pre-multi-user rows + anything the old deployment
  // wrote in the window before the new code went live).
  const bets = await prisma.bet.updateMany({
    where: { userId: null },
    data: { userId: user.id },
  });
  console.log(`Claimed ${bets.count} ownerless bets.`);

  // Attach the legacy singleton Setting row (preserves unitValue/currency/bankroll).
  const settings = await prisma.setting.updateMany({
    where: { userId: null },
    data: { userId: user.id },
  });
  if (settings.count > 0) {
    console.log(`Attached ${settings.count} legacy settings row(s).`);
  } else {
    await prisma.setting.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });
    console.log("No legacy settings row — ensured defaults exist.");
  }

  // The legacy row was created with a hardcoded id=1, so the (new) autoincrement
  // sequence still starts at 1. Bump it past MAX(id) or the next insert hits P2002.
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"Setting"', 'id'), (SELECT COALESCE(MAX(id), 1) FROM "Setting"))`
  );

  // Verify: phase D (NOT NULL push) is only safe when both counts are 0.
  const orphanBets = await prisma.bet.count({ where: { userId: null } });
  const orphanSettings = await prisma.setting.count({ where: { userId: null } });
  const totalBets = await prisma.bet.count({ where: { userId: user.id } });
  console.log(`\nVerification: ${totalBets} bets on "${username}"; unclaimed: ${orphanBets} bets, ${orphanSettings} settings.`);
  if (orphanBets > 0 || orphanSettings > 0) {
    console.error("Unclaimed rows remain — do NOT run the NOT NULL schema push yet.");
    process.exitCode = 1;
  } else {
    console.log("All rows claimed — safe to push the required-userId schema (phase D).");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
