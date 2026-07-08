// Agent helper: list all open (pending) bets as JSON — input for the morning settle routine.
//
// Usage:
//   npx tsx scripts/agent/openBets.ts [--user <username>]
//
// Without --user it lists open bets for ALL users (settling is global, like /api/sync).
// JSON goes to stdout; the count goes to stderr so stdout stays machine-parseable.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";

async function main() {
  const i = process.argv.indexOf("--user");
  const username = i >= 0 ? (process.argv[i + 1] ?? "").toLowerCase() : null;

  const prisma = new PrismaClient();
  try {
    const where: { outcome: string; userId?: string } = { outcome: "pending" };
    if (username) {
      const user = await prisma.user.findUnique({ where: { username } });
      if (!user) throw new Error(`user "${username}" not found`);
      where.userId = user.id;
    }

    const bets = await prisma.bet.findMany({
      where,
      orderBy: { eventAt: "asc" },
      include: { user: { select: { username: true } } },
    });

    const out = bets.map((b) => {
      let legs: unknown = null;
      if (b.legs) {
        try {
          legs = JSON.parse(b.legs);
        } catch {
          legs = b.legs;
        }
      }
      return {
        id: b.id,
        user: b.user.username,
        eventAt: b.eventAt,
        sport: b.sport,
        league: b.league,
        event: b.event,
        homeTeam: b.homeTeam,
        awayTeam: b.awayTeam,
        market: b.market,
        marketCategory: b.marketCategory,
        marketScope: b.marketScope,
        selection: b.selection,
        selectionSide: b.selectionSide,
        line: b.line,
        betType: b.betType,
        legs,
        odds: b.odds,
        stakeUnits: b.stakeUnits,
        bookmaker: b.bookmaker,
        notes: b.notes,
      };
    });

    console.log(JSON.stringify(out, null, 2));
    console.error(`${out.length} öppna bets.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
