// CLI entry point for auto-grading + closing-line capture.
// Run manually:        npm run sync
// Schedule (Windows):  Task Scheduler -> see README.
//
// ESPN grading of finished singles (no API key). Loads .env.local for DATABASE_URL.

import { config } from "dotenv";
config({ path: ".env.local" });
config(); // also load .env for DATABASE_URL

import { runFullSync } from "../lib/sync";

async function main() {
  console.log(`[sync] ${new Date().toISOString()} starting…`);
  const result = await runFullSync();
  console.log(`[sync] ${result.message}`);
  for (const d of result.details) console.log(`  - ${d}`);
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("[sync] failed:", e);
    process.exit(1);
  })
  .then(() => process.exit(process.exitCode ?? 0));
