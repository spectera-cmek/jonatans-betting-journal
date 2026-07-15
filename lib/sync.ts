// Shared sync logic used by both the API routes and the CLI script.
// Grades finished bets and captures closing odds for CLV.

import { prisma } from "./db";
import { gradeBet } from "./grading";
import { espnPath, fetchFinalScore } from "./scores";
import { settleBet } from "./settlement";
import {
  getScores,
  getOdds,
  bestPriceFor,
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

export interface SyncResult {
  ok: boolean;
  message: string;
  linked: number;
  graded: number;
  closingUpdated: number;
  details: string[];
}

const CLV_WINDOW_DAYS = 14;

/** Auto-link unlinked football bets to TheStatsAPI matches (historical closing odds). */
export async function runLinkStatsApiEvents(): Promise<SyncResult> {
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

  const result = await linkBetsToStatsMatches({ sinceDays: CLV_WINDOW_DAYS });
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
export async function runGradeByScores(): Promise<SyncResult> {
  const details: string[] = [];

  const pending = await prisma.bet.findMany({
    where: {
      outcome: "pending",
      market: { in: ["h2h", "totals", "spreads"] },
      eventAt: { not: null },
      betType: "single",
      eventKind: "match",
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
    },
  });

  if (pending.length === 0) {
    return { ok: true, message: "Inga pending bets att rätta via resultat.", linked: 0, graded: 0, closingUpdated: 0, details };
  }

  let graded = 0;
  for (const bet of pending) {
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

  await prisma.syncLog.create({
    data: { kind: "grade", summary: `Score-graded ${graded} bet(s).` },
  });

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
export async function runClosingFromStatsApi(): Promise<SyncResult> {
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

  const result = await captureClosingOdds({ sinceDays: CLV_WINDOW_DAYS });
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
 * Capture closing odds for bets whose event is near/at kickoff and that don't
 * yet have a closingOdds value. On the free tier we can only read *current*
 * odds, so we snapshot whatever is live closest to commence time.
 */
export async function runClosing(): Promise<SyncResult> {
  const stats = await runClosingFromStatsApi();

  const details = [...stats.details];
  let updated = stats.closingUpdated;

  if (!hasOddsApiKey()) {
    return {
      ok: stats.ok || updated > 0,
      message:
        updated > 0
          ? `Updated closing odds for ${updated} bet(s) via TheStatsAPI.`
          : stats.message,
      linked: 0,
      graded: 0,
      closingUpdated: updated,
      details,
    };
  }

  // Odds API fallback for non-TheStatsAPI-linked bets still missing closing.
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const candidates = await prisma.bet.findMany({
    where: {
      externalRef: { not: null },
      sportKey: { not: null },
      closingOdds: null,
      selection: { not: "" },
      NOT: { externalRef: { startsWith: "mt_" } },
    },
  });

  const relevant = candidates.filter((b) => {
    if (isStatsApiMatchRef(b.externalRef)) return false;
    if (!b.eventAt) return true;
    const t = new Date(b.eventAt).getTime();
    return t >= now - TWO_HOURS && t <= now + SEVEN_DAYS;
  });

  if (relevant.length === 0) {
    return {
      ok: stats.ok || updated > 0,
      message:
        updated > 0
          ? `Updated closing odds for ${updated} bet(s).`
          : "No bets need closing odds right now.",
      linked: 0,
      graded: 0,
      closingUpdated: updated,
      details,
    };
  }

  const bySport = new Map<string, typeof relevant>();
  for (const b of relevant) {
    const arr = bySport.get(b.sportKey!);
    if (arr) arr.push(b);
    else bySport.set(b.sportKey!, [b]);
  }

  let oddsUpdated = 0;
  for (const [sportKey, bets] of bySport) {
    if (sportKey.startsWith("tsa:")) continue;
    const markets = Array.from(new Set(bets.map((b) => b.market || "h2h"))).join(",");
    let events;
    try {
      events = await getOdds(sportKey, { markets });
    } catch (e) {
      details.push(`odds ${sportKey}: ${(e as Error).message}`);
      continue;
    }
    const byId = new Map(events.map((e) => [e.id, e]));

    for (const bet of bets) {
      const ev = byId.get(bet.externalRef!);
      if (!ev) continue;
      const outcomeName = selectionOutcomeName(bet, ev.home_team, ev.away_team);
      if (!outcomeName) continue;
      const price = bestPriceFor(ev, bet.market || "h2h", outcomeName, bet.line ?? undefined);
      if (!price) continue;
      await prisma.bet.update({ where: { id: bet.id }, data: { closingOdds: price } });
      oddsUpdated += 1;
      details.push(`${bet.event}: closing ${price.toFixed(2)} (you took ${bet.odds.toFixed(2)})`);
    }
  }

  updated += oddsUpdated;
  if (oddsUpdated > 0) {
    await prisma.syncLog.create({
      data: { kind: "closing", summary: `Odds API closing for ${oddsUpdated} bet(s).` },
    });
  }

  return {
    ok: true,
    message: `Updated closing odds for ${updated} bet(s).`,
    linked: 0,
    graded: 0,
    closingUpdated: updated,
    details,
  };
}

/** Map a bet's selection to the outcome name used by The Odds API. */
function selectionOutcomeName(
  bet: { selectionSide?: string | null; market: string; homeTeam?: string | null; awayTeam?: string | null; selection: string },
  home: string,
  away: string
): string | null {
  const side = (bet.selectionSide || "").toLowerCase();
  if (bet.market === "h2h") {
    if (side === "home") return home;
    if (side === "away") return away;
    if (side === "draw") return "Draw";
  }
  if (bet.market === "totals") {
    if (side === "over") return "Over";
    if (side === "under") return "Under";
  }
  if (bet.market === "spreads") {
    if (side === "home") return home;
    if (side === "away") return away;
  }
  // Fallback: use the raw selection label.
  return bet.selection || null;
}

export async function runFullSync(): Promise<SyncResult> {
  const linkStats = await runLinkStatsApiEvents();
  const link = await runLinkEvents();
  const closing = await runClosing();
  const grade = hasOddsApiKey()
    ? await runGrade()
    : { ok: true, message: "", linked: 0, graded: 0, closingUpdated: 0, details: [] as string[] };
  const scores = await runGradeByScores();
  const details = [
    ...linkStats.details,
    ...link.details,
    ...closing.details,
    ...grade.details,
    ...scores.details,
  ];
  const ok = linkStats.ok || link.ok || closing.ok || grade.ok || scores.ok;
  const parts = [
    linkStats.linked || link.linked
      ? `${linkStats.linked + link.linked} länkade`
      : null,
    closing.closingUpdated ? `${closing.closingUpdated} closing` : null,
    grade.graded || scores.graded
      ? `${grade.graded + scores.graded} rättade`
      : null,
  ].filter(Boolean);
  return {
    ok,
    message: parts.length ? `Synk klar: ${parts.join(", ")}.` : "Synk klar — inget att uppdatera.",
    linked: linkStats.linked + link.linked,
    graded: grade.graded + scores.graded,
    closingUpdated: closing.closingUpdated,
    details,
  };
}
