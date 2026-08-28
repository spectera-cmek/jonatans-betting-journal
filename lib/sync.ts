// Shared sync logic used by both the API routes and the CLI script.
// Grades finished bets and captures closing odds for CLV.

import { prisma } from "./db";
import { gradeBet } from "./grading";
import { espnPath, fetchFinalScore } from "./scores";
import { settleBet } from "./settlement";
import {
  getScores,
  getOdds,
  parseScores,
  hasOddsApiKey,
  type ScoreEvent,
} from "./oddsApi";
import { linkBetToOddsEvent } from "./eventLink";
import { hasTheStatsApiKey } from "./theStatsApi";
import {
  linkBetsToStatsMatches,
  captureClosingOdds,
  isStatsApiMatchRef,
} from "./clvCapture";
import { captureClosingNearKickoff } from "./clvOddsApi";
import { captureHistoricalClv } from "./clvHistorical";
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

  const cache = new Map<string, Awaited<ReturnType<typeof getOdds>>>();
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
export async function runGrade(): Promise<SyncResult> {
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
  const pending = await prisma.bet.findMany({
    where: {
      outcome: "pending",
      externalRef: { not: null },
      sportKey: { not: null },
      betType: "single",
      eventKind: "match",
    },
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

      const outcome = gradeBet(
        { market: bet.market, selectionSide: bet.selectionSide, line: bet.line },
        parsed
      );
      if (!outcome) {
        details.push(`${bet.event}: market not auto-gradable, settle manually`);
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
        details.push(`${bet.event}: ${parsed.homeScore}-${parsed.awayScore} -> ${outcome}`);
      } catch (error) {
        details.push(`${bet.event}: ${(error as Error).message}`);
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
 * Auto-grade pending structured (h2h/totals/spreads) single bets from the real
 * final score, fetched from ESPN's free, keyless scoreboard endpoints. Works
 * without any API key. Imported rich-market accumulators won't qualify (their
 * market isn't h2h/totals/spreads) and are left for the PDF import / manual W/L.
 */
export async function runGradeByScores(
  opts: { limit?: number; deadlineMs?: number } = {}
): Promise<SyncResult> {
  const details: string[] = [];
  const limit = opts.limit ?? SYNC_GRADE_LIMIT;
  const deadline = opts.deadlineMs ?? Date.now() + SYNC_DEADLINE_MS;

  const pending = await prisma.bet.findMany({
    where: {
      outcome: "pending",
      market: { in: ["h2h", "totals", "spreads"] },
      eventAt: { not: null },
      betType: "single",
      eventKind: "match",
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
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
    const path = espnPath(bet.sport, bet.league);
    if (!path) {
      details.push(`${bet.event}: okänd liga för resultat-uppslag`);
      continue;
    }
    if (!bet.homeTeam || !bet.awayTeam) {
      details.push(`${bet.event}: saknar lagnamn (home/away)`);
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
      details.push(`${bet.event}: ${(e as Error).message}`);
      continue;
    }
    if (!score) {
      details.push(`${bet.event}: inget färdigspelat resultat hittat ännu`);
      continue;
    }
    if (score.wentToExtraTime) {
      details.push(`${bet.event}: förlängning/straffar — kräver manuell kontroll av 90-minutersmarknaden`);
      continue;
    }

    const outcome = gradeBet(
      { market: bet.market, selectionSide: bet.selectionSide, line: bet.line },
      score
    );
    if (!outcome) {
      details.push(`${bet.event}: marknaden kan inte auto-rättas`);
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
      details.push(`${bet.event}: ${score.homeScore}-${score.awayScore} -> ${outcome}`);
    } catch (error) {
      details.push(`${bet.event}: ${(error as Error).message}`);
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
 * Historisk CLV via The Odds API — closing i efterhand, utan tidsfönster.
 *
 * Den här vägen är den enda som fungerar för spel vars avspark redan passerat,
 * vilket är de allra flesta när man synkar för hand. Cronjobbet i
 * app/api/cron/clv kör samma funktion med större tak.
 */
export async function runClosingHistorical(
  opts: { limit?: number; maxCredits?: number; deadlineMs?: number; dryRun?: boolean } = {}
): Promise<SyncResult> {
  if (!hasOddsApiKey()) {
    return {
      ok: false,
      message: "No ODDS_API_KEY set — cannot capture historical CLV.",
      linked: 0,
      graded: 0,
      closingUpdated: 0,
      details: [],
    };
  }

  const result = await captureHistoricalClv({
    sinceDays: CLV_WINDOW_DAYS,
    limit: opts.limit ?? 25,
    maxCredits: opts.maxCredits ?? 600,
    deadlineMs: opts.deadlineMs,
    dryRun: opts.dryRun,
  });

  if (result.closingUpdated > 0 && !opts.dryRun) {
    await prisma.syncLog.create({
      data: {
        kind: "closing",
        summary: `Historisk CLV för ${result.closingUpdated} bet(s), ${result.creditsSpent} krediter.`,
      },
    });
  }

  return {
    ok: true,
    message: `Historisk CLV: ${result.closingUpdated} closing (${result.creditsSpent} krediter, ${result.remaining ?? "?"} kvar).`,
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

  // Odds API-vägarna körs alltid när nyckeln finns. Tidigare hoppades de över så
  // fort TheStatsAPI hade hittat något — men de täcker olika spel (TheStatsAPI
  // bara fotboll), så en enda fotbollsträff kunde blockera all annan CLV.
  if (hasOddsApiKey()) {
    const kickoff = await runClosingNearKickoff({ limit: SYNC_CLOSING_LIMIT });
    details.push(...kickoff.details);
    updated += kickoff.closingUpdated;
    linked += kickoff.linked;
    ok = ok || kickoff.ok || kickoff.closingUpdated > 0;

    // Det mesta ligger bakom avspark och nås bara historiskt.
    const historical = await runClosingHistorical({ limit: SYNC_CLOSING_LIMIT });
    details.push(...historical.details);
    updated += historical.closingUpdated;
    linked += historical.linked;
    ok = ok || historical.ok || historical.closingUpdated > 0;
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

  const closingStats = hasTheStatsApiKey()
    ? await runClosingFromStatsApi({ limit: SYNC_CLOSING_LIMIT })
    : { ok: true, message: "", linked: 0, graded: 0, closingUpdated: 0, details: [] as string[] };

  // Se runClosing(): Odds API-vägarna gäller andra spel än TheStatsAPI och får
  // inte hoppas över bara för att fotbollsvägen råkade hitta något.
  const closingKickoff =
    hasOddsApiKey() && Date.now() < deadline
      ? await runClosingNearKickoff({ limit: SYNC_CLOSING_LIMIT })
      : { ok: true, message: "", linked: 0, graded: 0, closingUpdated: 0, details: [] as string[] };

  const closingHistorical =
    hasOddsApiKey() && Date.now() < deadline
      ? await runClosingHistorical({ limit: SYNC_CLOSING_LIMIT, deadlineMs: deadline })
      : { ok: true, message: "", linked: 0, graded: 0, closingUpdated: 0, details: [] as string[] };

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

  const linked = linkStats.linked + closingKickoff.linked + closingHistorical.linked;
  const closingUpdated =
    closingStats.closingUpdated +
    closingKickoff.closingUpdated +
    closingHistorical.closingUpdated;
  const details = [
    ...linkStats.details,
    ...closingStats.details,
    ...closingKickoff.details,
    ...closingHistorical.details,
    ...scores.details,
  ];
  const ok =
    linkStats.ok || closingStats.ok || closingKickoff.ok || closingHistorical.ok || scores.ok;
  const parts = [
    linked ? `${linked} länkade` : null,
    closingUpdated ? `${closingUpdated} closing` : null,
    scores.graded ? `${scores.graded} rättade` : null,
  ].filter(Boolean);

  const batched =
    linkStats.linked >= SYNC_LINK_LIMIT ||
    closingStats.closingUpdated >= SYNC_CLOSING_LIMIT ||
    closingKickoff.closingUpdated >= SYNC_CLOSING_LIMIT ||
    closingHistorical.closingUpdated >= SYNC_CLOSING_LIMIT ||
    scores.graded >= SYNC_GRADE_LIMIT;
  const suffix = batched ? " Kör synk igen för nästa batch." : "";

  if (!parts.length && details.length) {
    return {
      ok,
      message: `Synk klar — ingen CLV ännu. ${details.slice(0, 3).join(" · ")}`,
      linked,
      graded: scores.graded,
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
    graded: scores.graded,
    closingUpdated,
    details,
  };
}
