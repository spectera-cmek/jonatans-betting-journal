/**
 * Backfill ESPN resultEventRef on VM bets that can be linked to exactly one fixture.
 *
 *   npx tsx scripts/backfillWorldCupRefs.ts            # dry-run
 *   npx tsx scripts/backfillWorldCupRefs.ts --confirm  # write
 */
import { PrismaClient } from "@prisma/client";
import { VM_2026_LEAGUE } from "../lib/betTaxonomy";
import { fetchWorldCupData, findWorldCupMatchesForBet } from "../lib/worldCup";

const prisma = new PrismaClient();
const confirm = process.argv.includes("--confirm");

async function main() {
  const data = await fetchWorldCupData();
  const bets = await prisma.bet.findMany({
    where: {
      league: VM_2026_LEAGUE,
      OR: [{ resultEventRef: null }, { resultProvider: null }],
    },
    select: {
      id: true,
      event: true,
      selection: true,
      homeTeam: true,
      awayTeam: true,
      eventAt: true,
      eventKind: true,
      resultProvider: true,
      resultEventRef: true,
    },
  });

  let updated = 0;
  for (const bet of bets) {
    const matches = findWorldCupMatchesForBet(bet, data.matches);
    if (matches.length !== 1) continue;
    const match = matches[0];
    console.log(`${bet.id}  ${bet.event.slice(0, 50)}  →  ${match.home.name} vs ${match.away.name}`);
    if (confirm) {
      await prisma.bet.update({
        where: { id: bet.id },
        data: {
          resultProvider: "espn",
          resultEventRef: match.id,
          tournamentStage: bet.eventKind === "outright" ? undefined : match.stage ?? undefined,
        },
      });
    }
    updated += 1;
  }

  console.log(
    confirm
      ? `Updated ${updated} VM bets with ESPN resultEventRef.`
      : `${updated} VM bets would get ESPN resultEventRef. Run with --confirm to apply.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
