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
  OddspapiError,
  oddspapiRetry,
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
  reclassifyPropMarkets,
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
  const propMarkets = reclassifyPropMarkets(ids.basketballPropMarkets);
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
/** Källnamn för historikens två tidpunkter. */
export const HISTORY_CLOSING = "oddspapi-history";
export const HISTORY_BET = "oddspapi-bet";

/**
 * Bolag vars sparade OddsPapi-historik inte går att lita på. bet365: platta priser
 * (1,9/1,9) över hela linjestegen gav godtyckliga alternativlinjer — 81 % av
 * spreadarna har omvänt tecken mot Pinnacle (npm run nba:check-books -- bet365).
 * pickMainLines hoppar nu över sådana stegar, men raderna som redan sparats finns kvar.
 */
export const UNRELIABLE_HISTORY_BOOKS = new Set(["bet365"]);

/** true för en historikrad (stängning eller speltid) från ett bolag ovan. */
export function isUnreliableHistory(source: string, book: string): boolean {
  return source.startsWith(HISTORY_BET) || source === HISTORY_CLOSING ? UNRELIABLE_HISTORY_BOOKS.has(book) : false;
}

/** Källnamnet för speltidspriset: "oddspapi-bet" vid 12 h, annars t.ex. "oddspapi-bet-4h". */
export function betSource(hours = 12): string {
  return hours === 12 ? HISTORY_BET : `${HISTORY_BET}-${hours}h`;
}

/**
 * Pris ur OddsPapi-historiken (gratis) vid två tidpunkter, för Pinnacle eller
 * upp till tre valfria bolag (`books`, t.ex. svenska bolag att jämföra med):
 *   stängning — senaste priset före start (source "oddspapi-history")
 *   speltid   — priset `betHours` timmar före start, när du skulle ha spelat
 *               (standard 12 h ≈ kl. 13 svensk tid för en match kl. 01) — source "oddspapi-bet"
 * Skillnaden mellan dem är linjerörelsen, som CLV-mätningen i nba:backtest bygger på.
 * En match markeras som tom (och frågas inte igen) bara när inget av bolagen har historik.
 */
export async function captureHistoricalClosing(
  db: NbaPrisma,
  opts: {
    from: Date;
    to: Date;
    max?: number;
    betHours?: number;
    retryEmpty?: boolean;
    books?: string[];
    /** Hämta och räkna om även matcher som redan har priser (efter en rättning i tolkningen). */
    refresh?: boolean;
    log?: (m: string) => void;
  }
): Promise<{ games: number; saved: number; empty: number; byBook: Record<string, number>; suspended: number }> {
  const log = opts.log ?? (() => {});
  const ids = requireIds();
  const books = (opts.books?.length ? opts.books : [oddspapiBookmaker()]).slice(0, 3);
  const BET = betSource(opts.betHours ?? 12);
  const byBook: Record<string, number> = Object.fromEntries(books.map((b) => [b, 0]));
  const stats = { suspended: 0 };
  const games = await db.nbaGame.findMany({
    where: {
      status: "final",
      startAt: { gte: opts.from, lte: opts.to },
      oddspapiFixtureId: { not: null },
      // Matcher där historiken redan visat sig tom frågas inte igen (5 s styck).
      ...(opts.retryEmpty ? {} : { oddsHistoryEmptyAt: null }),
      // Saknar stängning eller speltidspris från historiken (allt med refresh).
      ...(opts.refresh ? {} : { OR: books.flatMap((book) => [{ odds: { none: { source: HISTORY_CLOSING, book } } }, { odds: { none: { source: BET, book } } }]) }),
    },
    orderBy: { startAt: "asc" },
    take: opts.max ?? 2000,
  });
  let saved = 0;
  let empty = 0;
  const betMs = (opts.betHours ?? 12) * 3600e3;
  log(`${games.length} matcher att hämta historik för (≈ ${Math.ceil((games.length * 5.4) / 60)} min)`);
  const markEmpty = (id: number) => db.nbaGame.update({ where: { id }, data: { oddsHistoryEmptyAt: new Date() } });
  for (const [i, g] of games.entries()) {
    let h: Awaited<ReturnType<typeof getHistoricalOdds>>;
    try {
      h = await oddspapiRetry(() => getHistoricalOdds(g.oddspapiFixtureId!, books), 5, (m) => log(`match ${g.id}: ${m}`));
    } catch (e) {
      // 404 "No historical odds found" = OddsPapi har ingen historik för matchen. Hoppa över den.
      if (!(e instanceof OddspapiError && e.statusCode === 404)) throw e;
      empty++;
      await markEmpty(g.id);
      continue;
    }
    const markets = ids.basketballMarkets as Record<string, MarketSpec>;
    const points = [
      { source: HISTORY_CLOSING, at: g.startAt, capturedAt: new Date(g.startAt.getTime() - 60e3), isClosing: true },
      { source: BET, at: new Date(g.startAt.getTime() - betMs), capturedAt: new Date(g.startAt.getTime() - betMs), isClosing: false },
    ];
    let any = false;
    for (const book of books) {
      let bookAny = false;
      for (const pt of points) {
        const lines = pickMainLines(closingFromHistory(h, book, markets, pt.at, stats));
        if (!lines.length) {
          // Gamla rader från en tidigare tolkning (t.ex. ett pris från en stängd marknad) tas bort.
          if (opts.refresh) await db.nbaOdds.deleteMany({ where: { gameId: g.id, book, source: pt.source } });
          continue;
        }
        any = bookAny = true;
        await db.nbaOdds.deleteMany({ where: { gameId: g.id, book, source: pt.source } });
        // participant1 är inte alltid hemmalaget — orienteringen sparades vid kopplingen.
        for (const r of orientRows(lines, g.oddspapiP1Home ?? true)) {
          await db.nbaOdds.create({
            data: { gameId: g.id, book, market: r.kind, line: r.line, price1: r.price1, price2: r.price2, source: pt.source, capturedAt: pt.capturedAt, isClosing: pt.isClosing },
          });
          saved++;
        }
      }
      if (bookAny) byBook[book]++;
    }
    if (!any) {
      empty++;
      await markEmpty(g.id);
    }
    if ((i + 1) % 25 === 0) log(`${i + 1}/${games.length} matcher`);
  }
  return { games: games.length, saved, empty, byBook, suspended: stats.suspended };
}

/**
 * Kopplar spelade matcher till OddsPapi-fixtures. Debiterat: ett anrop per
 * fönster (9 dagar). Bara fönster med matcher som saknar koppling och inte
 * redan sökts frågas efter — sommaruppehåll och redan kopplade perioder kostar
 * inget. "Inga matcher" (404) räknas som ett tomt fönster, inte ett fel.
 */
export async function linkHistoricalFixtures(
  db: NbaPrisma,
  opts: { from: Date; to: Date; windowDays?: number; maxCalls?: number; log?: (m: string) => void }
): Promise<{ calls: number; linked: number }> {
  const log = opts.log ?? (() => {});
  const ids = requireIds();
  const tm = await teamMap(db);
  const step = (opts.windowDays ?? 9) * 864e5;
  const pending = await db.nbaGame.findMany({
    where: { status: "final", startAt: { gte: opts.from, lte: opts.to }, oddspapiFixtureId: null, oddspapiLinkTried: null },
    select: { id: true, startAt: true },
    orderBy: { startAt: "asc" },
  });
  let calls = 0;
  let linked = 0;
  let i = 0;
  while (i < pending.length) {
    if (calls >= (opts.maxCalls ?? 25)) {
      log(`stannar vid anropstaket (${calls}) — kör igen för resten`);
      break;
    }
    // Fönstret börjar vid nästa okopplade match (dagen före, för tidszoner).
    const t0 = pending[i].startAt.getTime() - 864e5;
    const t1 = t0 + step;
    const from = new Date(t0).toISOString().slice(0, 10);
    const to = new Date(t1).toISOString().slice(0, 10);
    let fx: OpFixture[] = [];
    try {
      fx = await getFixtures({ tournamentId: ids.nba.tournamentId, from, to });
    } catch (e) {
      if (!(e instanceof OddspapiError && (e.statusCode === 404 || e.code === "FIXTURE_NOT_FOUND"))) throw e;
    }
    calls++;
    await learnTeams(db, fx, tm);
    for (const f of fx) {
      if (await findGame(db, f, tm)) linked++;
    }
    // Markera fönstrets matcher som sökta, även de som inte hittades.
    const inWindow = pending.filter((g) => g.startAt.getTime() < t1).slice(i).map((g) => g.id);
    await db.nbaGame.updateMany({ where: { id: { in: inWindow } }, data: { oddspapiLinkTried: new Date() } });
    while (i < pending.length && pending[i].startAt.getTime() < t1) i++;
    log(`${from}–${to}: ${fx.length} fixtures, totalt ${linked} kopplade`);
  }
  return { calls, linked };
}
