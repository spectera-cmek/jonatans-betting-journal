// Hämtar Smarkets priser för kommande NBA-matcher och sparar dem:
//   - hela stegen (alla linjer) i NbaSmarketsQuote, bara det som ändrats
//   - huvudlinjen per marknad i NbaOdds (book "smarkets"), så att modellen
//     prisar mot den i appen precis som mot övriga bolag
// Gratis och utan nyckel — kan köras så ofta man vill.

import type { NbaPrisma } from "../nbaDb";
import { getMainMarkets, getNbaEvents, mainLines, SMARKETS_BOOK, splitEventName, toLines, type SmEvent, type SmLine } from "../smarkets";
import { nickname } from "./oddspapiCapture";
import { saveOddsIfChanged } from "./store";

export interface SmarketsCaptureResult {
  events: number;
  matched: number;
  ladderSaved: number;
  mainSaved: number;
  unmatched: string[];
}

/** Kopplar ett Smarkets-event till en NBA-match via lagens smeknamn och starttid (±3 h). */
async function matchEvent(db: NbaPrisma, e: SmEvent, byNick: Map<string, number>) {
  const linked = await db.nbaGame.findFirst({ where: { smarketsEventId: String(e.id) } });
  if (linked) return linked;
  const teams = splitEventName(e.name);
  if (!teams) return null;
  const home = byNick.get(nickname(teams.home));
  const away = byNick.get(nickname(teams.away));
  if (!home || !away) return null;
  const t = Date.parse(e.start_datetime);
  const game = await db.nbaGame.findFirst({
    where: { homeTeamId: home, awayTeamId: away, startAt: { gte: new Date(t - 3 * 3600e3), lte: new Date(t + 3 * 3600e3) } },
  });
  if (game) await db.nbaGame.update({ where: { id: game.id }, data: { smarketsEventId: String(e.id) } }).catch(() => null);
  return game;
}

const same = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);

export async function captureSmarkets(
  db: NbaPrisma,
  opts: { hours?: number; closing?: boolean; log?: (m: string) => void } = {}
): Promise<SmarketsCaptureResult> {
  const log = opts.log ?? (() => {});
  const res: SmarketsCaptureResult = { events: 0, matched: 0, ladderSaved: 0, mainSaved: 0, unmatched: [] };
  const horizon = Date.now() + (opts.hours ?? 36) * 3600e3;
  const events = (await getNbaEvents()).filter((e) => e.state === "upcoming" && Date.parse(e.start_datetime) <= horizon);
  res.events = events.length;
  if (!events.length) return res;

  const teams = await db.nbaTeam.findMany();
  const byNick = new Map(teams.map((t) => [nickname(t.name), t.id]));
  const games = new Map<string, { id: number; startAt: Date }>();
  for (const e of events) {
    const g = await matchEvent(db, e, byNick);
    if (g && g.status === "scheduled") games.set(String(e.id), g);
    else if (!g) res.unmatched.push(e.name);
  }
  res.matched = games.size;
  if (!games.size) return res;

  const { markets, contracts, quotes } = await getMainMarkets([...games.keys()]);
  const lines = toLines(markets, contracts, quotes);
  const now = new Date();

  for (const [eventId, g] of games) {
    const mine = lines.filter((l) => l.eventId === eventId);
    // Senaste ögonblicksbilden per marknad och linje — spara bara det som ändrats.
    const prev = await db.nbaSmarketsQuote.findMany({ where: { gameId: g.id }, orderBy: { capturedAt: "desc" }, take: 400 });
    const lastBy = new Map<string, (typeof prev)[number]>();
    for (const p of prev) {
      const k = `${p.market}|${p.line}`;
      if (!lastBy.has(k)) lastBy.set(k, p);
    }
    const changed = mine.filter((l) => {
      const p = lastBy.get(`${l.kind}|${l.line}`);
      return !p || !same(p.back1, l.back1) || !same(p.back2, l.back2) || !same(p.lay1, l.lay1) || !same(p.lay2, l.lay2);
    });
    if (changed.length) {
      await db.nbaSmarketsQuote.createMany({
        data: changed.map((l: SmLine) => ({ gameId: g.id, market: l.kind, line: l.line, back1: l.back1, back2: l.back2, lay1: l.lay1, lay2: l.lay2, capturedAt: now })),
      });
      res.ladderSaved += changed.length;
    }
    // Huvudlinjen som vanligt odds (back-priser före provision; appen drar provisionen).
    for (const l of mainLines(mine)) {
      const saved = await saveOddsIfChanged(db, {
        gameId: g.id,
        book: SMARKETS_BOOK,
        market: l.kind,
        line: l.line,
        price1: l.back1!,
        price2: l.back2!,
        source: SMARKETS_BOOK,
        capturedAt: now,
        isClosing: opts.closing && g.startAt.getTime() - now.getTime() <= 3 * 3600e3,
      });
      if (saved) res.mainSaved++;
    }
  }
  log(`${res.matched}/${res.events} Smarkets-matcher kopplade, ${res.ladderSaved} ändrade linjer, ${res.mainSaved} nya huvudlinjer`);
  return res;
}
