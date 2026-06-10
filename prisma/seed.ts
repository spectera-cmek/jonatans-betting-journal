// Seeds a "demo" account (password: SEED_PASSWORD env, default "demo1234"),
// its settings row and a handful of demo bets so the dashboard isn't empty on
// first run. Safe to re-run: it upserts the user + settings and only adds demo
// bets if the account has none.

import { PrismaClient } from "@prisma/client";
import { profitUnits, type Outcome } from "../lib/betting";
import { hashPassword } from "../lib/password";

const DEMO_USERNAME = "demo";

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(20, 0, 0, 0);
  return d;
}

interface DemoBet {
  eventAt: Date;
  sport: string;
  sportKey: string;
  league: string;
  event: string;
  homeTeam: string;
  awayTeam: string;
  market: string;
  selection: string;
  selectionSide: string;
  line?: number;
  odds: number;
  closingOdds?: number;
  stakeUnits: number;
  outcome: Outcome;
  bookmaker: string;
}

const demo: DemoBet[] = [
  { eventAt: daysAgo(20), sport: "Football", sportKey: "soccer_epl", league: "Premier League", event: "Arsenal vs Chelsea", homeTeam: "Arsenal", awayTeam: "Chelsea", market: "h2h", selection: "Arsenal", selectionSide: "home", odds: 2.1, closingOdds: 1.95, stakeUnits: 1, outcome: "win", bookmaker: "Pinnacle" },
  { eventAt: daysAgo(18), sport: "Football", sportKey: "soccer_epl", league: "Premier League", event: "Liverpool vs Man City", homeTeam: "Liverpool", awayTeam: "Man City", market: "totals", selection: "Over 2.5", selectionSide: "over", line: 2.5, odds: 1.85, closingOdds: 1.9, stakeUnits: 2, outcome: "loss", bookmaker: "Bet365" },
  { eventAt: daysAgo(15), sport: "Tennis", sportKey: "tennis_atp", league: "ATP", event: "Alcaraz vs Sinner", homeTeam: "Alcaraz", awayTeam: "Sinner", market: "h2h", selection: "Sinner", selectionSide: "away", odds: 2.4, closingOdds: 2.5, stakeUnits: 1.5, outcome: "win", bookmaker: "Unibet" },
  { eventAt: daysAgo(12), sport: "Basketball", sportKey: "basketball_nba", league: "NBA", event: "Lakers vs Celtics", homeTeam: "Lakers", awayTeam: "Celtics", market: "spreads", selection: "Lakers -3.5", selectionSide: "home", line: -3.5, odds: 1.91, closingOdds: 1.87, stakeUnits: 1, outcome: "loss", bookmaker: "Pinnacle" },
  { eventAt: daysAgo(10), sport: "Football", sportKey: "soccer_spain_la_liga", league: "La Liga", event: "Real Madrid vs Barcelona", homeTeam: "Real Madrid", awayTeam: "Barcelona", market: "h2h", selection: "Draw", selectionSide: "draw", odds: 3.6, closingOdds: 3.4, stakeUnits: 1, outcome: "win", bookmaker: "Betsson" },
  { eventAt: daysAgo(8), sport: "Ice Hockey", sportKey: "icehockey_nhl", league: "NHL", event: "Rangers vs Bruins", homeTeam: "Rangers", awayTeam: "Bruins", market: "totals", selection: "Under 5.5", selectionSide: "under", line: 5.5, odds: 1.95, closingOdds: 2.0, stakeUnits: 1, outcome: "win", bookmaker: "Bet365" },
  { eventAt: daysAgo(6), sport: "Football", sportKey: "soccer_epl", league: "Premier League", event: "Man Utd vs Tottenham", homeTeam: "Man Utd", awayTeam: "Tottenham", market: "h2h", selection: "Man Utd", selectionSide: "home", odds: 2.6, closingOdds: 2.75, stakeUnits: 1, outcome: "loss", bookmaker: "LeoVegas" },
  { eventAt: daysAgo(4), sport: "Tennis", sportKey: "tennis_wta", league: "WTA", event: "Swiatek vs Gauff", homeTeam: "Swiatek", awayTeam: "Gauff", market: "h2h", selection: "Swiatek", selectionSide: "home", odds: 1.7, closingOdds: 1.6, stakeUnits: 2, outcome: "win", bookmaker: "Unibet" },
  { eventAt: daysAgo(2), sport: "Basketball", sportKey: "basketball_nba", league: "NBA", event: "Warriors vs Suns", homeTeam: "Warriors", awayTeam: "Suns", market: "totals", selection: "Over 224.5", selectionSide: "over", line: 224.5, odds: 1.9, closingOdds: 1.88, stakeUnits: 1.5, outcome: "win", bookmaker: "Pinnacle" },
  { eventAt: daysAgo(1), sport: "Football", sportKey: "soccer_italy_serie_a", league: "Serie A", event: "Juventus vs Inter", homeTeam: "Juventus", awayTeam: "Inter", market: "h2h", selection: "Inter", selectionSide: "away", odds: 2.2, stakeUnits: 1, outcome: "pending", bookmaker: "Betsson" },
  { eventAt: daysAgo(0), sport: "Football", sportKey: "soccer_germany_bundesliga", league: "Bundesliga", event: "Bayern vs Dortmund", homeTeam: "Bayern", awayTeam: "Dortmund", market: "h2h", selection: "Bayern", selectionSide: "home", odds: 1.65, stakeUnits: 2, outcome: "pending", bookmaker: "Bet365" },
];

async function main() {
  const passwordHash = await hashPassword(process.env.SEED_PASSWORD || "demo1234");
  const user = await prisma.user.upsert({
    where: { username: DEMO_USERNAME },
    update: {},
    create: { username: DEMO_USERNAME, passwordHash },
  });

  await prisma.setting.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, unitValue: 100, currency: "kr", startingBankrollUnits: 100 },
  });

  const count = await prisma.bet.count({ where: { userId: user.id } });
  if (count === 0) {
    for (const b of demo) {
      const p =
        b.outcome === "pending"
          ? null
          : profitUnits(b.outcome, b.odds, b.stakeUnits);
      await prisma.bet.create({
        data: {
          userId: user.id,
          eventAt: b.eventAt,
          placedAt: b.eventAt,
          sport: b.sport,
          sportKey: b.sportKey,
          league: b.league,
          event: b.event,
          homeTeam: b.homeTeam,
          awayTeam: b.awayTeam,
          market: b.market,
          selection: b.selection,
          selectionSide: b.selectionSide,
          line: b.line ?? null,
          odds: b.odds,
          closingOdds: b.closingOdds ?? null,
          stakeUnits: b.stakeUnits,
          outcome: b.outcome,
          profitUnits: p,
          bookmaker: b.bookmaker,
          gradedAt: b.outcome === "pending" ? null : b.eventAt,
        },
      });
    }
    console.log(`Seeded ${demo.length} demo bets for "${DEMO_USERNAME}".`);
  } else {
    console.log(`"${DEMO_USERNAME}" already has ${count} bets — skipping demo seed.`);
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
