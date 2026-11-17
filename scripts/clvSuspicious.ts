/**
 * Closing-odds som ger en misstänkt stor CLV (±25 % eller mer). Det är nästan
 * alltid fel marknad — ett live-spel utan läggningstid, en boost som inte är
 * markerad, eller en annan marknad loggad som matchvinnare — inte ett slaget pris.
 *
 *   npm run clv:suspicious                          # lista
 *   npm run clv:suspicious -- --since 2026-01-01    # bara bets från datumet
 *   npm run clv:suspicious -- --clear               # ta bort closing-oddsen på dem
 *
 * --clear rör bara closingOdds. Betten, odds och resultat ändras inte.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { clvPct } from "../lib/betting";
import { isSuspicious, SUSPICIOUS_CLV_PCT } from "../lib/clvOddsPortalBatch";

const prisma = new PrismaClient();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const clear = process.argv.includes("--clear");
  const sinceRaw = argValue("--since");
  const since = sinceRaw ? new Date(sinceRaw) : undefined;

  const bets = await prisma.bet.findMany({
    where: {
      closingOdds: { not: null },
      boosted: false,
      ...(since ? { OR: [{ eventAt: { gte: since } }, { eventAt: null, placedAt: { gte: since } }] } : {}),
    },
    select: { id: true, event: true, selection: true, market: true, marketCategory: true, odds: true, closingOdds: true, eventAt: true, placedAt: true },
    orderBy: [{ eventAt: "asc" }, { placedAt: "asc" }],
  });
  const hits = bets.filter((b) => b.closingOdds != null && isSuspicious(b.odds, b.closingOdds));

  console.log(`${hits.length} av ${bets.length} bets med closing-odds har CLV på ±${SUSPICIOUS_CLV_PCT} % eller mer:\n`);
  for (const b of hits) {
    const pct = clvPct(b.odds, b.closingOdds!)!;
    const when = (b.eventAt ?? b.placedAt).toISOString().slice(0, 10);
    console.log(
      `  ${when}  ${b.event} · ${b.selection} (${b.marketCategory || b.market}) — du ${b.odds.toFixed(2)}, closing ${b.closingOdds!.toFixed(2)}, CLV ${pct >= 0 ? "+" : ""}${pct.toFixed(1)} %`
    );
  }
  if (hits.length === 0) return;

  if (!clear) {
    console.log("\nInget ändrat. Är de fel: kör med --clear för att ta bort closing-oddsen på just dessa.");
    console.log("Var något en boost: markera betet som boostat i appen i stället.");
    return;
  }
  const res = await prisma.bet.updateMany({ where: { id: { in: hits.map((b) => b.id) } }, data: { closingOdds: null } });
  console.log(`\nTog bort closing-odds på ${res.count} bets.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message.split("\n").filter(Boolean).slice(-1)[0] : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
