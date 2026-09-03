import { NextResponse } from "next/server";
import { prisma, getSettings } from "@/lib/db";
import {
  computeMetrics,
  bankrollSeries,
  breakdownBy,
  topBetsByProfit,
  singleRoiPct,
  settledProfit,
  openRisk,
  maxDrawdown,
  hasRealOdds,
  betTypeLabel,
  clvPct,
  countsForClv,
  oddsBandKey,
  ODDS_BANDS,
  type BetLike,
  type Breakdown,
} from "@/lib/betting";
import type { RuleBetInput } from "@/lib/disciplineRules";
import type { Outcome } from "@/lib/betting";
import { computeInsights } from "@/lib/insights";
import { deriveDisciplineRules } from "@/lib/disciplineRules";
import { tiltStatus } from "@/lib/tilt";
import { weeklyReport, monthlyReport, type WeeklyBetInput } from "@/lib/weekly";
import { getSessionUser, apiUnauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Only the columns the aggregations actually read — keeps the Neon transfer
// small (notes/legs/teams are the bulk of a full row and are never used here).
const METRICS_SELECT = {
  id: true,
  event: true,
  selection: true,
  sport: true,
  league: true,
  market: true,
  marketCategory: true,
  marketScope: true,
  eventKind: true,
  tournamentStage: true,
  bookmaker: true,
  betType: true,
  odds: true,
  closingOdds: true,
  closingSource: true,
  boosted: true,
  stakeUnits: true,
  outcome: true,
  profitUnits: true,
  eventAt: true,
  placedAt: true,
  createdAt: true,
} as const;

// GET /api/metrics — everything the dashboard & analytics need.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return apiUnauthorized();
  const [bets, settings] = await Promise.all([
    prisma.bet.findMany({ where: { userId: user.id }, select: METRICS_SELECT }),
    getSettings(user.id),
  ]);

  const betLikes: BetLike[] = bets.map((b) => ({
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    closingOdds: b.closingOdds,
    closingSource: b.closingSource,
    boosted: b.boosted,
    eventAt: b.eventAt,
    placedAt: b.placedAt,
    createdAt: b.createdAt,
    profitUnits: b.profitUnits,
  }));

  const metrics = computeMetrics(betLikes);
  // Placeholder odds (1.01 = imported loss with unknown odds) are fake prices —
  // the displayed average is computed on real odds only. P/L is unaffected.
  const realOddsMetrics = computeMetrics(betLikes.filter(hasRealOdds));
  const bankroll = bankrollSeries(betLikes, settings.startingBankrollUnits);

  // One keyed projection, reused by every breakdown below.
  const keyed = bets.map(toKeyed);

  const bySport = keyed.length ? breakdownBy(keyed, (b) => (b as KeyedBet).sport, "Unknown") : [];
  const byLeague = breakdownBy(keyed, (b) => (b as KeyedBet).league, "Unknown");
  const byMarket = breakdownBy(keyed, (b) => (b as KeyedBet).market, "Övrigt");
  // Detaljerad, semantisk marknad ("vad") + scope (Spelare/Lag/Match).
  const byMarketDetail = breakdownBy(keyed, (b) => (b as KeyedBet).marketCategory, "Okänd");
  const byScope = breakdownBy(
    keyed,
    (b) => {
      const sc = (b as KeyedBet).marketScope;
      return sc === "player" ? "Spelare" : sc === "team" ? "Lag" : sc === "match" ? "Match (totalt)" : null;
    },
    "Okänd"
  );
  const byBookmaker = breakdownBy(keyed, (b) => (b as KeyedBet).bookmaker, "Unknown");

  // Per year (chronological) and per bet type.
  const byYear = breakdownBy(keyed, (b) => yearOf(b.eventAt ?? b.placedAt)).sort((a, b) =>
    a.key.localeCompare(b.key)
  );
  const byBetType = breakdownBy(keyed, (b) => betTypeLabel((b as KeyedBet).betType));

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

  // Leak/edge rules recomputed from the journal on every load. These drive both
  // the warnings in the add-bet modal and the discipline grade below, so they
  // are derived before the reports rather than read from frozen constants.
  const disciplineRules = deriveDisciplineRules(keyed as RuleBetInput[]);

  // Exposure on pending bets + worst historical peak-to-trough drop.
  const risk = openRisk(betLikes);
  const drawdown = maxDrawdown(bankroll);

  // Metrics for each period the overview's selector offers, computed in one
  // pass over rows already in memory. The selector used to move only the chart
  // and two of six KPI cards; ROI, win rate, CLV and odds stayed all-time,
  // which quietly mixed two different periods in one row of cards.
  const periodMetrics = computePeriodMetrics(betLikes, settings.startingBankrollUnits);

  // Tilt guard (stake budgets + chasing) and the weekly report.
  const tilt = tiltStatus(
    betLikes,
    {
      dailyBudgetUnits: settings.dailyStakeBudgetUnits,
      weeklyBudgetUnits: settings.weeklyStakeBudgetUnits,
    },
    new Date()
  );
  const weeklyInput: WeeklyBetInput[] = bets.map((b) => ({
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    eventAt: b.eventAt,
    placedAt: b.placedAt,
    createdAt: b.createdAt,
    profitUnits: b.profitUnits,
    event: b.event,
    selection: b.selection,
    sport: b.sport,
    market: b.market,
    betType: b.betType,
  }));
  const weekly = weeklyReport(weeklyInput, new Date(), disciplineRules);
  const monthlyRep = monthlyReport(weeklyInput, new Date(), disciplineRules);

  // Pending bets, soonest event first (nulls last) — the dashboard "Öppna spel" panel.
  const openBets = bets
    .filter((b) => b.outcome === "pending")
    .sort((a, b) => {
      const ta = a.eventAt ? a.eventAt.getTime() : Infinity;
      const tb = b.eventAt ? b.eventAt.getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      return a.placedAt.getTime() - b.placedAt.getTime();
    })
    .slice(0, 25)
    .map((b) => ({
      id: b.id,
      event: b.event,
      selection: b.selection,
      sport: b.sport,
      league: b.league,
      marketCategory: b.marketCategory,
      marketScope: b.marketScope,
      eventKind: b.eventKind,
      tournamentStage: b.tournamentStage,
      bookmaker: b.bookmaker,
      betType: b.betType,
      odds: b.odds,
      stakeUnits: b.stakeUnits,
      closingOdds: b.closingOdds,
      closingSource: b.closingSource,
      boosted: b.boosted,
      clvPct: countsForClv(b) ? clvPct(b.odds, b.closingOdds as number) : null,
      eventAt: b.eventAt ? b.eventAt.toISOString() : null,
      placedAt: b.placedAt.toISOString(),
    }));

  return NextResponse.json({
    username: user.username,
    metrics: {
      ...metrics,
      avgOdds: realOddsMetrics.avgOdds,
      medianOdds: realOddsMetrics.medianOdds,
    },
    insights,
    disciplineRules,
    openRisk: risk,
    drawdown,
    periodMetrics,
    tilt,
    weekly,
    monthlyReport: monthlyRep,
    openBets,
    bankroll,
    bySport,
    byLeague,
    byMarket,
    byMarketDetail,
    byScope,
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

// Windows the overview's period selector offers. "all" is the whole history.
const PERIOD_DAYS = { "1y": 365, "90d": 90, "30d": 30, "7d": 7 } as const;
export type PeriodKey = "all" | keyof typeof PERIOD_DAYS;

/**
 * Metrics + drawdown per selectable period. Median odds comes from real prices
 * only, matching the all-time figure.
 */
function computePeriodMetrics(bets: BetLike[], startingBankrollUnits: number) {
  const now = Date.now();
  const at = (b: BetLike) => new Date(b.eventAt ?? b.placedAt ?? b.createdAt ?? 0).getTime();

  const forRows = (rows: BetLike[]) => {
    const m = computeMetrics(rows);
    const real = computeMetrics(rows.filter(hasRealOdds));
    return {
      ...m,
      avgOdds: real.avgOdds,
      medianOdds: real.medianOdds,
      drawdown: maxDrawdown(bankrollSeries(rows, startingBankrollUnits)),
    };
  };

  const out: Record<string, ReturnType<typeof forRows>> = { all: forRows(bets) };
  for (const [key, days] of Object.entries(PERIOD_DAYS)) {
    const cutoff = now - days * 864e5;
    out[key] = forRows(bets.filter((b) => at(b) >= cutoff));
  }
  return out;
}

interface KeyedBet extends BetLike {
  sport: string | null;
  league: string | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  bookmaker: string | null;
  betType: string;
}

function toKeyed(b: {
  odds: number;
  stakeUnits: number;
  outcome: string;
  closingOdds: number | null;
  closingSource: string | null;
  boosted: boolean;
  eventAt: Date | null;
  placedAt: Date;
  createdAt: Date;
  profitUnits: number | null;
  sport: string | null;
  league: string | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  bookmaker: string | null;
  betType: string;
}): KeyedBet {
  return {
    odds: b.odds,
    stakeUnits: b.stakeUnits,
    outcome: b.outcome as Outcome,
    closingOdds: b.closingOdds,
    closingSource: b.closingSource,
    boosted: b.boosted,
    eventAt: b.eventAt,
    placedAt: b.placedAt,
    createdAt: b.createdAt,
    profitUnits: b.profitUnits,
    sport: b.sport,
    league: b.league,
    market: b.market,
    marketCategory: b.marketCategory,
    marketScope: b.marketScope,
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
  bets: { eventAt: Date | null; placedAt: Date; odds: number; stakeUnits: number; outcome: string; closingOdds: number | null; closingSource: string | null; boosted: boolean; createdAt: Date; profitUnits: number | null }[]
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
      closingSource: b.closingSource,
      boosted: b.boosted,
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
        // CLV over time: the verified series, plus how many bets it rests on
        // that month and how many carried any closing price at all.
        clvPct: m.clvPct,
        clvSampleSize: m.clvSampleSize,
        clvUnverifiedPct: m.clvUnverifiedPct,
        clvUnverifiedSampleSize: m.clvUnverifiedSampleSize,
        clvAnySampleSize: m.clvAnySampleSize,
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

// Odds bands as full Breakdowns, so the analytics card gets the same fields
// (stake, settled, CLV, coverage) as every other breakdown instead of zeros.
// Placeholder odds (1.01 = imported loss with unknown odds) would pollute the
// lowest band with fake prices — real odds only here.
function oddsBandBreakdown(bets: BetLike[]): Breakdown[] {
  const rows = breakdownBy(bets.filter(hasRealOdds), (b) => oddsBandKey(b.odds));
  const order: string[] = ODDS_BANDS.map((b) => b.label);
  return rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
