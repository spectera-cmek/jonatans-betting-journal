// Shared sync logic used by both the API routes and the CLI script.
// Grades finished bets and captures closing odds for CLV.

import { prisma } from "./db";
import { gradeBet, resolveGradingMarket, type GradableBet, type ResolvedMarket } from "./grading";
import { espnPath, fetchFinalScore, fetchMatchDetail, type MatchDetail } from "./scores";
import {
  clearGradeBlock,
  isRetryDue,
  noteGradeFailure,
  retryDueFilter,
} from "./gradeAttempt";
import { settleBet } from "./settlement";
import {
  getScores,
  getEvents,
  parseScores,
  hasOddsApiKey,
  type ScoreEvent,
} from "./oddsApi";
import { linkBetToOddsEvent, parseHomeAway } from "./eventLink";
import {
  gradeAccumulator,
  legOutcomeFromLabel,
  parseLegs,
  type LegFixture,
} from "./gradingLegs";
import { hasTheStatsApiKey } from "./theStatsApi";
import {
  linkBetsToStatsMatches,
  captureClosingOdds,
  isStatsApiMatchRef,
} from "./clvCapture";
import { captureClosingNearKickoff } from "./clvOddsApi";
import { captureHistoricalClosing } from "./clvHistorical";
import { captureClosingFromOddsPortal } from "./clvOddsPortalBatch";

export interface SyncResult {
  ok: boolean;
  message: string;
  linked: number;
  graded: number;
  closingUpdated: number;
  details: string[];
}

const CLV_WINDOW_DAYS = 90;
/** Keep each serverless sync under Vercel’s timeout (504). */
const SYNC_LINK_LIMIT = 12;
const SYNC_CLOSING_LIMIT = 10;
const SYNC_GRADE_LIMIT = 25;
const SYNC_DEADLINE_MS = 45_000;

/** Auto-link unlinked football bets to TheStatsAPI matches (historical closing odds). */
export async function runLinkStatsApiEvents(
  opts: { limit?: number } = {}
): Promise<SyncResult> {
  const details: string[] = [];
  if (!hasTheStatsApiKey()) {
    return {
      ok: false,
      message: "No THESTATSAPI_KEY set — cannot auto-link football events.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details,
    };
  }

  const result = await linkBetsToStatsMatches({
    sinceDays: CLV_WINDOW_DAYS,
    limit: opts.limit ?? SYNC_LINK_LIMIT,
  });
  if (result.linked > 0) {
    await prisma.syncLog.create({
      data: { kind: "link", summary: `Linked ${result.linked} bet(s) to TheStatsAPI matches.` },
    });
  }

  return {
    ok: true,
    message: `Länkade ${result.linked} fotbollsbet(s) till TheStatsAPI.`,
    linked: result.linked,
    graded: 0,
    closingUpdated: 0,
    details: result.details,
  };
}

/** Auto-link unlinked match bets to Odds API events (enables grade + CLV). */
export async function runLinkEvents(): Promise<SyncResult> {
  const details: string[] = [];
  if (!hasOddsApiKey()) {
    return {
      ok: false,
      message: "No ODDS_API_KEY set — cannot auto-link events.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details,
    };
  }

  const candidates = await prisma.bet.findMany({
    where: {
      externalRef: null,
      eventKind: "match",
      betType: "single",
      OR: [{ homeTeam: { not: null } }, { awayTeam: { not: null } }, { event: { not: "" } }],
    },
    select: {
      id: true,
      event: true,
      homeTeam: true,
      awayTeam: true,
      eventAt: true,
      sport: true,
      league: true,
      sportKey: true,
      externalRef: true,
    },
  });

  if (candidates.length === 0) {
    return {
      ok: true,
      message: "Inga bets behöver event-länkning.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details,
    };
  }

  const cache = new Map<string, Awaited<ReturnType<typeof getEvents>>>();
  let linked = 0;
  for (const bet of candidates) {
    const result = await linkBetToOddsEvent(prisma, bet, cache);
    if (result.linked) {
      linked += 1;
      details.push(`${bet.event}: länkad → ${result.sportKey}`);
    }
  }

  if (linked > 0) {
    await prisma.syncLog.create({
      data: { kind: "link", summary: `Linked ${linked} bet(s) to Odds API events.` },
    });
  }

  return {
    ok: true,
    message: `Länkade ${linked} bet(s) till Odds API.`,
    linked,
    graded: 0,
    closingUpdated: 0,
    details,
  };
}

/** Auto-grade all pending bets that are linked to a finished event. */
export async function runGrade(opts: { limit?: number } = {}): Promise<SyncResult> {
  const details: string[] = [];
  if (!hasOddsApiKey()) {
    return {
      ok: false,
      message: "No ODDS_API_KEY set — add it to .env.local to enable auto-grading.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details,
    };
  }

  // Only bets we can actually look up: pending + linked to an external event.
  const now = new Date();
  const pending = await prisma.bet.findMany({
    where: {
      outcome: "pending",
      externalRef: { not: null },
      sportKey: { not: null },
      betType: "single",
      eventKind: "match",
      // /scores only reaches back three days, so an older bet can never be
      // answered here — spending 2 credits per sport to re-learn that is waste.
      eventAt: { gte: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), lte: now },
      ...retryDueFilter(now),
    },
    take: opts.limit ?? SYNC_GRADE_LIMIT,
  });

  if (pending.length === 0) {
    return { ok: true, message: "No pending linked bets to grade.", linked: 0, graded: 0, closingUpdated: 0, details };
  }

  // Group by sportKey so we make one scores call per sport.
  const bySport = new Map<string, typeof pending>();
  for (const b of pending) {
    const arr = bySport.get(b.sportKey!);
    if (arr) arr.push(b);
    else bySport.set(b.sportKey!, [b]);
  }

  let graded = 0;
  for (const [sportKey, bets] of bySport) {
    if (sportKey.startsWith("tsa:")) continue;
    let scores: ScoreEvent[];
    try {
      scores = await getScores(sportKey, 3);
    } catch (e) {
      details.push(`scores ${sportKey}: ${(e as Error).message}`);
      continue;
    }
    const scoreById = new Map(scores.map((s) => [s.id, s]));

    for (const bet of bets) {
      const ev = scoreById.get(bet.externalRef!);
      if (!ev) continue;
      if (isStatsApiMatchRef(bet.externalRef)) continue;
      const parsed = parseScores(ev);
      if (!parsed) continue; // not finished yet

      const gradable = {
        market: bet.market,
        marketCategory: bet.marketCategory,
        selection: bet.selection,
        selectionSide: bet.selectionSide,
        line: bet.line,
      };
      const outcome = gradeBet(gradable, parsed);
      if (!outcome) {
        // /scores carries the final score and nothing else, so corners, cards
        // and half-time markets can only be answered by the ESPN pass.
        const reason = gradeBlockReason(
          gradable,
          resolveGradingMarket(gradable),
          { homeHalfScore: null },
          null
        );
        details.push(`${bet.event}: ${reason}`);
        await noteGradeFailure(prisma, bet.id, reason);
        continue;
      }

      try {
        const result = await settleBet(prisma, {
          betId: bet.id,
          outcome,
          source: "odds_api",
          reason: `${parsed.homeScore}-${parsed.awayScore} via The Odds API`,
        });
        if (result.changed) graded += 1;
        await clearGradeBlock(prisma, bet.id);
        details.push(`${bet.event}: ${parsed.homeScore}-${parsed.awayScore} -> ${outcome}`);
      } catch (error) {
        const msg = (error as Error).message;
        details.push(`${bet.event}: ${msg}`);
        await noteGradeFailure(prisma, bet.id, msg);
      }
    }
  }

  await prisma.syncLog.create({
    data: { kind: "grade", summary: `Graded ${graded} bet(s).` },
  });

  return {
    ok: true,
    message: `Graded ${graded} bet(s).`,
    linked: 0,
    graded,
    closingUpdated: 0,
    details,
  };
}

/**
 * Say what stopped a bet from grading, in words the bet row can carry.
 *
 * "Marknaden kan inte auto-rättas" was true for every failure and useful for
 * none of them — a missing corner count, an unreadable BTTS label and a genuine
 * player prop all looked identical.
 */
function gradeBlockReason(
  bet: GradableBet,
  resolved: ResolvedMarket | null,
  score: { homeHalfScore?: number | null },
  detail: MatchDetail | null
): string {
  if (!resolved) {
    return `Marknaden "${bet.marketCategory || bet.market}" går inte att räkna ur resultatet — rätta manuellt.`;
  }
  if (resolved === "corners" && detail?.homeCorners == null) {
    return "Hörnstatistik saknas hos ESPN för den här ligan.";
  }
  if (resolved === "cards" && detail?.homeCards == null) {
    return "Kortstatistik saknas hos ESPN för den här ligan.";
  }
  if (resolved.startsWith("first_half") && score.homeHalfScore == null) {
    return "Halvtidsresultat saknas i resultatkällan.";
  }
  if (resolved === "btts") {
    return `Kunde inte läsa ja/nej ur "${bet.selection ?? ""}".`;
  }
  if (resolved === "double_chance") {
    return `Kunde inte läsa dubbelchansen ur "${bet.selection ?? ""}".`;
  }
  if (bet.line == null && (resolved === "totals" || resolved === "spreads")) {
    return "Linjen saknas på betet — fyll i den för att kunna auto-rätta.";
  }
  if (!bet.selectionSide) {
    return "Sidan (hemma/borta/över/under) saknas på betet.";
  }
  return "Marknad/sida/linje räcker inte för säker automatisk rättning.";
}

/**
 * Auto-grade pending single bets from the real final score, fetched from ESPN's
 * free, keyless scoreboard endpoints. Works without any API key.
 *
 * Coverage follows lib/grading.ts: winner, totals and spreads, plus BTTS,
 * double chance, draw-no-bet, corners, cards and first-half markets where the
 * feed carries the numbers. Anything it cannot compute records a reason on the
 * bet rather than failing silently.
 */
export async function runGradeByScores(
  opts: { limit?: number; deadlineMs?: number } = {}
): Promise<SyncResult> {
  const details: string[] = [];
  const limit = opts.limit ?? SYNC_GRADE_LIMIT;
  const deadline = opts.deadlineMs ?? Date.now() + SYNC_DEADLINE_MS;

  const now = new Date();
  const pending = await prisma.bet.findMany({
    where: {
      outcome: "pending",
      eventAt: { not: null, lte: now },
      betType: "single",
      eventKind: "match",
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
      // Bets that have failed repeatedly wait longer between attempts, so a
      // permanently ungradable one stops costing a lookup on every run.
      ...retryDueFilter(now),
    },
    orderBy: { eventAt: "asc" },
    take: limit,
  });

  if (pending.length === 0) {
    return { ok: true, message: "Inga pending bets att rätta via resultat.", linked: 0, graded: 0, closingUpdated: 0, details };
  }

  let graded = 0;
  for (const bet of pending) {
    if (Date.now() > deadline) {
      details.push("Timeout-skydd: avbryter ESPN-rättning — kör synk igen.");
      break;
    }
    if (!isRetryDue(bet, new Date())) continue;

    const fail = async (reason: string) => {
      details.push(`${bet.event}: ${reason}`);
      await noteGradeFailure(prisma, bet.id, reason);
    };

    const path = espnPath(bet.sport, bet.league);
    if (!path) {
      await fail("okänd liga för resultat-uppslag");
      continue;
    }
    if (!bet.homeTeam || !bet.awayTeam) {
      await fail("saknar lagnamn (home/away)");
      continue;
    }

    let score;
    try {
      score = await fetchFinalScore(
        path,
        new Date(bet.eventAt!),
        bet.homeTeam,
        bet.awayTeam,
        bet.resultProvider === "espn" ? bet.resultEventRef : null
      );
    } catch (e) {
      await fail((e as Error).message);
      continue;
    }
    if (!score) {
      await fail("inget färdigspelat resultat hittat ännu");
      continue;
    }
    if (score.wentToExtraTime) {
      await fail("förlängning/straffar — kräver manuell kontroll av 90-minutersmarknaden");
      continue;
    }

    const gradable = {
      market: bet.market,
      marketCategory: bet.marketCategory,
      selection: bet.selection,
      selectionSide: bet.selectionSide,
      line: bet.line,
    };

    // Corners and cards need a second request, so only fetch it for the bets
    // that actually need those numbers.
    let detail: Awaited<ReturnType<typeof fetchMatchDetail>> = null;
    const resolved = resolveGradingMarket(gradable);
    if ((resolved === "corners" || resolved === "cards") && score.eventId) {
      detail = await fetchMatchDetail(path, score.eventId).catch(() => null);
    }

    const outcome = gradeBet(gradable, {
      ...score,
      homeCorners: detail?.homeCorners ?? null,
      awayCorners: detail?.awayCorners ?? null,
      homeCards: detail?.homeCards ?? null,
      awayCards: detail?.awayCards ?? null,
    });
    if (!outcome) {
      await fail(gradeBlockReason(gradable, resolved, score, detail));
      continue;
    }

    try {
      const result = await settleBet(prisma, {
        betId: bet.id,
        outcome,
        source: "espn",
        reason: `${score.homeScore}-${score.awayScore} via ESPN`,
      });
      if (result.changed) graded += 1;
      await clearGradeBlock(prisma, bet.id);
      details.push(`${bet.event}: ${score.homeScore}-${score.awayScore} -> ${outcome}`);
    } catch (error) {
      await fail((error as Error).message);
    }
  }

  if (graded > 0) {
    await prisma.syncLog.create({
      data: { kind: "grade", summary: `Score-graded ${graded} bet(s).` },
    });
  }

  return {
    ok: true,
    message: `Rättade ${graded} bet(s) via resultat.`,
    linked: 0,
    graded,
    closingUpdated: 0,
    details,
  };
}

/**
 * Capture closing odds via TheStatsAPI (historical last_seen after kickoff).
 * Primary CLV path for football — works retroactively on settled matches.
 */
export async function runClosingFromStatsApi(
  opts: { limit?: number } = {}
): Promise<SyncResult> {
  const details: string[] = [];
  if (!hasTheStatsApiKey()) {
    return {
      ok: false,
      message: "No THESTATSAPI_KEY set — add it to .env.local for historical CLV.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details,
    };
  }

  const result = await captureClosingOdds({
    sinceDays: CLV_WINDOW_DAYS,
    limit: opts.limit ?? SYNC_CLOSING_LIMIT,
  });
  if (result.closingUpdated > 0) {
    await prisma.syncLog.create({
      data: {
        kind: "closing",
        summary: `TheStatsAPI closing odds for ${result.closingUpdated} bet(s).`,
      },
    });
  }

  return {
    ok: true,
    message: `TheStatsAPI: uppdaterade closing för ${result.closingUpdated} bet(s).`,
    linked: 0,
    graded: 0,
    closingUpdated: result.closingUpdated,
    details: result.details,
  };
}

/**
 * Near-kickoff CLV via The Odds API (live price ≈ closing). Free-tier friendly.
 */
export async function runClosingNearKickoff(
  opts: { limit?: number; dryRun?: boolean } = {}
): Promise<SyncResult> {
  if (!hasOddsApiKey()) {
    return {
      ok: false,
      message: "No ODDS_API_KEY set — cannot capture kickoff CLV.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details: [],
    };
  }

  const result = await captureClosingNearKickoff({
    limit: opts.limit ?? SYNC_CLOSING_LIMIT,
    dryRun: opts.dryRun,
  });

  if (result.closingUpdated > 0 && !opts.dryRun) {
    await prisma.syncLog.create({
      data: {
        kind: "closing",
        summary: `Odds API kickoff closing for ${result.closingUpdated} bet(s).`,
      },
    });
  }

  return {
    ok: true,
    message: `Odds API kickoff: länkade ${result.linked}, closing ${result.closingUpdated}.`,
    linked: result.linked,
    graded: 0,
    closingUpdated: result.closingUpdated,
    details: result.details,
  };
}

/**
 * OddsPortal batch scrape for featured markets (local/CLI only — needs Playwright).
 */
export async function runClosingFromOddsPortal(
  opts: {
    limit?: number;
    sinceDays?: number;
    dryRun?: boolean;
    postKickoffOnly?: boolean;
  } = {}
): Promise<SyncResult> {
  const result = await captureClosingFromOddsPortal({
    limit: opts.limit ?? 50,
    sinceDays: opts.sinceDays ?? CLV_WINDOW_DAYS,
    dryRun: opts.dryRun,
    postKickoffOnly: opts.postKickoffOnly,
  });

  if (result.updated > 0 && !opts.dryRun) {
    await prisma.syncLog.create({
      data: {
        kind: "closing",
        summary: `OddsPortal scrape closing for ${result.updated} bet(s).`,
      },
    });
  }

  return {
    ok: result.updated > 0 || result.failed === 0,
    message: `OddsPortal: ${result.updated} closing (${result.failed} misslyckade av ${result.attempted}).`,
    linked: 0,
    graded: 0,
    closingUpdated: result.updated,
    details: result.details,
  };
}

/**
 * Auto-grade accumulators by resolving each leg.
 *
 * Imported slips carry the book's own per-leg verdict and settle straight away;
 * hand-logged coupons need every leg structured and matched to a finished
 * fixture first. Anything a leg blocks stays pending with that leg named — a
 * wrongly settled coupon writes a false P/L into the bankroll curve and nothing
 * downstream ever notices.
 */
export async function runGradeAccumulators(
  opts: { limit?: number; deadlineMs?: number } = {}
): Promise<SyncResult> {
  const details: string[] = [];
  const limit = opts.limit ?? SYNC_GRADE_LIMIT;
  const deadline = opts.deadlineMs ?? Date.now() + SYNC_DEADLINE_MS;
  const now = new Date();

  const pending = await prisma.bet.findMany({
    where: {
      outcome: "pending",
      betType: { in: ["accumulator", "betbuilder", "parlay", "double"] },
      legs: { not: null },
      ...retryDueFilter(now),
    },
    orderBy: [{ eventAt: "asc" }, { placedAt: "asc" }],
    take: limit,
  });

  if (pending.length === 0) {
    return { ok: true, message: "Inga kombinationer att rätta.", linked: 0, graded: 0, closingUpdated: 0, details };
  }

  let graded = 0;
  for (const bet of pending) {
    if (Date.now() > deadline) {
      details.push("Timeout-skydd: avbryter kombinationsrättning — kör synk igen.");
      break;
    }
    if (!isRetryDue(bet, new Date())) continue;

    const legs = parseLegs(bet.legs);
    if (legs.length === 0) {
      await noteGradeFailure(prisma, bet.id, "Kupongen saknar sparade ben.");
      continue;
    }

    // Only fetch fixtures for legs the book has not already graded — an
    // imported slip needs no lookups at all.
    const needsFixtures = legs.some((l) => !legOutcomeFromLabel(l.outcome));
    const fixtures: LegFixture[] = [];
    if (needsFixtures) {
      const path = espnPath(bet.sport, bet.league);
      if (!path || !bet.eventAt) {
        await noteGradeFailure(
          prisma,
          bet.id,
          !path ? "Ligan saknar resultatkoppling för benen." : "Kupongen saknar matchtid."
        );
        continue;
      }
      for (const leg of legs) {
        if (legOutcomeFromLabel(leg.outcome)) continue;
        const teams = parseHomeAway(leg.event || "");
        if (!teams) continue;
        const score = await fetchFinalScore(
          path,
          new Date(bet.eventAt),
          teams.home,
          teams.away
        ).catch(() => null);
        if (score && !score.wentToExtraTime) {
          fixtures.push({ homeTeam: teams.home, awayTeam: teams.away, score });
        }
      }
    }

    const result = gradeAccumulator(legs, bet.stakeUnits, fixtures);
    if (!result.outcome) {
      details.push(`${bet.event}: ${result.blockedReason ?? "kunde inte rättas"}`);
      await noteGradeFailure(prisma, bet.id, result.blockedReason ?? "Kunde inte rättas.");
      continue;
    }

    try {
      const settled = await settleBet(prisma, {
        betId: bet.id,
        outcome: result.outcome,
        source: "espn",
        reason:
          result.outcome === "win" && result.effectiveOdds
            ? `${result.legs.length} ben, ${result.effectiveOdds.toFixed(2)} efter void`
            : `${result.legs.length} ben rättade`,
        // Void legs shorten the coupon, so the odds on the row no longer
        // describe the payout — hand settlement the recomputed profit.
        explicitProfitUnits: result.profitUnits,
      });
      if (settled.changed) graded += 1;
      await clearGradeBlock(prisma, bet.id);
      details.push(`${bet.event}: kombination -> ${result.outcome}`);
    } catch (error) {
      const msg = (error as Error).message;
      details.push(`${bet.event}: ${msg}`);
      await noteGradeFailure(prisma, bet.id, msg);
    }
  }

  if (graded > 0) {
    await prisma.syncLog.create({
      data: { kind: "grade", summary: `Graded ${graded} accumulator(s).` },
    });
  }

  return {
    ok: true,
    message: `Rättade ${graded} kombination(er).`,
    linked: 0,
    graded,
    closingUpdated: 0,
    details,
  };
}

/**
 * The real closing line from The Odds API's /historical snapshots.
 *
 * Paid plans only. This is the source that settles a bet's CLV — everything
 * else is a stand-in until it runs.
 */
export async function runClosingHistorical(
  opts: { limit?: number; maxCredits?: number; dryRun?: boolean } = {}
): Promise<SyncResult> {
  if (!hasOddsApiKey()) {
    return {
      ok: false,
      message: "No ODDS_API_KEY set — cannot fetch historical closing lines.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details: [],
    };
  }

  const result = await captureHistoricalClosing({
    limit: opts.limit ?? SYNC_CLOSING_LIMIT,
    sinceDays: CLV_WINDOW_DAYS,
    maxCredits: opts.maxCredits,
    dryRun: opts.dryRun,
  });

  if (result.closingUpdated > 0 && !opts.dryRun) {
    await prisma.syncLog.create({
      data: {
        kind: "closing",
        summary:
          `Historical closing for ${result.closingUpdated} bet(s) ` +
          `across ${result.events} event(s), ${result.creditsSpent} credits.`,
      },
    });
  }

  return {
    ok: true,
    message:
      `Historik: ${result.closingUpdated} stängning på ${result.events} event ` +
      `(${result.creditsSpent} krediter).` + (result.stoppedEarly ? ` ${result.stoppedEarly}` : ""),
    linked: 0,
    graded: 0,
    closingUpdated: result.closingUpdated,
    details: result.details,
  };
}

/**
 * Link football bets then capture historical closing odds (batched for serverless).
 * Falls back to Odds API near-kickoff capture when TheStatsAPI is unavailable.
 */
export async function runClosing(): Promise<SyncResult> {
  const link = hasTheStatsApiKey()
    ? await runLinkStatsApiEvents({ limit: SYNC_LINK_LIMIT })
    : { ok: true, message: "", linked: 0, graded: 0, closingUpdated: 0, details: [] as string[] };
  const stats = await runClosingFromStatsApi({ limit: SYNC_CLOSING_LIMIT });

  const details = [...link.details, ...stats.details];
  let updated = stats.closingUpdated;
  let linked = link.linked;
  let ok = stats.ok || link.ok || updated > 0;

  // Without TheStatsAPI (or when it found nothing), capture near-kickoff via Odds API.
  if (hasOddsApiKey() && (!hasTheStatsApiKey() || updated === 0)) {
    const kickoff = await runClosingNearKickoff({ limit: SYNC_CLOSING_LIMIT });
    details.push(...kickoff.details);
    updated += kickoff.closingUpdated;
    linked += kickoff.linked;
    ok = ok || kickoff.ok || kickoff.closingUpdated > 0;
  }

  const moreHint =
    link.linked >= SYNC_LINK_LIMIT || updated >= SYNC_CLOSING_LIMIT
      ? " Kör synk igen för nästa batch."
      : "";

  return {
    ok,
    message:
      `Länkade ${linked}, closing ${updated}.${moreHint}`.trim() ||
      stats.message ||
      "Ingen closing att uppdatera.",
    linked,
    graded: 0,
    closingUpdated: updated,
    details,
  };
}

export async function runFullSync(): Promise<SyncResult> {
  const deadline = Date.now() + SYNC_DEADLINE_MS;

  // Prefer TheStatsAPI when keyed; otherwise Odds API kickoff CLV + ESPN grading.
  // OddsPortal scrape stays CLI-only (Playwright).
  const linkStats = hasTheStatsApiKey()
    ? await runLinkStatsApiEvents({ limit: SYNC_LINK_LIMIT })
    : { ok: true, message: "", linked: 0, graded: 0, closingUpdated: 0, details: [] as string[] };

  const idle = { ok: true, message: "", linked: 0, graded: 0, closingUpdated: 0, details: [] as string[] };

  // The true close comes first: it is the only source that marks a bet's CLV
  // final, and every path below is a stand-in for it. Running it first also
  // means the fallbacks skip whatever it already settled.
  const closingHistorical =
    hasOddsApiKey() && Date.now() < deadline
      ? await runClosingHistorical({ limit: SYNC_CLOSING_LIMIT })
      : idle;

  const closingStats =
    hasTheStatsApiKey() && Date.now() < deadline
      ? await runClosingFromStatsApi({ limit: SYNC_CLOSING_LIMIT })
      : idle;

  // Near-kickoff prices are line movement now, not the close — worth taking on
  // every run, since the window is short and missing it loses the movement for
  // good. The historical pass still sets the real closing line afterwards.
  const closingKickoff =
    hasOddsApiKey() && Date.now() < deadline
      ? await runClosingNearKickoff({ limit: SYNC_CLOSING_LIMIT })
      : idle;

  // ESPN first because it is free and carries the richer numbers (periods,
  // corners, cards). The Odds API pass then picks up what is left — linked bets
  // in sports ESPN has no league mapping for — at 2 credits per sport.
  const scores =
    Date.now() < deadline
      ? await runGradeByScores({ limit: SYNC_GRADE_LIMIT, deadlineMs: deadline })
      : {
          ok: true,
          message: "",
          linked: 0,
          graded: 0,
          closingUpdated: 0,
          details: ["Timeout-skydd: hoppade ESPN-rättning — kör synk igen."] as string[],
        };

  const oddsScores =
    hasOddsApiKey() && Date.now() < deadline ? await runGrade({ limit: SYNC_GRADE_LIMIT }) : idle;

  const accas =
    Date.now() < deadline
      ? await runGradeAccumulators({ limit: SYNC_GRADE_LIMIT, deadlineMs: deadline })
      : idle;

  const linked = linkStats.linked + closingKickoff.linked;
  const closingUpdated =
    closingHistorical.closingUpdated + closingStats.closingUpdated + closingKickoff.closingUpdated;
  const details = [
    ...linkStats.details,
    ...closingHistorical.details,
    ...closingStats.details,
    ...closingKickoff.details,
    ...scores.details,
    ...oddsScores.details,
    ...accas.details,
  ];
  const ok =
    linkStats.ok ||
    closingHistorical.ok ||
    closingStats.ok ||
    closingKickoff.ok ||
    scores.ok ||
    oddsScores.ok ||
    accas.ok;
  const graded = scores.graded + oddsScores.graded + accas.graded;
  const parts = [
    linked ? `${linked} länkade` : null,
    closingUpdated ? `${closingUpdated} closing` : null,
    graded ? `${graded} rättade` : null,
  ].filter(Boolean);

  const batched =
    linkStats.linked >= SYNC_LINK_LIMIT ||
    closingHistorical.closingUpdated >= SYNC_CLOSING_LIMIT ||
    closingStats.closingUpdated >= SYNC_CLOSING_LIMIT ||
    closingKickoff.closingUpdated >= SYNC_CLOSING_LIMIT ||
    graded >= SYNC_GRADE_LIMIT;
  const suffix = batched ? " Kör synk igen för nästa batch." : "";

  if (!parts.length && details.length) {
    return {
      ok,
      message: `Synk klar — ingen CLV ännu. ${details.slice(0, 3).join(" · ")}`,
      linked,
      graded,
      closingUpdated,
      details,
    };
  }

  return {
    ok,
    message: parts.length
      ? `Synk klar: ${parts.join(", ")}.${suffix}`
      : "Synk klar — inget att uppdatera.",
    linked,
    graded,
    closingUpdated,
    details,
  };
}
