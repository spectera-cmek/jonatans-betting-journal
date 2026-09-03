// Core settlement & portfolio math. Everything is in UNITS; convert to currency
// at display time via Setting.unitValue. Keep this module pure & dependency-free
// so it is trivially unit-testable.

export type Outcome =
  | "pending"
  | "win"
  | "loss"
  | "push"
  | "half_win"
  | "half_loss"
  | "void";

export const OUTCOME_LABELS: Record<Outcome, string> = {
  pending: "Pending",
  win: "Win",
  loss: "Loss",
  push: "Push",
  half_win: "Half win",
  half_loss: "Half loss",
  void: "Void",
};

/**
 * Profit in units for a settled bet.
 *  win       -> stake * (odds - 1)
 *  loss      -> -stake
 *  push/void -> 0 (stake returned)
 *  half_win  -> half the stake wins, the other half is returned
 *  half_loss -> half the stake is lost, the other half is returned
 *  pending   -> 0 (excluded from settled stats elsewhere)
 *
 * NOTE: profit is stake * (odds - 1), NOT stake * odds (that is the return).
 */
export function profitUnits(
  outcome: Outcome,
  odds: number,
  stakeUnits: number
): number {
  switch (outcome) {
    case "win":
      return stakeUnits * (odds - 1);
    case "loss":
      return -stakeUnits;
    case "push":
    case "void":
      return 0;
    case "half_win":
      return (stakeUnits * (odds - 1)) / 2;
    case "half_loss":
      return -stakeUnits / 2;
    case "pending":
    default:
      return 0;
  }
}

export function isSettled(outcome: Outcome): boolean {
  return outcome !== "pending";
}

/** Outcomes that count toward the win-rate denominator (exclude push/void). */
export function countsForWinRate(outcome: Outcome): boolean {
  return (
    outcome === "win" ||
    outcome === "loss" ||
    outcome === "half_win" ||
    outcome === "half_loss"
  );
}

export function isWinLike(outcome: Outcome): boolean {
  return outcome === "win" || outcome === "half_win";
}

export interface BetLike {
  odds: number;
  stakeUnits: number;
  outcome: Outcome;
  closingOdds?: number | null;
  // Provenance of closingOdds — see VERIFIED_CLOSING_SOURCES below.
  closingSource?: string | null;
  // An odds boost is a promotion, not a market price. Never CLV.
  boosted?: boolean | null;
  eventAt?: Date | string | null;
  placedAt?: Date | string | null;
  createdAt?: Date | string | null;
  // Authoritative settled profit (e.g. real payout from an imported statement).
  // When present, it overrides the odds-based formula in aggregates.
  profitUnits?: number | null;
}

/**
 * Settled profit for a bet: prefer a stored, authoritative profitUnits (imported
 * real payouts, after tax/cashout), falling back to the odds-based formula.
 */
export function settledProfit(b: BetLike): number {
  if (typeof b.profitUnits === "number" && Number.isFinite(b.profitUnits))
    return b.profitUnits;
  return profitUnits(b.outcome, b.odds, b.stakeUnits);
}

/**
 * Importers store losses with unknown odds at exactly 1.01 (bet365 effectiveOdds,
 * Unibet LOSS_PLACEHOLDER). P/L is still correct for those bets, but the odds value
 * is fake — exclude them from any odds-based analysis (bands, averages, edge search).
 */
export const PLACEHOLDER_ODDS = 1.01;

export function hasRealOdds(b: { odds: number }): boolean {
  return b.odds > PLACEHOLDER_ODDS;
}

/**
 * Odds bands, shared by the analytics breakdown and the edge/leak search so the
 * two can never disagree about where a price falls. Bounds are [min, max).
 * Labels are bare — callers that already show an "Odds" tag don't repeat it.
 */
export const ODDS_BANDS = [
  { label: "1.02–1.49", min: PLACEHOLDER_ODDS, max: 1.5 },
  { label: "1.50–1.99", min: 1.5, max: 2.0 },
  { label: "2.00–2.99", min: 2.0, max: 3.0 },
  { label: "3.00–4.99", min: 3.0, max: 5.0 },
  { label: "5.00+", min: 5.0, max: Infinity },
] as const;

/** Band label for a price, or null when it's a 1.01 import placeholder. */
export function oddsBandKey(odds: number): string | null {
  const band = ODDS_BANDS.find((b) => odds >= b.min && odds < b.max);
  return band ? band.label : null;
}

export interface Metrics {
  totalBets: number;
  settledBets: number;
  pendingBets: number;
  wins: number;
  losses: number;
  pushVoid: number;
  stakedUnits: number; // total staked across settled bets
  profitUnits: number; // net profit across settled bets
  roiPct: number | null; // profit / staked * 100
  winRatePct: number | null; // wins / (wins+losses-ish) * 100
  avgOdds: number | null; // mean odds across settled bets
  // Median odds. The mean is dragged upward by a long tail of bet-builder
  // prices (a handful priced at 1000+), so it stops describing what is
  // actually being bet — the median is the number to show.
  medianOdds: number | null;
  // CLV against a *verified* closing price (see VERIFIED_CLOSING_SOURCES).
  clvPct: number | null; // mean CLV
  clvBeatCount: number; // bets where we beat the closing line
  clvSampleSize: number; // bets counted
  // Same three, for closing prices of unverified provenance — chiefly the
  // BetHero CSV, which wrote de-vigged *fair* odds into closingOdds. Beating a
  // fair price is an edge estimate, not closing line value; kept apart so the
  // headline number is not inflated by it.
  clvUnverifiedPct: number | null;
  clvUnverifiedBeatCount: number;
  clvUnverifiedSampleSize: number;
  // Bets carrying any closing price at all, boosted and unverified included.
  // Denominator-free coverage signal: clvAnySampleSize / totalBets.
  clvAnySampleSize: number;
  // Boosted bets that had a closing price and were deliberately excluded.
  clvBoostedSkipped: number;
}

/** Single-bet CLV as a percentage: (odds / closingOdds - 1) * 100. */
export function clvPct(odds: number, closingOdds: number): number {
  return (odds / closingOdds - 1) * 100;
}

/**
 * Closing-odds sources that really are a market closing price. Everything else
 * — `bethero_fair` (de-vigged fair odds), `legacy` (imported before the column
 * existed, provenance unknown), or no source at all — is counted separately.
 */
export const VERIFIED_CLOSING_SOURCES = [
  "odds_api",
  "thestatsapi",
  "oddsportal",
  "manual",
] as const;

export function isVerifiedClosing(source?: string | null): boolean {
  return source != null && (VERIFIED_CLOSING_SOURCES as readonly string[]).includes(source);
}

/**
 * True when the bet carries a usable closing price and is not odds-boosted.
 * Structurally typed on just those two fields so raw Prisma rows (whose
 * `outcome` is a plain string) can be passed without a cast.
 */
export function countsForClv(b: { closingOdds?: number | null; boosted?: boolean | null }): boolean {
  return !b.boosted && !!b.closingOdds && b.closingOdds > 1;
}

/** Aggregate portfolio metrics over a set of bets. Pending excluded from settled stats. */
export function computeMetrics(bets: BetLike[]): Metrics {
  let settledBets = 0;
  let pendingBets = 0;
  let wins = 0;
  let losses = 0;
  let pushVoid = 0;
  let stakedUnits = 0;
  let profit = 0;
  let oddsSum = 0;
  let oddsCount = 0;
  const settledOdds: number[] = [];
  let clvSum = 0;
  let clvSample = 0;
  let clvBeat = 0;
  let fairSum = 0;
  let fairSample = 0;
  let fairBeat = 0;
  let clvAny = 0;
  let clvBoostedSkipped = 0;

  for (const b of bets) {
    const outcome = b.outcome;

    // CLV is independent of settlement: count any bet that has a closing line.
    // Boosted prices are excluded outright — a boost is a promotion, not the
    // market — and unverified provenance is tallied separately rather than
    // averaged in, because the two measure different things.
    if (b.closingOdds && b.closingOdds > 1) {
      clvAny += 1;
      if (b.boosted) {
        clvBoostedSkipped += 1;
      } else {
        const c = clvPct(b.odds, b.closingOdds);
        if (isVerifiedClosing(b.closingSource)) {
          clvSum += c;
          clvSample += 1;
          if (c > 0) clvBeat += 1;
        } else {
          fairSum += c;
          fairSample += 1;
          if (c > 0) fairBeat += 1;
        }
      }
    }

    if (!isSettled(outcome)) {
      pendingBets += 1;
      continue;
    }

    settledBets += 1;
    stakedUnits += b.stakeUnits;
    profit += settledProfit(b);
    oddsSum += b.odds;
    oddsCount += 1;
    settledOdds.push(b.odds);

    if (isWinLike(outcome)) wins += 1;
    else if (outcome === "loss" || outcome === "half_loss") losses += 1;
    else pushVoid += 1; // push or void
  }

  const winRateDenom = wins + losses;

  return {
    totalBets: bets.length,
    settledBets,
    pendingBets,
    wins,
    losses,
    pushVoid,
    stakedUnits,
    profitUnits: profit,
    roiPct: stakedUnits > 0 ? (profit / stakedUnits) * 100 : null,
    winRatePct: winRateDenom > 0 ? (wins / winRateDenom) * 100 : null,
    avgOdds: oddsCount > 0 ? oddsSum / oddsCount : null,
    medianOdds: median(settledOdds),
    clvPct: clvSample > 0 ? clvSum / clvSample : null,
    clvBeatCount: clvBeat,
    clvSampleSize: clvSample,
    clvUnverifiedPct: fairSample > 0 ? fairSum / fairSample : null,
    clvUnverifiedBeatCount: fairBeat,
    clvUnverifiedSampleSize: fairSample,
    clvAnySampleSize: clvAny,
    clvBoostedSkipped,
  };
}

/** Median of a numeric list; null when empty. Even counts average the middle pair. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toTime(d?: Date | string | null): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export interface BankrollPoint {
  date: string; // ISO date of the settling event
  bankrollUnits: number;
  profitUnits: number; // cumulative profit
  label: string; // short event label
}

/**
 * Running bankroll over time, ordered by event date (falls back to placedAt/createdAt).
 * Only settled bets move the bankroll. Starts at startingBankrollUnits.
 */
export function bankrollSeries(
  bets: BetLike[],
  startingBankrollUnits: number
): BankrollPoint[] {
  const settled = bets
    .filter((b) => isSettled(b.outcome))
    .map((b) => ({
      ...b,
      t: toTime(b.eventAt) || toTime(b.placedAt) || toTime(b.createdAt),
    }))
    .sort((a, b) => a.t - b.t);

  let running = startingBankrollUnits;
  let cumProfit = 0;
  const points: BankrollPoint[] = [];

  // Seed point so the chart starts at the baseline.
  points.push({
    date: settled.length ? new Date(settled[0].t).toISOString() : new Date().toISOString(),
    bankrollUnits: startingBankrollUnits,
    profitUnits: 0,
    label: "Start",
  });

  for (const b of settled) {
    const p = settledProfit(b);
    running += p;
    cumProfit += p;
    points.push({
      date: new Date(b.t || Date.now()).toISOString(),
      bankrollUnits: round2(running),
      profitUnits: round2(cumProfit),
      label: "",
    });
  }

  return points;
}

export interface Breakdown {
  key: string;
  bets: number;
  settled: number;
  stakedUnits: number;
  profitUnits: number;
  roiPct: number | null;
  avgOdds: number | null;
  winRatePct: number | null;
  // Verified-closing CLV for the group, plus how much of the group has any
  // closing price at all. Coverage is the honest companion to the CLV number:
  // a great CLV over 7 % of a market says almost nothing about that market.
  clvPct: number | null;
  clvSampleSize: number;
  clvBeatCount: number;
  clvUnverifiedSampleSize: number;
  clvCoveragePct: number | null;
}

/** Group bets by an arbitrary key (sport, league, market, bookmaker...) with per-group metrics. */
export function breakdownBy(
  bets: BetLike[],
  keyFn: (b: BetLike) => string | null | undefined,
  fallback = "Unknown"
): Breakdown[] {
  const map = new Map<string, BetLike[]>();
  for (const b of bets) {
    const k = (keyFn(b) || fallback).toString();
    const arr = map.get(k);
    if (arr) arr.push(b);
    else map.set(k, [b]);
  }

  const out: Breakdown[] = [];
  for (const [key, group] of map) {
    const m = computeMetrics(group);
    out.push({
      key,
      bets: group.length,
      settled: m.settledBets,
      stakedUnits: m.stakedUnits,
      profitUnits: m.profitUnits,
      roiPct: m.roiPct,
      avgOdds: m.avgOdds,
      winRatePct: m.winRatePct,
      clvPct: m.clvPct,
      clvSampleSize: m.clvSampleSize,
      clvBeatCount: m.clvBeatCount,
      clvUnverifiedSampleSize: m.clvUnverifiedSampleSize,
      clvCoveragePct: group.length > 0 ? (m.clvAnySampleSize / group.length) * 100 : null,
    });
  }
  // Sort by profit descending so the best performers float to the top.
  out.sort((a, b) => b.profitUnits - a.profitUnits);
  return out;
}

/**
 * Top N settled bets by total profit. dir="win" returns the biggest winners
 * (profit > 0, descending); dir="loss" returns the biggest losers (profit < 0,
 * ascending, i.e. most negative first). Generic so callers keep their own display
 * fields on each entry. Pending/push/void are excluded (profit 0 never qualifies).
 */
export function topBetsByProfit<T extends BetLike>(
  bets: T[],
  dir: "win" | "loss",
  n = 5
): T[] {
  return bets
    .filter((b) => isSettled(b.outcome))
    .map((b) => ({ b, p: settledProfit(b) }))
    .filter((x) => (dir === "win" ? x.p > 0 : x.p < 0))
    .sort((a, b) => (dir === "win" ? b.p - a.p : a.p - b.p))
    .slice(0, n)
    .map((x) => x.b);
}

/** Single-bet ROI as a percentage: profit / stake * 100 (null if stake <= 0). */
export function singleRoiPct(b: BetLike): number | null {
  return b.stakeUnits > 0 ? (settledProfit(b) / b.stakeUnits) * 100 : null;
}

export interface OpenRisk {
  bets: number;
  stakeUnits: number; // total units currently in play
  potentialReturnUnits: number; // sum of stake * odds if everything wins
}

/** Exposure across pending bets: units at risk + best-case total return. */
export function openRisk(bets: BetLike[]): OpenRisk {
  let n = 0;
  let stake = 0;
  let potential = 0;
  for (const b of bets) {
    if (b.outcome !== "pending") continue;
    n += 1;
    stake += b.stakeUnits;
    potential += b.stakeUnits * b.odds;
  }
  return { bets: n, stakeUnits: round2(stake), potentialReturnUnits: round2(potential) };
}

export interface DrawdownInfo {
  maxUnits: number; // largest peak-to-trough drop in bankroll units
  pctOfPeak: number | null; // that drop as % of the peak it fell from
}

/** Largest peak-to-trough drop over a bankroll series. */
export function maxDrawdown(points: BankrollPoint[]): DrawdownInfo {
  let peak = -Infinity;
  let maxDd = 0;
  let pct: number | null = null;
  for (const p of points) {
    if (p.bankrollUnits > peak) peak = p.bankrollUnits;
    const dd = peak - p.bankrollUnits;
    if (dd > maxDd) {
      maxDd = dd;
      pct = peak > 0 ? (dd / peak) * 100 : null;
    }
  }
  return { maxUnits: round2(maxDd), pctOfPeak: pct };
}

/** True for any multi-leg bet — accumulators, parlays and same-match bet
 *  builders alike. Legacy rows also carry "double"/"parlay". */
export function isMultiBet(betType?: string | null): boolean {
  const t = (betType ?? "").toLowerCase();
  return t === "accumulator" || t === "betbuilder" || t === "parlay" || t === "double";
}

/** Swedish label for a bet type, for breakdowns and tables. */
export function betTypeLabel(betType?: string | null): string {
  const t = (betType ?? "").toLowerCase();
  if (t === "betbuilder") return "Bet Builder";
  if (isMultiBet(t)) return "Kombination";
  return "Singel";
}

/** Combined decimal odds for an accumulator: product of leg odds. */
export function accaOdds(legOdds: number[]): number {
  return legOdds.reduce((acc, o) => acc * o, 1);
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
