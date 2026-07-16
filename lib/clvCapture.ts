// Link football bets to TheStatsAPI matches and capture historical closing odds (CLV).
// Uses Swedish team aliases from lib/worldCup.ts and fetches last_seen after kickoff.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db";
import { parseHomeAway } from "./eventLink";
import { teamNamesMatch } from "./worldCup";
import {
  getMatchOdds,
  getPlayerPropOdds,
  hasTheStatsApiKey,
  isStatsApiMatchRef,
  isStatsApiSportKey,
  listMatches,
  parseOddsValue,
  pickBookmakerOdds,
  searchCompetitions,
  statsApiSportKey,
  type BookmakerMatchOdds,
  type MatchOddsResponse,
  type MatchPlayerOddsResponse,
  type PlayerPropMarket,
  type StatsMatch,
} from "./theStatsApi";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;

/** league label (lowercase) → TheStatsAPI competition search term */
const LEAGUE_SEARCH: Record<string, string> = {
  "premier league": "Premier League",
  epl: "Premier League",
  "la liga": "La Liga",
  "serie a": "Serie A",
  bundesliga: "Bundesliga",
  "ligue 1": "Ligue 1",
  "champions league": "UEFA Champions League",
  allsvenskan: "Allsvenskan",
  "vm 2026": "FIFA World Cup",
  "world cup": "FIFA World Cup",
  mls: "Major League Soccer",
  championship: "Championship",
};

export interface ClvBet {
  id: string;
  event: string;
  homeTeam?: string | null;
  awayTeam?: string | null;
  eventAt?: Date | null;
  sport?: string | null;
  league?: string | null;
  market: string;
  marketCategory?: string | null;
  marketScope?: string | null;
  selection: string;
  selectionSide?: string | null;
  line?: number | null;
  odds: number;
  bookmaker?: string | null;
  externalRef?: string | null;
  sportKey?: string | null;
  closingOdds?: number | null;
  eventKind?: string | null;
  betType?: string | null;
}

export interface ClvCaptureOptions {
  sinceDays?: number;
  sinceDate?: Date;
  limit?: number;
  dryRun?: boolean;
  prisma?: PrismaClient;
}

export interface ClvCaptureResult {
  linked: number;
  closingUpdated: number;
  details: string[];
}

function isFootballBet(bet: { sport?: string | null; league?: string | null }): boolean {
  const sport = (bet.sport || "").toLowerCase();
  if (sport === "football" || sport === "soccer" || sport === "fotboll") return true;
  // Imported bets sometimes miss sport but have a football league label.
  const league = (bet.league || "").toLowerCase();
  return Object.keys(LEAGUE_SEARCH).some((k) => league.includes(k) || k.includes(league));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

async function resolveCompetitionId(league: string | null | undefined): Promise<string | null> {
  if (!league) return null;
  const key = league.toLowerCase();
  const search = LEAGUE_SEARCH[key] ?? league;
  try {
    const comps = await searchCompetitions(search);
    if (comps.length === 0) return null;
    const needle = search.toLowerCase();
    const exact = comps.find((c) => c.name.toLowerCase() === needle);
    if (exact) return exact.id;
    // Prefer names that equal/start with the search term over "2. Bundesliga" etc.
    const preferred = comps.find(
      (c) =>
        c.name.toLowerCase() === needle ||
        c.name.toLowerCase().startsWith(needle + " ") ||
        c.name.toLowerCase().endsWith(" " + needle)
    );
    return (preferred ?? comps[0]).id;
  } catch {
    return null;
  }
}

const competitionCache = new Map<string, string | null>();

async function competitionIdForLeague(league: string | null | undefined): Promise<string | null> {
  const key = (league || "").toLowerCase();
  if (!key) return null;
  if (competitionCache.has(key)) return competitionCache.get(key)!;
  const id = await resolveCompetitionId(league);
  competitionCache.set(key, id);
  return id;
}

/** Find the best TheStatsAPI match for a bet. */
export function matchStatsEvent(
  bet: Pick<ClvBet, "homeTeam" | "awayTeam" | "eventAt" | "event">,
  matches: StatsMatch[]
): StatsMatch | null {
  let home = bet.homeTeam?.trim() || "";
  let away = bet.awayTeam?.trim() || "";
  if (!home || !away) {
    const parsed = parseHomeAway(bet.event);
    if (parsed) {
      home = parsed.home;
      away = parsed.away;
    }
  }
  if (!home || !away) return null;

  const betTime = bet.eventAt ? new Date(bet.eventAt).getTime() : null;

  const candidates = matches.filter((m) => {
    const direct =
      teamNamesMatch(home, m.home_team.name) && teamNamesMatch(away, m.away_team.name);
    const swapped =
      teamNamesMatch(home, m.away_team.name) && teamNamesMatch(away, m.home_team.name);
    if (!direct && !swapped) return false;
    if (betTime == null) return true;
    const kickoff = new Date(m.utc_date).getTime();
    return Math.abs(kickoff - betTime) <= 2 * DAY_MS;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (betTime != null) {
    candidates.sort(
      (a, b) =>
        Math.abs(new Date(a.utc_date).getTime() - betTime) -
        Math.abs(new Date(b.utc_date).getTime() - betTime)
    );
    const best = candidates[0];
    const second = candidates[1];
    const gap =
      Math.abs(new Date(best.utc_date).getTime() - betTime) -
      Math.abs(new Date(second.utc_date).getTime() - betTime);
    if (gap >= 6 * 60 * 60 * 1000) return best;
  }
  return null;
}

function asianHandicapKey(line: number, side: "home" | "away"): string | null {
  // TheStatsAPI uses signed strings like "-0.5", "+0.0", "+0.25".
  const signed = side === "home" ? line : -line;
  if (signed === 0) return "+0.0";
  const formatted = signed > 0 ? `+${signed}` : String(signed);
  // Normalize quarter lines: 0.25 → +0.25, -0.25 stays
  return formatted;
}

function findLineKey(keys: string[], line: number): string | null {
  if (line == null) return null;
  const target = String(line);
  const exact = keys.find((k) => k === target || k === target.replace(/\.0$/, ""));
  if (exact) return exact;
  const num = keys.find((k) => Math.abs(Number(k) - line) < 0.001);
  return num ?? null;
}

function playerPropMarket(bet: ClvBet): PlayerPropMarket | null {
  const cat = (bet.marketCategory || "").toLowerCase();
  const sel = bet.selection.toLowerCase();
  if (cat.includes("skott på mål") || sel.includes("sog") || sel.includes("shots on target")) {
    return "player_shots_on_target";
  }
  if (cat.includes("skott") || sel.includes("shots")) return "player_shots";
  if (cat.includes("assist")) return "player_assists";
  if (cat.includes("första mål") || sel.includes("first goal")) return "first_goalscorer";
  if (cat.includes("mål") || cat.includes("goalscorer") || sel.includes("goalscorer")) {
    return "anytime_goalscorer";
  }
  return null;
}

function playerNameFromSelection(selection: string): string {
  // "Mohamed Salah Över 1.5 skott" → "Mohamed Salah"
  return selection
    .replace(/\b(över|under|over|under)\b.*/i, "")
    .replace(/\b\d+(\.\d+)?\b.*/i, "")
    .replace(/\b(skott|mål|sog|shots|goals?|assists?)\b.*/i, "")
    .trim();
}

function playerNamesMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-zåäöéü ]/gi, " ").replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-zåäöéü ]/gi, " ").replace(/\s+/g, " ").trim();
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const aLast = na.split(" ").pop()!;
  const bLast = nb.split(" ").pop()!;
  return aLast.length >= 3 && aLast === bLast;
}

/** Extract closing (last_seen) odds for a bet from match-level odds data. */
export function closingOddsFromMatchOdds(
  bet: ClvBet,
  odds: MatchOddsResponse,
  homeTeam: string,
  awayTeam: string
): number | null {
  const bk = pickBookmakerOdds(odds.bookmakers, bet.bookmaker);
  if (!bk) return null;
  const m = bk.markets;
  const side = (bet.selectionSide || "").toLowerCase();
  const cat = (bet.marketCategory || "").toLowerCase();

  // 1X2 / h2h
  if (bet.market === "h2h" || cat.includes("matchvinnare") || cat === "1x2") {
    if (side === "draw") return parseOddsValue(m.match_odds?.draw);
    if (side === "home") return parseOddsValue(m.match_odds?.home);
    if (side === "away") return parseOddsValue(m.match_odds?.away);
    // Infer from selection text
    if (/oavgjort|draw|x\b/i.test(bet.selection)) return parseOddsValue(m.match_odds?.draw);
    if (teamNamesMatch(bet.selection, homeTeam)) return parseOddsValue(m.match_odds?.home);
    if (teamNamesMatch(bet.selection, awayTeam)) return parseOddsValue(m.match_odds?.away);
  }

  // BTTS
  if (cat.includes("btts") || /btts|båda.*mål|both teams/i.test(bet.selection)) {
    const yes = /ja|yes|gg/i.test(bet.selection) || side === "over";
    const no = /nej|no|ng/i.test(bet.selection) || side === "under";
    if (yes) return parseOddsValue(m.btts?.yes);
    if (no) return parseOddsValue(m.btts?.no);
  }

  // Totals (goals)
  if (bet.market === "totals" || cat === "totalt" || cat.includes("total")) {
    const keys = Object.keys(m.total_goals || {});
    const lineKey = findLineKey(keys, bet.line ?? NaN);
    if (!lineKey) return null;
    const ou = m.total_goals![lineKey];
    if (side === "over" || /över|over/i.test(bet.selection)) return parseOddsValue(ou.over);
    if (side === "under" || /under/i.test(bet.selection)) return parseOddsValue(ou.under);
  }

  // Corners
  if (cat.includes("hörn") || cat.includes("corner")) {
    const keys = Object.keys(m.match_corners || {});
    const lineKey = findLineKey(keys, bet.line ?? NaN);
    if (!lineKey) return null;
    const ou = m.match_corners![lineKey];
    if (side === "over" || /över|over/i.test(bet.selection)) return parseOddsValue(ou.over);
    if (side === "under" || /under/i.test(bet.selection)) return parseOddsValue(ou.under);
  }

  // Asian handicap / spreads
  if (bet.market === "spreads" || cat.includes("handikapp") || cat.includes("handicap")) {
    const ah = m.asian_handicap;
    if (!ah || bet.line == null) return null;
    const handicapSide = side === "away" ? "away" : "home";
    const lines = ah[handicapSide];
    if (!lines) return null;
    const key = asianHandicapKey(bet.line, handicapSide);
    const altKeys = [
      key,
      key?.replace("+", ""),
      bet.line > 0 ? `+${bet.line}` : String(bet.line),
      String(bet.line),
    ].filter(Boolean) as string[];
    for (const k of altKeys) {
      if (lines[k]) return parseOddsValue(lines[k]);
    }
    const fuzzy = Object.entries(lines).find(([k]) => Math.abs(Number(k) - bet.line!) < 0.001);
    if (fuzzy) return parseOddsValue(fuzzy[1]);
  }

  return null;
}

/** Extract closing odds for Bet365 player props. */
export function closingOddsFromPlayerProps(bet: ClvBet, props: MatchPlayerOddsResponse): number | null {
  const marketKey = playerPropMarket(bet);
  if (!marketKey) return null;
  const market = props.markets.find((m) => m.name === marketKey);
  if (!market) return null;

  const playerQuery = playerNameFromSelection(bet.selection);
  const side = (bet.selectionSide || "").toLowerCase();
  const wantOver = side === "over" || /över|over/i.test(bet.selection);
  const line = bet.line ?? extractLineFromSelection(bet.selection);

  const candidates = market.players.filter((p) => playerNamesMatch(playerQuery, p.name));
  if (!candidates.length) return null;

  for (const p of candidates) {
    if (line != null && p.line != null && Math.abs(p.line - line) > 0.001) continue;
    if (marketKey === "first_goalscorer" || marketKey === "anytime_goalscorer") {
      return p.odd > 1 ? p.odd : null;
    }
    if (wantOver && p.market_type === "Over") return p.odd > 1 ? p.odd : null;
    if (!wantOver && p.market_type === "Under") return p.odd > 1 ? p.odd : null;
  }

  // Flat goalscorer: take first matching player
  if (marketKey === "anytime_goalscorer" || marketKey === "first_goalscorer") {
    return candidates[0]?.odd > 1 ? candidates[0].odd : null;
  }
  return null;
}

function extractLineFromSelection(selection: string): number | null {
  const m = selection.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** True when kickoff has passed — closing last_seen is meaningful. */
export function isAfterKickoff(eventAt: Date | null | undefined, graceMinutes = 5): boolean {
  if (!eventAt) return true; // unknown kickoff but linked → try historical closing
  return Date.now() >= new Date(eventAt).getTime() + graceMinutes * 60 * 1000;
}

function betNeedsPlayerProps(bet: ClvBet): boolean {
  return bet.marketScope === "player" || playerPropMarket(bet) !== null;
}

/** Fetch closing odds for one linked bet. */
export async function fetchClosingForBet(
  bet: ClvBet,
  match?: StatsMatch
): Promise<{ closing: number | null; detail?: string }> {
  if (!bet.externalRef || !isStatsApiMatchRef(bet.externalRef)) {
    return { closing: null };
  }
  if (!isAfterKickoff(bet.eventAt)) {
    return { closing: null, detail: `${bet.event}: väntar på avspark` };
  }

  try {
    if (betNeedsPlayerProps(bet)) {
      const market = playerPropMarket(bet);
      const props = await getPlayerPropOdds(bet.externalRef, {
        markets: market ? [market] : undefined,
        bookmaker: "bet365",
      });
      const closing = closingOddsFromPlayerProps(bet, props);
      return { closing, detail: closing ? undefined : `${bet.event}: ingen player-prop closing` };
    }

    const odds = await getMatchOdds(bet.externalRef);
    const home = match?.home_team.name ?? bet.homeTeam ?? "";
    const away = match?.away_team.name ?? bet.awayTeam ?? "";
    const closing = closingOddsFromMatchOdds(bet, odds, home, away);
    return { closing, detail: closing ? undefined : `${bet.event}: ingen match-odds closing` };
  } catch (e) {
    return { closing: null, detail: `${bet.event}: ${(e as Error).message}` };
  }
}

async function fetchMatchesForBet(
  bet: Pick<ClvBet, "league" | "eventAt">,
  _windowDays: number
): Promise<StatsMatch[]> {
  const competitionId = await competitionIdForLeague(bet.league);
  const center = bet.eventAt ? new Date(bet.eventAt) : new Date();
  const dateFrom = formatDate(addDays(center, -2));
  const dateTo = formatDate(addDays(center, 2));

  // Single page only — a ±2 day window rarely needs pagination and keeps sync fast.
  const res = await listMatches({
    competitionId: competitionId ?? undefined,
    dateFrom,
    dateTo,
    perPage: 50,
  });
  return res.data;
}

/** Link unlinked football bets to TheStatsAPI matches. */
export async function linkBetsToStatsMatches(
  options: ClvCaptureOptions = {}
): Promise<ClvCaptureResult> {
  const db = options.prisma ?? defaultPrisma;
  const details: string[] = [];
  if (!hasTheStatsApiKey()) {
    return { linked: 0, closingUpdated: 0, details: ["No THESTATSAPI_KEY set."] };
  }

  const since =
    options.sinceDate ??
    addDays(new Date(), -(options.sinceDays ?? DEFAULT_WINDOW_DAYS));

  // Football singles missing closingOdds. Re-link Odds API refs to mt_* so
  // historical CLV can run (ESPN still grades football without Odds API).
  const candidates = await db.bet.findMany({
    where: {
      eventKind: "match",
      betType: "single",
      closingOdds: null,
      OR: [
        { eventAt: { gte: since } },
        { eventAt: null, placedAt: { gte: since } },
      ],
      AND: [
        {
          OR: [
            { externalRef: null },
            { NOT: { externalRef: { startsWith: "mt_" } } },
          ],
        },
      ],
    },
    select: {
      id: true,
      event: true,
      homeTeam: true,
      awayTeam: true,
      eventAt: true,
      sport: true,
      league: true,
      externalRef: true,
      sportKey: true,
    },
    take: options.limit ?? 12,
    orderBy: [{ eventAt: "desc" }, { placedAt: "desc" }],
  });

  const footballCandidates = candidates.filter(isFootballBet);
  if (footballCandidates.length === 0) {
    details.push("Inga fotbollsbets utan closingOdds i fönstret att länka.");
    return { linked: 0, closingUpdated: 0, details };
  }
  details.push(`${footballCandidates.length} kandidater att länka`);

  const matchCache = new Map<string, StatsMatch[]>();
  let linked = 0;

  for (const bet of footballCandidates) {
    const cacheKey = `${bet.league}|${bet.eventAt?.toISOString().slice(0, 10) ?? "nodate"}`;
    let matches = matchCache.get(cacheKey);
    if (!matches) {
      try {
        matches = await fetchMatchesForBet(bet, options.sinceDays ?? DEFAULT_WINDOW_DAYS);
        matchCache.set(cacheKey, matches);
      } catch (e) {
        details.push(`${bet.event}: matchlista ${(e as Error).message}`);
        continue;
      }
    }

    const match = matchStatsEvent(bet, matches);
    if (!match) {
      details.push(`${bet.event}: ingen match i API (${matches.length} matcher i fönstret)`);
      continue;
    }

    const parsed = parseHomeAway(bet.event);
    const homeTeam = bet.homeTeam || parsed?.home || match.home_team.name;
    const awayTeam = bet.awayTeam || parsed?.away || match.away_team.name;
    const eventAt = bet.eventAt ?? new Date(match.utc_date);
    const sportKey = statsApiSportKey(match.competition_id);

    if (!options.dryRun) {
      await db.bet.update({
        where: { id: bet.id },
        data: {
          externalRef: match.id,
          sportKey,
          homeTeam,
          awayTeam,
          eventAt,
          sport: bet.sport || "Football",
        },
      });
    }
    linked += 1;
    details.push(`${bet.event}: länkad → ${match.id} (${match.competition_id})`);
  }

  return { linked, closingUpdated: 0, details };
}

/** Capture closing odds for linked bets (after kickoff, within window). */
export async function captureClosingOdds(
  options: ClvCaptureOptions = {}
): Promise<ClvCaptureResult> {
  const db = options.prisma ?? defaultPrisma;
  const details: string[] = [];
  if (!hasTheStatsApiKey()) {
    return { linked: 0, closingUpdated: 0, details: ["No THESTATSAPI_KEY set."] };
  }

  const since =
    options.sinceDate ??
    addDays(new Date(), -(options.sinceDays ?? DEFAULT_WINDOW_DAYS));

  const candidates = await db.bet.findMany({
    where: {
      externalRef: { startsWith: "mt_" },
      closingOdds: null,
      selection: { not: "" },
      OR: [
        { eventAt: { gte: since, lte: new Date() } },
        // Linked but kickoff unknown — still try after we have mt_ ref
        { eventAt: null },
      ],
    },
    take: options.limit ?? 10,
    orderBy: { eventAt: "desc" },
  });

  if (candidates.length === 0) {
    details.push("Inga länkade bets (mt_*) saknar closingOdds i fönstret.");
  } else {
    details.push(`${candidates.length} länkade bets att hämta closing för`);
  }

  let closingUpdated = 0;
  const matchCache = new Map<string, StatsMatch>();

  for (const bet of candidates) {
    if (!isAfterKickoff(bet.eventAt)) {
      details.push(`${bet.event}: före avspark — hoppar`);
      continue;
    }

    let match = matchCache.get(bet.externalRef!);
    if (!match) {
      // We don't need full match fetch for odds — only for team names in h2h
    }

    const { closing, detail } = await fetchClosingForBet(bet, match);
    if (detail) details.push(detail);
    if (!closing) continue;

    if (!options.dryRun) {
      await db.bet.update({
        where: { id: bet.id },
        data: { closingOdds: closing },
      });
    }
    closingUpdated += 1;
    details.push(
      `${bet.event}: closing ${closing.toFixed(2)} (du ${bet.odds.toFixed(2)})${options.dryRun ? " [dry-run]" : ""}`
    );
  }

  return { linked: 0, closingUpdated, details };
}

/** Full CLV pipeline: link + capture. */
export async function runStatsApiClv(
  options: ClvCaptureOptions = {}
): Promise<ClvCaptureResult> {
  const link = await linkBetsToStatsMatches(options);
  const closing = await captureClosingOdds(options);
  return {
    linked: link.linked,
    closingUpdated: closing.closingUpdated,
    details: [...link.details, ...closing.details],
  };
}

/** Exported for tests — resolve market from bookmaker odds blob. */
export function extractClosingOdds(
  bet: ClvBet,
  matchOdds: BookmakerMatchOdds,
  homeTeam: string,
  awayTeam: string
): number | null {
  return closingOddsFromMatchOdds(
    bet,
    { match_id: "", bookmakers: [matchOdds] },
    homeTeam,
    awayTeam
  );
}

export { isStatsApiMatchRef, isStatsApiSportKey };
