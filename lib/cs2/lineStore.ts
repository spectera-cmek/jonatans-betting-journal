// Server-only: sparar bokmakarlinjer med modellens pris, och hämtar Unibets
// (Kambis) linjer för kommande matcher automatiskt. Delas av POST
// /api/cs2/lines, POST /api/cs2/lines/fetch-kambi och `npm run cs2:update`,
// så att en linje sparas likadant oavsett väg in.
//
// Den automatiska hämtningen finns för facit: varje sparad linje prissätts
// och avgörs när matchen spelats, så fler linjer betyder säkrare facit.
// Samma linje sparas i en ny version bara när oddsen ändrats — facit räknar
// den senaste versionen (se latestPerLine i settle.ts).

import type { PrismaClient } from ".prisma/cs2-client";
import { fetchBetOffers, fetchCs2Events, findKambiEvent, KAMBI_BOOKMAKER, mapBetOffers, type KambiEvent } from "./kambi";
import { lineKey, validateLine, type LineIdentity, type ValidLine } from "./lineInput";
import { loadMatchupContext, priceLine, type MatchupContext, type PricedLine } from "./matchup";
import { CS2_MODEL_VERSION, DEFAULT_CS2_BLEND_W } from "./pricing";
import type { ParsedPropRow } from "./propsExtract";
import { matchPlayer, matchTeams, skipReason } from "./propsMatch";

export type MatchedPropRow = ParsedPropRow & { playerId: number | null; player2Id: number | null; teamId: number | null; skip: string | null };

/**
 * Unibets marknader för en match, kopplade till matchens lag och spelare.
 * null när Unibet inte har matchen. `skip` säger varför en rad inte kan sparas.
 */
export async function kambiRowsForMatch(
  db: PrismaClient,
  match: { startAt: Date; team1Id: number | null; team2Id: number | null; team1Name: string; team2Name: string },
  events: KambiEvent[]
): Promise<MatchedPropRow[] | null> {
  const teams = [
    ...(match.team1Id != null ? [{ id: match.team1Id, name: match.team1Name }] : []),
    ...(match.team2Id != null ? [{ id: match.team2Id, name: match.team2Name }] : []),
  ];
  const event = findKambiEvent({ startAt: match.startAt, teams }, events);
  if (!event) return null;
  const players = await db.cs2Player.findMany({ where: { teamId: { in: teams.map((t) => t.id) } }, select: { id: true, nickname: true, teamId: true } });
  // Marknader utanför modellen (udda/jämnt, övertid, exakt resultat …) är bara brus här.
  const parsed = mapBetOffers(await fetchBetOffers(event.id), event).filter((r) => r.market !== "other");
  const teamOf = matchTeams(parsed.map((r) => r.team), teams);
  return parsed.map((r) => {
    const playerId = matchPlayer(r.player, players);
    const player2Id = matchPlayer(r.player2, players);
    const teamId = r.team ? teamOf.get(r.team) ?? null : null;
    return { ...r, playerId, player2Id, teamId, skip: skipReason({ ...r, playerId, player2Id, teamId }) };
  });
}

/** Sparar linjerna och modellens pris på var och en (Cs2Projection). Alla ska gälla ctx:s match. */
export async function saveLines(db: PrismaClient, ctx: MatchupContext, lines: ValidLine[], createdBy: string | null): Promise<PricedLine[]> {
  const out: PricedLine[] = [];
  for (const v of lines) {
    const { matchId, ...rest } = v;
    const line = await db.cs2Line.create({ data: { ...v, createdBy } });
    const priced = priceLine(ctx, { ...rest, id: line.id }, DEFAULT_CS2_BLEND_W);
    if (priced.price) {
      await db.cs2Projection.create({
        data: {
          matchId,
          lineId: line.id,
          market: v.market,
          scope: v.scope,
          playerId: v.playerId,
          player2Id: v.player2Id,
          teamId: v.teamId,
          line: v.line,
          includesOt: v.includesOt,
          mean: priced.mean,
          pModel: priced.price.pModel,
          pMarket: priced.price.pMarket,
          pFinal: priced.price.pFinal,
          fairOver: priced.price.fairOver,
          fairUnder: priced.price.fairUnder,
          bestSide: priced.price.bestSide,
          bestOdds: priced.price.bestOdds,
          edgePct: priced.price.edge != null ? priced.price.edge * 100 : null,
          modelVersion: CS2_MODEL_VERSION,
        },
      });
    }
    out.push(priced);
  }
  return out;
}

/**
 * Raderna som ska sparas: nya linjer och linjer vars odds ändrats sedan den
 * senast sparade versionen. `saved` ska vara bokens tidigare linjer för matchen.
 */
export function changedLines<T extends LineIdentity & { overOdds: number | null; underOdds: number | null }>(
  rows: T[],
  saved: Array<LineIdentity & { id: number; overOdds: number | null; underOdds: number | null }>
): T[] {
  const latest = new Map<string, { id: number; overOdds: number | null; underOdds: number | null }>();
  for (const s of saved) {
    const k = lineKey(s);
    const prev = latest.get(k);
    if (!prev || s.id > prev.id) latest.set(k, s);
  }
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = lineKey(r);
    if (seen.has(k)) return false; // samma linje två gånger i bokens svar
    seen.add(k);
    const prev = latest.get(k);
    return !prev || prev.overOdds !== r.overOdds || prev.underOdds !== r.underOdds;
  });
}

export interface CaptureOptions {
  /** Matcher som startar inom så många dagar. */
  days: number;
  /** Bara matcher där minst ett lag bevakas (topp N i rankingen). */
  trackedOnly: boolean;
  /** Paus mellan matcherna, så att Kambi inte belastas i onödan. */
  delayMs?: number;
}

export interface CaptureSummary {
  matches: number;
  /** Matcher Unibet hade i sitt utbud. */
  found: number;
  /** Nya linjer eller nya versioner. */
  saved: number;
  /** Linjer vars odds var oförändrade sedan förra hämtningen. */
  unchanged: number;
  /** Rader som inte kunde kopplas till spelare/lag eller saknar modell. */
  skipped: number;
  errors: string[];
}

/**
 * Hämtar och sparar Unibets linjer för kommande matcher. Matcher som redan
 * startat hoppas över — liveodds hör inte hemma i facit.
 */
export async function captureKambiLines(db: PrismaClient, opts: CaptureOptions, log: (msg: string) => void = () => {}): Promise<CaptureSummary> {
  const now = new Date();
  const until = new Date(now.getTime() + opts.days * 86_400_000);
  const tracked = opts.trackedOnly ? (await db.cs2Team.findMany({ where: { tracked: true }, select: { id: true } })).map((t) => t.id) : null;
  const matches = await db.cs2Match.findMany({
    where: {
      status: "scheduled",
      startAt: { gt: now, lte: until },
      team1Id: { not: null },
      team2Id: { not: null },
      ...(tracked ? { OR: [{ team1Id: { in: tracked } }, { team2Id: { in: tracked } }] } : {}),
    },
    select: { id: true, startAt: true, team1Id: true, team2Id: true, team1Name: true, team2Name: true },
    orderBy: { startAt: "asc" },
  });
  const sum: CaptureSummary = { matches: matches.length, found: 0, saved: 0, unchanged: 0, skipped: 0, errors: [] };
  if (matches.length === 0) return sum;

  const events = await fetchCs2Events();
  for (const [i, m] of matches.entries()) {
    if (i > 0 && opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const name = `${m.team1Name} – ${m.team2Name}`;
    try {
      const rows = await kambiRowsForMatch(db, m, events);
      if (!rows) {
        log(`${name}: finns inte hos ${KAMBI_BOOKMAKER}`);
        continue;
      }
      sum.found++;
      const valid: ValidLine[] = [];
      for (const r of rows) {
        const v = r.skip ? r.skip : validateLine({ ...r, matchId: m.id, includesOt: r.includesOt ?? true, bookmaker: KAMBI_BOOKMAKER, source: "kambi" });
        if (typeof v === "string") sum.skipped++;
        else valid.push(v);
      }
      const saved = await db.cs2Line.findMany({
        where: { matchId: m.id, bookmaker: KAMBI_BOOKMAKER },
        select: { id: true, market: true, scope: true, playerId: true, player2Id: true, teamId: true, line: true, overOdds: true, underOdds: true },
      });
      const toSave = changedLines(valid, saved);
      sum.unchanged += valid.length - toSave.length;
      if (toSave.length === 0) {
        log(`${name}: ${valid.length} linjer, inga ändrade odds`);
        continue;
      }
      const ctx = await loadMatchupContext(db, m.id);
      if (!ctx) {
        log(`${name}: matchen saknar lag eller data — sparas inte`);
        continue;
      }
      await saveLines(db, ctx, toSave, "auto");
      sum.saved += toSave.length;
      log(`${name}: ${toSave.length} linjer sparade (${valid.length - toSave.length} oförändrade)`);
    } catch (e) {
      sum.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return sum;
}
