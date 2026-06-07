import { NextResponse } from "next/server";
import { prisma, getSettings } from "@/lib/db";
import {
  computeMetrics,
  bankrollSeries,
  breakdownBy,
  topBetsByProfit,
  singleRoiPct,
  settledProfit,
  type BetLike,
} from "@/lib/betting";
import type { Outcome } from "@/lib/betting";
import { computeInsights } from "@/lib/insights";

export const dynamic = "force-dynamic";

// GET /api/metrics — everything the dashboard & analytics need.
export async function GET() {
  const [bets, settings] = await Promise.all([
    prisma.bet.findMany(),
    getSettings(),
  ]);

  const betLikes: BetLike[] = bets.map((b) => ({
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    closingOdds: b.closingOdds,
    eventAt: b.eventAt,
    placedAt: b.placedAt,
    createdAt: b.createdAt,
    profitUnits: b.profitUnits,
  }));

  const metrics = computeMetrics(betLikes);
  const bankroll = bankrollSeries(betLikes, settings.startingBankrollUnits);

  const bySport = breakdownBy(betLikes, (_b) => null).length
    ? breakdownBy(
        bets.map(toKeyed),
        (b) => (b as KeyedBet).sport,
        "Unknown"
      )
    : [];
  const keyed = bets.map(toKeyed);
  const byLeague = breakdownBy(keyed, (b) => (b as KeyedBet).league, "Unknown");
  const byMarket = breakdownBy(keyed, (b) => (b as KeyedBet).market, "Övrigt");
  const byBookmaker = breakdownBy(keyed, (b) => (b as KeyedBet).bookmaker, "Unknown");

  // Per year (chronological) and per bet type.
  const byYear = breakdownBy(keyed, (b) => yearOf(b.eventAt ?? b.placedAt)).sort((a, b) =>
    a.key.localeCompare(b.key)
  );
  const byBetType = breakdownBy(keyed, (b) =>
    (b as KeyedBet).betType === "accumulator" ? "Ackumulator" : "Singel"
  );

  // Monthly: all months (ascending) + last 12 for the overview chart.
  const byMonth = monthlyAll(bets);
  const monthly = byMonth.slice(-12);

  // Odds-band breakdown.
  const oddsBands = oddsBandBreakdown(betLikes);

  // Individual-bet leaderboards: biggest wins & biggest losses.
  const hallOfFame = leaderboard(bets, "win");
  const biggestL = leaderboard(bets, "loss");

  // Personal "form" insights (streaks, best/worst day, month-over-month…).
  const insights = computeInsights(betLikes);

  return NextResponse.json({
    metrics,
    insights,
    bankroll,
    bySport,
    byLeague,
    byMarket,
    byBookmaker,
    byYear,
    byBetType,
    byMonth,
    monthly,
    oddsBands,
    hallOfFame,
    biggestL,
    settings: {
      unitValue: settings.unitValue,
      currency: settings.currency,
      startingBankrollUnits: settings.startingBankrollUnits,
    },
  });
}

interface KeyedBet extends BetLike {
  sport: string | null;
  league: string | null;
  market: string;
  bookmaker: string | null;
  betType: string;
}

function toKeyed(b: {
  odds: number;
  stakeUnits: number;
  outcome: string;
  closingOdds: number | null;
  eventAt: Date | null;
  placedAt: Date;
  createdAt: Date;
  profitUnits: number | null;
  sport: string | null;
  league: string | null;
  market: string;
  bookmaker: string | null;
  betType: string;
}): KeyedBet {
  return {
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    closingOdds: b.closingOdds,
    eventAt: b.eventAt,
    placedAt: b.placedAt,
    createdAt: b.createdAt,
    profitUnits: b.profitUnits,
    sport: b.sport,
    league: b.league,
    market: b.market,
    bookmaker: b.bookmaker,
    betType: b.betType,
  };
}

function yearOf(d: Date | string | null | undefined): string {
  if (!d) return "Okänt";
  return String(new Date(d).getFullYear());
}

// All months ascending (YYYY-MM) with per-month metrics.
function monthlyAll(
  bets: { eventAt: Date | null; placedAt: Date; odds: number; stakeUnits: number; outcome: string; closingOdds: number | null; createdAt: Date; profitUnits: number | null }[]
) {
  const groups = new Map<string, BetLike[]>();
  for (const b of bets) {
    const d = b.eventAt ?? b.placedAt;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const arr = groups.get(key);
    const bl: BetLike = {
      odds: b.odds,
      stakeUnits: b.stakeUnits,
      outcome: b.outcome as Outcome,
      closingOdds: b.closingOdds,
      eventAt: b.eventAt,
      placedAt: b.placedAt,
      createdAt: b.createdAt,
      profitUnits: b.profitUnits,
    };
    if (arr) arr.push(bl);
    else groups.set(key, [bl]);
  }

  return Array.from(groups.entries())
    .map(([month, list]) => {
      const m = computeMetrics(list);
      return {
        month,
        bets: list.length,
        profitUnits: m.profitUnits,
        roiPct: m.roiPct,
        stakedUnits: m.stakedUnits,
        winRatePct: m.winRatePct,
      };
    })
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

// Top-5 individual bets by total profit (dir="win") or biggest loss (dir="loss").
// Maps raw rows to BetLike + display fields, ranks, then returns the UI shape.
function leaderboard(
  bets: {
    id: string;
    event: string;
    selection: string;
    sport: string | null;
    league: string | null;
    bookmaker: string | null;
    eventAt: Date | null;
    placedAt: Date;
    odds: number;
    stakeUnits: number;
    outcome: string;
    closingOdds: number | null;
    profitUnits: number | null;
  }[],
  dir: "win" | "loss"
) {
  const entries = bets.map((b) => ({
    id: b.id,
    event: b.event,
    selection: b.selection,
    sport: b.sport,
    league: b.league,
    bookmaker: b.bookmaker,
    eventAt: (b.eventAt ?? b.placedAt).toISOString(),
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    closingOdds: b.closingOdds,
    profitUnits: b.profitUnits,
  }));
  return topBetsByProfit(entries, dir, 5).map((r) => ({
    id: r.id,
    event: r.event,
    selection: r.selection,
    sport: r.sport,
    league: r.league,
    bookmaker: r.bookmaker,
    eventAt: r.eventAt,
    odds: r.odds,
    stakeUnits: r.stakeUnits,
    profitUnits: settledProfit(r),
    roiPct: singleRoiPct(r),
  }));
}

function oddsBandBreakdown(bets: BetLike[]) {
  const bands = [
    { label: "1.01–1.50", min: 1.01, max: 1.5 },
    { label: "1.50–2.00", min: 1.5, max: 2.0 },
    { label: "2.00–3.00", min: 2.0, max: 3.0 },
    { label: "3.00–5.00", min: 3.0, max: 5.0 },
    { label: "5.00+", min: 5.0, max: Infinity },
  ];
  return bands.map((band) => {
    const inBand = bets.filter((b) => b.odds >= band.min && b.odds < band.max);
    const m = computeMetrics(inBand);
    return {
      label: band.label,
      bets: inBand.length,
      profitUnits: m.profitUnits,
      roiPct: m.roiPct,
      winRatePct: m.winRatePct,
    };
  });
}
