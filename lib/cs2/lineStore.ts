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
import { lineKey, matchHandicapProblem, validateLine, type LineIdentity, type ValidLine } from "./lineInput";
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
  match: { startAt: Date; format: string; team1Id: number | null; team2Id: number | null; team1Name: string; team2Name: string },
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
    return { ...r, playerId, player2Id, teamId, skip: skipReason({ ...r, playerId, player2Id, teamId }) ?? matchHandicapProblem(r, match.format) };
  });
}

/** Det saveLines skriver till: klienten eller en transaktion. */
export type Cs2Writer = Pick<PrismaClient, "cs2Line" | "cs2Projection">;

/**
 * Sparar linjerna och modellens pris på var och en (Cs2Projection). Alla ska gälla ctx:s match.
 *
 * Två anrop oavsett antal linjer: alla linjer, sedan alla priser. Ett anrop
 * mot Neon tar ~100 ms från datorn, och Unibet har 200+ linjer för en Bo3
 * med kartmarknader. Med två anrop per linje hann sparandet inte klart inom
 * transaktionens 30 s (writeChangedLines), och hela matchen rullades tillbaka
 * — Imperial–FlyQuest och 9z–DENDELE fick 0 linjer 2026-11-24.
 */
export async function saveLines(db: Cs2Writer, ctx: MatchupContext, lines: ValidLine[], createdBy: string | null): Promise<PricedLine[]> {
  if (lines.length === 0) return [];
  const created = await db.cs2Line.createManyAndReturn({ data: lines.map((v) => ({ ...v, createdBy })) });
  // Postgres lämnar tillbaka raderna i den ordning de skickades. Ett pris på
  // fel linje vore ett tyst fel i facit, så det kontrolleras ändå.
  const priced = lines.map((v, i) => {
    const row = created[i];
    if (!row || lineKey(row) !== lineKey(v) || row.overOdds !== v.overOdds || row.underOdds !== v.underOdds) {
      throw new Error(`Sparade linjer kom tillbaka i annan ordning (rad ${i}) — modellpriserna sparas inte`);
    }
    const { matchId, ...rest } = v;
    return priceLine(ctx, { ...rest, id: row.id }, DEFAULT_CS2_BLEND_W);
  });
  const projections = priced.flatMap((p, i) => {
    const v = lines[i];
    if (!p.price) return [];
    return [
      {
        matchId: v.matchId,
        lineId: p.id,
        market: v.market,
        scope: v.scope,
        playerId: v.playerId,
        player2Id: v.player2Id,
        teamId: v.teamId,
        line: v.line,
        includesOt: v.includesOt,
        mean: p.mean,
        pModel: p.price.pModel,
        pMarket: p.price.pMarket,
        pFinal: p.price.pFinal,
        fairOver: p.price.fairOver,
        fairUnder: p.price.fairUnder,
        bestSide: p.price.bestSide,
        bestOdds: p.price.bestOdds,
        edgePct: p.price.edge != null ? p.price.edge * 100 : null,
        modelVersion: CS2_MODEL_VERSION,
      },
    ];
  });
  if (projections.length > 0) await db.cs2Projection.createMany({ data: projections });
  return priced;
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

type SavedLineRow = LineIdentity & { id: number; overOdds: number | null; underOdds: number | null };

/** Det writeChangedLines behöver av databasen — en PrismaClient, eller en låtsasdatabas i testerna. */
export interface LockingDb {
  $transaction<R>(fn: (tx: LockingTx) => Promise<R>, opts?: { timeout?: number }): Promise<R>;
}
interface LockingTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  cs2Line: { findMany(args: { where: { matchId: number; bookmaker: string | null }; select: Record<keyof SavedLineRow, true> }): Promise<SavedLineRow[]> };
}

/**
 * Sparar de linjer vars odds är nya eller ändrade, med matchen låst under
 * tiden (pg_advisory_xact_lock). Två hämtningar som går samtidigt läser
 * annars samma "senast sparade" och sparar samma version två gånger.
 * Returnerar antalet sparade.
 */
export async function writeChangedLines<T extends ValidLine>(
  db: LockingDb,
  matchId: number,
  valid: T[],
  save: (tx: LockingTx, toSave: T[]) => Promise<unknown>
): Promise<number> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${matchId})`;
      const saved = await tx.cs2Line.findMany({
        where: { matchId, bookmaker: valid[0]?.bookmaker ?? null },
        select: { id: true, market: true, scope: true, playerId: true, player2Id: true, teamId: true, line: true, overOdds: true, underOdds: true },
      });
      const toSave = changedLines(valid, saved);
      if (toSave.length > 0) await save(tx, toSave);
      return toSave.length;
    },
    { timeout: 30_000 }
  );
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
    select: { id: true, startAt: true, format: true, team1Id: true, team2Id: true, team1Name: true, team2Name: true },
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
      // Snabbkoll utan lås: oftast har inget ändrats, och då behövs varken
      // modellen eller transaktionen.
      if (changedLines(valid, saved).length === 0) {
        sum.unchanged += valid.length;
        log(`${name}: ${valid.length} linjer, inga ändrade odds`);
        continue;
      }
      const ctx = await loadMatchupContext(db, m.id);
      if (!ctx) {
        log(`${name}: matchen saknar lag eller data — sparas inte`);
        continue;
      }
      // Avgörs på nytt under lås — en annan hämtning kan ha hunnit spara samma odds.
      const n = await writeChangedLines(db, m.id, valid, (tx, toSave) => saveLines(tx as unknown as Cs2Writer, ctx, toSave, "auto"));
      sum.saved += n;
      sum.unchanged += valid.length - n;
      log(`${name}: ${n} linjer sparade (${valid.length - n} oförändrade)`);
    } catch (e) {
      sum.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return sum;
}
