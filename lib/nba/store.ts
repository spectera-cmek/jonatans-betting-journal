// Skriver ESPN-data till NBA-databasen och läser tillbaka historiken som
// modellen räknar på.

import type { NbaPrisma } from "../nbaDb";
import type { EspnGame, EspnInjury, EspnSummary } from "./espn";
import type { StintParse } from "./stints";
import type { RapmFit, StintRow } from "./rapm";
import { buildHistory, type History, type PlayerGameRow, type TeamGameRow } from "./ratings";
import { withDbRetry } from "../nbaDbRetry";

export async function upsertGames(db: NbaPrisma, games: EspnGame[]): Promise<number> {
  let n = 0;
  for (const g of games) {
    for (const t of [g.home, g.away]) {
      if (!t.id) continue;
      await db.nbaTeam.upsert({ where: { id: t.id }, create: { id: t.id, abbr: t.abbr, name: t.name }, update: { abbr: t.abbr, name: t.name } });
    }
    const data = {
      season: g.season,
      seasonType: g.seasonType,
      startAt: g.startAt,
      homeTeamId: g.home.id,
      awayTeamId: g.away.id,
      neutral: g.neutral,
      status: g.status,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      periods: g.periods,
    };
    await db.nbaGame.upsert({ where: { id: g.id }, create: { id: g.id, ...data }, update: data });
    n++;
  }
  return n;
}

/** Sparar en boxscore: spelare, lagrader, spelarrader och ESPN:s linjer. */
export async function saveSummary(db: NbaPrisma, s: EspnSummary): Promise<{ players: number }> {
  await upsertGames(db, [s.game]);
  const gameId = s.game.id;
  const final = s.game.status === "final";
  for (const p of s.players) {
    await db.nbaPlayer.upsert({
      where: { id: p.playerId },
      create: { id: p.playerId, name: p.name, position: p.position, teamId: p.teamId },
      update: { name: p.name, ...(p.position ? { position: p.position } : {}), ...(final ? { teamId: p.teamId } : {}) },
    });
  }
  if (final && s.teams.length === 2 && s.players.length) {
    await db.$transaction([
      db.nbaTeamGame.deleteMany({ where: { gameId } }),
      db.nbaPlayerGame.deleteMany({ where: { gameId } }),
      db.nbaTeamGame.createMany({ data: s.teams.map((t) => ({ gameId, ...t })) }),
      db.nbaPlayerGame.createMany({
        data: s.players.map((p) => ({
          gameId,
          playerId: p.playerId,
          teamId: p.teamId,
          starter: p.starter,
          minutes: p.minutes,
          pts: p.pts,
          fgm2: p.fgm2,
          fga2: p.fga2,
          fgm3: p.fgm3,
          fga3: p.fga3,
          ftm: p.ftm,
          fta: p.fta,
          oreb: p.oreb,
          dreb: p.dreb,
          ast: p.ast,
          tov: p.tov,
          dnp: p.dnp,
          dnpReason: p.dnpReason,
        })),
        skipDuplicates: true,
      }),
      db.nbaGame.update({ where: { id: gameId }, data: { boxFetchedAt: new Date() } }),
    ]);
  }
  if (!final) await saveStarters(db, gameId, s);
  if (final && s.stints) await saveStints(db, gameId, s.stints);
  else if (final) await db.nbaGame.update({ where: { id: gameId }, data: { stintsValid: false } }); // ingen play-by-play
  if (s.odds) await saveEspnOdds(db, gameId, s.odds, final ? s.game.startAt : null);
  return { players: s.players.length };
}

/**
 * Startfemmorna före match: ESPN fyller boxscoren med kvällens spelare och
 * startmarkering ungefär 30 minuter före start. Sparas bara när båda lagen
 * har exakt fem startare.
 */
export async function saveStarters(db: NbaPrisma, gameId: number, s: EspnSummary): Promise<number> {
  const starters = s.players.filter((p) => p.starter);
  const teams = new Set(starters.map((p) => p.teamId));
  if (starters.length !== 10 || teams.size !== 2) return 0;
  await db.$transaction([
    db.nbaStarter.deleteMany({ where: { gameId } }),
    db.nbaStarter.createMany({ data: starters.map((p) => ({ gameId, playerId: p.playerId, teamId: p.teamId })) }),
  ]);
  return starters.length;
}

/** Ersätter matchens stintar. Bara matcher som klarar kvalitetskontrollen sparas. */
export async function saveStints(db: NbaPrisma, gameId: number, p: StintParse): Promise<void> {
  await db.$transaction([
    db.nbaStint.deleteMany({ where: { gameId } }),
    ...(p.valid ? [db.nbaStint.createMany({ data: p.stints.map((s) => ({ gameId, ...s })) })] : []),
    db.nbaGame.update({ where: { id: gameId }, data: { stintsValid: p.valid } }),
  ]);
}

/**
 * ESPN:s linjer (DraftKings). För en spelad match är det i praktiken
 * stängningslinjen — den sparas en gång, med tidsstämpel just före start.
 */
async function saveEspnOdds(db: NbaPrisma, gameId: number, o: NonNullable<EspnSummary["odds"]>, closedAt: Date | null) {
  const rows: Array<{ market: string; line: number | null; price1: number; price2: number }> = [];
  if (o.ml) rows.push({ market: "ml", line: null, price1: o.ml.home, price2: o.ml.away });
  if (o.spread) rows.push({ market: "spread", line: o.spread.line, price1: o.spread.home, price2: o.spread.away });
  if (o.total) rows.push({ market: "total", line: o.total.line, price1: o.total.over, price2: o.total.under });
  for (const r of rows) await saveOddsIfChanged(db, { gameId, book: o.book, source: "espn", ...r, capturedAt: closedAt ? new Date(closedAt.getTime() - 60e3) : new Date(), isClosing: !!closedAt });
}

export interface OddsInput {
  gameId: number;
  book: string;
  market: string;
  line: number | null;
  price1: number;
  price2: number;
  source: string;
  capturedAt?: Date;
  isClosing?: boolean;
}

/** Ny rad bara när linje eller pris ändrats sedan bokens senaste rad. */
export async function saveOddsIfChanged(db: NbaPrisma, o: OddsInput): Promise<boolean> {
  const last = await db.nbaOdds.findFirst({
    where: { gameId: o.gameId, book: o.book, market: o.market, source: o.source },
    orderBy: { capturedAt: "desc" },
  });
  const same = last && last.line === o.line && Math.abs(last.price1 - o.price1) < 1e-6 && Math.abs(last.price2 - o.price2) < 1e-6;
  if (same) {
    if (o.isClosing && !last.isClosing) await db.nbaOdds.update({ where: { id: last.id }, data: { isClosing: true } });
    return false;
  }
  await db.nbaOdds.create({ data: { ...o, capturedAt: o.capturedAt ?? new Date(), isClosing: !!o.isClosing } });
  return true;
}

export async function saveInjuries(db: NbaPrisma, list: EspnInjury[]): Promise<number> {
  const seen = new Set<number>();
  const rows = list.filter((i) => (seen.has(i.playerId) ? false : (seen.add(i.playerId), true)));
  await db.$transaction([
    db.nbaInjury.deleteMany({}),
    db.nbaInjury.createMany({
      data: rows.map((i) => ({ playerId: i.playerId, teamId: i.teamId, playerName: i.playerName, status: i.status, detail: i.detail, reportedAt: i.reportedAt })),
    }),
  ]);
  return rows.length;
}

/**
 * Stintar (för RAPM) från och med `since`. Läses i sidor om 20 000 rader med
 * nytt försök vid tillfälliga fel — en enda fråga om 120 000 rader har fått
 * Neon att stänga anslutningen.
 */
export async function loadStints(db: NbaPrisma, since: Date, opts: { pageSize?: number; log?: (m: string) => void } = {}): Promise<StintRow[]> {
  const pageSize = opts.pageSize ?? 20000;
  const out: StintRow[] = [];
  let cursor: number | undefined;
  for (;;) {
    const rows = await withDbRetry(
      db,
      () =>
        db.nbaStint.findMany({
          where: { game: { startAt: { gte: since } } },
          select: { id: true, homeIds: true, awayIds: true, homePts: true, awayPts: true, poss: true, game: { select: { startAt: true } } },
          orderBy: { id: "asc" },
          take: pageSize,
          ...(cursor != null ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      { label: "stintar", log: opts.log }
    );
    for (const r of rows) out.push({ t: r.game.startAt.getTime(), homeIds: r.homeIds, awayIds: r.awayIds, homePts: r.homePts, awayPts: r.awayPts, poss: r.poss });
    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1].id;
  }
  return out;
}

/** Sparar spelarnas RAPM (ersätter tabellen). */
export async function savePlayerImpact(db: NbaPrisma, fit: RapmFit): Promise<number> {
  const data = [...fit.players.entries()].map(([playerId, p]) => ({ playerId, off: p.off, def: p.def, poss: p.poss }));
  await db.$transaction([db.nbaPlayerImpact.deleteMany({}), db.nbaPlayerImpact.createMany({ data })]);
  return data.length;
}

/** Läser senast sparade RAPM, eller undefined om tabellen är tom. */
export async function loadPlayerImpact(db: NbaPrisma): Promise<RapmFit | undefined> {
  const rows = await db.nbaPlayerImpact.findMany();
  if (!rows.length) return undefined;
  return { players: new Map(rows.map((r) => [r.playerId, { off: r.off, def: r.def, poss: r.poss }])), ortg: 112, stints: 0 };
}

/** All historik från och med `since` som modellen räknar på. */
export async function loadHistory(db: NbaPrisma, since: Date): Promise<History> {
  const games = await db.nbaGame.findMany({
    where: { status: "final", startAt: { gte: since }, boxFetchedAt: { not: null } },
    select: { id: true, startAt: true, periods: true, homeTeamId: true, awayTeamId: true },
  });
  const gameInfo = new Map(games.map((g) => [g.id, g]));
  const ids = games.map((g) => g.id);
  const [teamRows, playerRows, players] = await Promise.all([
    db.nbaTeamGame.findMany({ where: { gameId: { in: ids } } }),
    db.nbaPlayerGame.findMany({
      where: { gameId: { in: ids } },
      select: { gameId: true, playerId: true, teamId: true, minutes: true, fga2: true, fgm2: true, fga3: true, fgm3: true, fta: true, ftm: true, oreb: true, dreb: true, ast: true, tov: true, dnp: true, dnpReason: true, starter: true },
    }),
    db.nbaPlayer.findMany({ select: { id: true, position: true } }),
  ]);
  const pos = new Map(players.map((p) => [p.id, p.position]));
  const byGame = new Map<number, typeof teamRows>();
  for (const r of teamRows) {
    const l = byGame.get(r.gameId);
    if (l) l.push(r);
    else byGame.set(r.gameId, [r]);
  }
  const teams: TeamGameRow[] = [];
  byGame.forEach((pair, gameId) => {
    if (pair.length !== 2) return;
    const g = gameInfo.get(gameId)!;
    for (const [a, b] of [
      [pair[0], pair[1]],
      [pair[1], pair[0]],
    ]) {
      teams.push({
        gameId,
        t: g.startAt.getTime(),
        teamId: a.teamId,
        oppId: b.teamId,
        home: a.home,
        pts: a.pts,
        fga2: a.fga2,
        fgm2: a.fgm2,
        fga3: a.fga3,
        fgm3: a.fgm3,
        fta: a.fta,
        ftm: a.ftm,
        oreb: a.oreb,
        dreb: a.dreb,
        tov: a.tov,
        oppDreb: b.dreb,
        periods: g.periods ?? 4,
      });
    }
  });
  const prs: PlayerGameRow[] = playerRows.map((r) => ({
    ...r,
    t: gameInfo.get(r.gameId)!.startAt.getTime(),
    position: pos.get(r.playerId) ?? null,
  }));
  return buildHistory(prs, teams);
}
