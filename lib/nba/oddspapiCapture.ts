// Hämtar NBA-odds från OddsPapi och kopplar dem till ESPN-matcherna.
//
// Kvotsnålt: 1 anrop (/odds-by-tournaments) ger alla NBA-matcher med odds.
// Lagens OddsPapi-id lärs in en gång (via /fixtures, 1 anrop) och sparas på
// NbaTeam.oddspapiId — sedan räcker deltagar-id:t för att hitta matchen.

import type { NbaPrisma } from "../nbaDb";
import {
  getFixtures,
  getHistoricalOdds,
  getOddsByTournaments,
  oddspapiBookmaker,
  type OpFixture,
} from "../oddspapi";
import {
  closingFromHistory,
  extractLines,
  extractPropLines,
  loadIds,
  normalizeName,
  orientRows,
  pickMainLines,
  type MarketSpec,
} from "../oddspapi/markets";
import { saveOddsIfChanged } from "./store";

/** "Los Angeles Lakers" → "lakers", "Portland Trail Blazers" → "blazers". */
export function nickname(name: string): string {
  const w = name.trim().toLowerCase().split(/\s+/);
  return w[w.length - 1] ?? "";
}

interface TeamMap {
  byOp: Map<number, number>;
  byNick: Map<string, number>;
}

async function teamMap(db: NbaPrisma): Promise<TeamMap> {
  const teams = await db.nbaTeam.findMany();
  return {
    byOp: new Map(teams.filter((t) => t.oddspapiId != null).map((t) => [t.oddspapiId!, t.id])),
    byNick: new Map(teams.map((t) => [nickname(t.name), t.id])),
  };
}

/** Lär in OddsPapi-id för lag ur fixtures-svar (namnen finns där). */
export async function learnTeams(db: NbaPrisma, fixtures: OpFixture[], tm: TeamMap): Promise<number> {
  let n = 0;
  for (const f of fixtures) {
    for (const [opId, name] of [
      [f.participant1Id, f.participant1Name],
      [f.participant2Id, f.participant2Name],
    ] as const) {
      if (!opId || !name || tm.byOp.has(opId)) continue;
      const espnId = tm.byNick.get(nickname(name));
      if (!espnId) continue;
      await db.nbaTeam.update({ where: { id: espnId }, data: { oddspapiId: opId } }).catch(() => null);
      tm.byOp.set(opId, espnId);
      n++;
    }
  }
  return n;
}

/** ESPN-matchen för en OddsPapi-fixture: samma lag, start inom 36 h. */
async function findGame(db: NbaPrisma, f: OpFixture, tm: TeamMap) {
  if (f.fixtureId) {
    const linked = await db.nbaGame.findUnique({ where: { oddspapiFixtureId: f.fixtureId } });
    if (linked) return { game: linked, p1IsHome: linked.oddspapiP1Home ?? tm.byOp.get(f.participant1Id) === linked.homeTeamId };
  }
  const t1 = tm.byOp.get(f.participant1Id);
  const t2 = tm.byOp.get(f.participant2Id);
  if (!t1 || !t2) return null;
  const start = Date.parse(f.startTime);
  const game = await db.nbaGame.findFirst({
    where: {
      OR: [
        { homeTeamId: t1, awayTeamId: t2 },
        { homeTeamId: t2, awayTeamId: t1 },
      ],
      startAt: { gte: new Date(start - 36 * 3600e3), lte: new Date(start + 36 * 3600e3) },
    },
  });
  if (!game) return null;
  const p1IsHome = game.homeTeamId === t1;
  if (game.oddspapiFixtureId !== f.fixtureId || game.oddspapiP1Home !== p1IsHome) {
    await db.nbaGame.update({ where: { id: game.id }, data: { oddspapiFixtureId: f.fixtureId, oddspapiP1Home: p1IsHome } }).catch(() => null);
  }
  return { game, p1IsHome };
}

function requireIds() {
  const ids = loadIds();
  if (!ids?.nba || !Object.keys(ids.basketballMarkets ?? {}).length) {
    throw new Error("lib/oddspapi/ids.json saknas eller saknar NBA — kör npm run oddspapi:discover först");
  }
  return ids as typeof ids & { nba: NonNullable<typeof ids.nba> };
}

export interface CaptureResult {
  fixtures: number;
  matched: number;
  saved: number;
  /**
   * Kontroll av spreadens tecken mot DraftKings (ESPN) i samma match:
   * OddsPapi dokumenterar inte om handicap gäller participant1. Om tecknen
   * går åt olika håll i de flesta matcher är vår tolkning omvänd.
   */
  spreadCheck: { compared: number; flipped: number; examples: string[] };
  /** Nya prop-linjer och prop-spelare som inte gick att para med ESPN. */
  propsSaved: number;
  propsUnmatched: string[];
  unmatched: string[];
}

/**
 * Dagens NBA-odds från OddsPapi. closing = markera priset som stängning för
 * matcher som startar inom 3 timmar.
 */
export async function captureNbaOdds(db: NbaPrisma, opts: { closing?: boolean; log?: (m: string) => void } = {}): Promise<CaptureResult> {
  const log = opts.log ?? (() => {});
  const ids = requireIds();
  const book = oddspapiBookmaker();
  const tm = await teamMap(db);
  const fixtures = await getOddsByTournaments([ids.nba.tournamentId], book);
  // Okända lag → ett fixtures-anrop för att lära in namnen.
  const unknown = fixtures.some((f) => !tm.byOp.has(f.participant1Id) || !tm.byOp.has(f.participant2Id));
  if (unknown) {
    const named = fixtures.every((f) => f.participant1Name && f.participant2Name)
      ? fixtures
      : await getFixtures({ tournamentId: ids.nba.tournamentId });
    const learned = await learnTeams(db, named, tm);
    if (learned) log(`lärde in ${learned} lag-id från OddsPapi`);
  }
  const res: CaptureResult = {
    fixtures: fixtures.length,
    matched: 0,
    saved: 0,
    spreadCheck: { compared: 0, flipped: 0, examples: [] },
    propsSaved: 0,
    propsUnmatched: [],
    unmatched: [],
  };
  const propMarkets = ids.basketballPropMarkets ?? {};
  let allPlayers: Array<{ id: number; name: string }> | null = null;
  const hasPropMarkets = Object.keys(propMarkets).length > 0;
  const now = Date.now();
  for (const f of fixtures) {
    const hit = await findGame(db, f, tm);
    if (!hit) {
      res.unmatched.push(`${f.participant1Name ?? f.participant1Id} – ${f.participant2Name ?? f.participant2Id} ${f.startTime}`);
      continue;
    }
    res.matched++;
    const rows = orientRows(pickMainLines(extractLines(f, book, ids.basketballMarkets)), hit.p1IsHome);
    const sp = rows.find((r) => r.kind === "spread");
    if (sp?.line != null && Math.abs(sp.line) >= 1.5) {
      const dk = await db.nbaOdds.findFirst({ where: { gameId: hit.game.id, market: "spread", source: "espn" }, orderBy: { capturedAt: "desc" } });
      if (dk?.line != null && Math.abs(dk.line) >= 1.5) {
        res.spreadCheck.compared++;
        const flipped = Math.sign(dk.line) !== Math.sign(sp.line);
        if (flipped) res.spreadCheck.flipped++;
        if (res.spreadCheck.examples.length < 3) res.spreadCheck.examples.push(`hemma ${sp.line} hos ${book} / ${dk.line} hos ${dk.book}${flipped ? " ⚠" : ""}`);
      }
    }
    const closing = !!opts.closing && hit.game.startAt.getTime() - now < 3 * 3600e3 && hit.game.startAt.getTime() > now;
    for (const r of rows) {
      const saved = await saveOddsIfChanged(db, {
        gameId: hit.game.id,
        book,
        market: r.kind,
        line: r.line,
        price1: r.price1,
        price2: r.price2,
        source: "oddspapi",
        isClosing: closing,
      });
      if (saved) res.saved++;
    }
    // Spelarprops ur samma svar — kostar inget extra anrop.
    if (hasPropMarkets) {
      const props = extractPropLines(f, book, propMarkets);
      if (props.length) {
        const players = await db.nbaPlayer.findMany({
          where: { teamId: { in: [hit.game.homeTeamId, hit.game.awayTeamId] } },
          select: { id: true, name: true },
        });
        const byName = new Map(players.map((p) => [normalizeName(p.name), p.id]));
        for (const pr of props) {
          let playerId = byName.get(normalizeName(pr.playerName));
          // Reserv: spelaren står på ett annat lag i vår data (trejd, nyförvärv
          // som inte spelat än) — sök i hela ligan om namnet bara finns en gång.
          if (!playerId) {
            allPlayers ??= await db.nbaPlayer.findMany({ select: { id: true, name: true } });
            const hits = allPlayers.filter((p) => normalizeName(p.name) === normalizeName(pr.playerName));
            if (hits.length === 1) playerId = hits[0].id;
          }
          if (!playerId) {
            if (res.propsUnmatched.length < 20 && !res.propsUnmatched.includes(pr.playerName)) res.propsUnmatched.push(pr.playerName);
            continue;
          }
          const last = await db.nbaPropLine.findFirst({
            where: { gameId: hit.game.id, playerId, stat: pr.stat, book, source: "oddspapi" },
            orderBy: { capturedAt: "desc" },
          });
          if (last && last.line === pr.line && last.over === pr.over && last.under === pr.under) continue;
          await db.nbaPropLine.create({ data: { gameId: hit.game.id, playerId, stat: pr.stat, book, line: pr.line, over: pr.over, under: pr.under, source: "oddspapi" } });
          res.propsSaved++;
        }
      }
    }
  }
  return res;
}

/**
 * Stängningsodds ur OddsPapi:s historik (gratis endpoint) för spelade
 * matcher som har ett kopplat fixture-id. Historiken finns från januari 2026.
 */
export async function captureHistoricalClosing(
  db: NbaPrisma,
  opts: { from: Date; to: Date; max?: number; log?: (m: string) => void }
): Promise<{ games: number; saved: number; empty: number }> {
  const log = opts.log ?? (() => {});
  const ids = requireIds();
  const book = oddspapiBookmaker();
  const games = await db.nbaGame.findMany({
    where: {
      status: "final",
      startAt: { gte: opts.from, lte: opts.to },
      oddspapiFixtureId: { not: null },
      odds: { none: { source: "oddspapi-history", book } },
    },
    orderBy: { startAt: "asc" },
    take: opts.max ?? 2000,
  });
  let saved = 0;
  let empty = 0;
  for (const [i, g] of games.entries()) {
    const h = await getHistoricalOdds(g.oddspapiFixtureId!, [book]);
    const lines = pickMainLines(closingFromHistory(h, book, ids.basketballMarkets as Record<string, MarketSpec>, g.startAt));
    if (!lines.length) {
      empty++;
      continue;
    }
    // participant1 är inte alltid hemmalaget — orienteringen sparades vid kopplingen.
    for (const r of orientRows(lines, g.oddspapiP1Home ?? true)) {
      await db.nbaOdds.create({
        data: { gameId: g.id, book, market: r.kind, line: r.line, price1: r.price1, price2: r.price2, source: "oddspapi-history", capturedAt: new Date(g.startAt.getTime() - 60e3), isClosing: true },
      });
      saved++;
    }
    if ((i + 1) % 25 === 0) log(`${i + 1}/${games.length} matcher`);
  }
  return { games: games.length, saved, empty };
}

/** Kopplar spelade matcher till OddsPapi-fixtures (debiterade anrop: ett per fönster). */
export async function linkHistoricalFixtures(
  db: NbaPrisma,
  opts: { from: Date; to: Date; windowDays?: number; maxCalls?: number; log?: (m: string) => void }
): Promise<{ calls: number; linked: number }> {
  const log = opts.log ?? (() => {});
  const ids = requireIds();
  const tm = await teamMap(db);
  const step = (opts.windowDays ?? 9) * 864e5;
  let calls = 0;
  let linked = 0;
  for (let t = opts.from.getTime(); t < opts.to.getTime(); t += step) {
    if (calls >= (opts.maxCalls ?? 25)) {
      log(`stannar vid anropstaket (${calls})`);
      break;
    }
    const from = new Date(t).toISOString().slice(0, 10);
    const to = new Date(Math.min(t + step, opts.to.getTime())).toISOString().slice(0, 10);
    const fx = await getFixtures({ tournamentId: ids.nba.tournamentId, from, to });
    calls++;
    await learnTeams(db, fx, tm);
    for (const f of fx) {
      if (await findGame(db, f, tm)) linked++;
    }
    log(`${from}–${to}: ${fx.length} fixtures, totalt ${linked} kopplade`);
  }
  return { calls, linked };
}
