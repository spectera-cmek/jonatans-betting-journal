// Från databasen till ett pris: historik → minuter → simulering → marknader.
// Används av npm run nba:update och av API:t när du ändrar minuter i appen.

import type { NbaPrisma } from "../nbaDb";
import { oddspapiBookmaker } from "../oddspapi";
import { baselineMinutes, projectMinutes, type MinutesInput, type MinutesRow } from "./minutes";
import { DEFAULT_NBA_BLEND_W, DEFAULT_NBA_PARAMS, NBA_MODEL_VERSION, isFlagged, type NbaModelParams } from "./params";
import { fairLine, priceMarket, settle, type MarketPrice, type MarketQuote, type NbaMarket } from "./pricing";
import { leagueAverages, type History, type League } from "./ratings";
import { projectGame, type Projection } from "./project";
import { loadHistory } from "./store";
import type { SimSummary } from "./sim";

/** Hur långt bakåt modellen läser historik. */
export const HISTORY_DAYS = 420;

export const MARKETS: NbaMarket[] = ["ml", "spread", "total"];

export interface LatestQuote extends MarketQuote {
  id: number;
  source: string;
  capturedAt: string;
}

/** Senaste pris per bok och marknad (före matchstart om matchen börjat). */
export async function latestQuotes(db: NbaPrisma, gameId: number, before?: Date): Promise<LatestQuote[]> {
  const rows = await db.nbaOdds.findMany({
    where: { gameId, ...(before ? { capturedAt: { lte: before } } : {}) },
    orderBy: { capturedAt: "desc" },
  });
  const seen = new Set<string>();
  const out: LatestQuote[] = [];
  for (const r of rows) {
    const k = `${r.book}|${r.market}|${r.source === "manual" ? r.id : ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: r.id, market: r.market as NbaMarket, line: r.line, price1: r.price1, price2: r.price2, book: r.book, source: r.source, capturedAt: r.capturedAt.toISOString() });
  }
  return out;
}

/** Marknadsreferensen per marknad: OddsPapi-boken först, sedan ESPN, sist ditt eget pris. */
export function referenceQuote(quotes: LatestQuote[], market: NbaMarket, refBook = oddspapiBookmaker()): LatestQuote | null {
  const m = quotes.filter((q) => q.market === market);
  return (
    m.find((q) => q.source.startsWith("oddspapi") && q.book === refBook) ??
    m.find((q) => q.source.startsWith("oddspapi")) ??
    m.find((q) => q.source === "espn") ??
    m.find((q) => q.source === "manual") ??
    null
  );
}

export interface TeamLineup {
  teamId: number;
  rows: MinutesRow[];
}

/** Minuter för ett lag: grundminuter + skadelistan + dina ändringar. */
export async function buildLineup(
  db: NbaPrisma,
  h: History,
  teamId: number,
  gameId: number,
  t: number,
  cache?: { injuries?: Map<number, { status: string; detail: string | null }>; names?: Map<number, string> }
): Promise<TeamLineup> {
  const base = baselineMinutes(h, teamId, t);
  const names = cache?.names ?? new Map<number, string>();
  const [overrides, injuries] = await Promise.all([
    db.nbaMinutesOverride.findMany({ where: { gameId } }),
    cache?.injuries
      ? Promise.resolve(cache.injuries)
      : db.nbaInjury.findMany({ where: { teamId } }).then((l) => new Map(l.map((i) => [i.playerId, { status: i.status, detail: i.detail }]))),
  ]);
  const ov = new Map(overrides.map((o) => [o.playerId, o.minutes]));
  // Spelare med en override men utan grundminuter (t.ex. ny i laget) tas med.
  const ids = new Set(base.map((b) => b.playerId));
  const extra = overrides.filter((o) => !ids.has(o.playerId));
  const missingNames = [...base.map((b) => b.playerId), ...extra.map((e) => e.playerId)].filter((id) => !names.has(id));
  if (missingNames.length) {
    const ps = await db.nbaPlayer.findMany({ where: { id: { in: missingNames } }, select: { id: true, name: true, teamId: true } });
    for (const p of ps) names.set(p.id, p.name);
  }
  const extraPlayers = extra.length
    ? await db.nbaPlayer.findMany({ where: { id: { in: extra.map((e) => e.playerId) }, teamId }, select: { id: true, position: true } })
    : [];
  const inputs: MinutesInput[] = [
    ...base.map((b) => ({
      playerId: b.playerId,
      name: names.get(b.playerId) ?? `#${b.playerId}`,
      position: b.position,
      baseline: Math.round(b.baseline * 10) / 10,
      games: b.games,
      injuryStatus: injuries.get(b.playerId)?.status ?? null,
      injuryDetail: injuries.get(b.playerId)?.detail ?? null,
      override: ov.has(b.playerId) ? ov.get(b.playerId)! : null,
    })),
    ...extraPlayers.map((p) => ({
      playerId: p.id,
      name: names.get(p.id) ?? `#${p.id}`,
      position: p.position,
      baseline: 0,
      games: 0,
      injuryStatus: injuries.get(p.id)?.status ?? null,
      injuryDetail: injuries.get(p.id)?.detail ?? null,
      override: ov.get(p.id) ?? null,
    })),
  ];
  return { teamId, rows: projectMinutes(inputs) };
}

export interface GameProjection {
  gameId: number;
  summary: SimSummary;
  fairSpread: number;
  fairTotal: number;
  home: TeamLineup;
  away: TeamLineup;
  homeB2B: boolean;
  awayB2B: boolean;
  /** Referenspriset per marknad. */
  markets: MarketPrice[];
  /** Alla sparade priser (alla böcker och dina egna), prissatta. */
  quotes: Array<MarketPrice & { id: number; source: string; capturedAt: string; flagged: boolean }>;
  projection: Projection;
}

/** Projicerar en sparad match. save = skriv NbaProjection för referenspriserna. */
export async function projectStoredGame(
  db: NbaPrisma,
  gameId: number,
  opts: { h?: History; league?: League; params?: NbaModelParams; save?: boolean; injuries?: Map<number, { status: string; detail: string | null }>; names?: Map<number, string> } = {}
): Promise<GameProjection | null> {
  const g = await db.nbaGame.findUnique({ where: { id: gameId } });
  if (!g) return null;
  const p = opts.params ?? DEFAULT_NBA_PARAMS;
  const t = g.startAt.getTime();
  const h = opts.h ?? (await loadHistory(db, new Date(t - HISTORY_DAYS * 864e5)));
  const league = opts.league ?? leagueAverages(h, t, p);
  const cache = { injuries: opts.injuries, names: opts.names ?? new Map<number, string>() };
  const [home, away] = await Promise.all([buildLineup(db, h, g.homeTeamId, g.id, t, cache), buildLineup(db, h, g.awayTeamId, g.id, t, cache)]);
  const proj = projectGame(
    h,
    {
      homeId: g.homeTeamId,
      awayId: g.awayTeamId,
      t,
      neutral: g.neutral,
      homeLineup: home.rows.map((r) => ({ playerId: r.playerId, minutes: r.minutes })),
      awayLineup: away.rows.map((r) => ({ playerId: r.playerId, minutes: r.minutes })),
    },
    p,
    league
  );
  const quotes = await latestQuotes(db, g.id, g.status === "scheduled" ? undefined : g.startAt);
  const markets: MarketPrice[] = [];
  for (const m of MARKETS) {
    const ref = referenceQuote(quotes, m);
    if (m !== "ml" && !ref) continue;
    markets.push(priceMarket(proj.sim, ref ?? { market: "ml", line: null, price1: null, price2: null }, DEFAULT_NBA_BLEND_W[m]));
  }
  const priced = quotes.map((q) => {
    const mp = priceMarket(proj.sim, q, DEFAULT_NBA_BLEND_W[q.market]);
    return { ...mp, id: q.id, source: q.source, capturedAt: q.capturedAt, flagged: isFlagged(mp.edge, mp.bestOdds) };
  });
  if (opts.save) {
    for (const mp of markets) {
      const actual = g.status === "final" && g.homeScore != null && g.awayScore != null ? settle(mp.market, mp.line, g.homeScore, g.awayScore) : null;
      const data = {
        line: mp.line,
        pModel: mp.pModel,
        pPush: mp.pPush,
        pMarket: mp.pMarket,
        pFinal: mp.pFinal,
        blendW: mp.blendW,
        fair1: mp.fairOver,
        fair2: mp.fairUnder,
        book: mp.book,
        price1: mp.price1,
        price2: mp.price2,
        edge1: mp.edgeOver,
        edge2: mp.edgeUnder,
        homeMean: proj.summary.homeMean,
        awayMean: proj.summary.awayMean,
        marginSd: proj.summary.marginSd,
        totalSd: proj.summary.totalSd,
        sims: proj.sim.sims,
        modelVersion: NBA_MODEL_VERSION,
        actual,
      };
      await db.nbaProjection.upsert({ where: { gameId_market: { gameId: g.id, market: mp.market } }, create: { gameId: g.id, market: mp.market, ...data }, update: data });
    }
  }
  return {
    gameId: g.id,
    summary: proj.summary,
    fairSpread: fairLine(proj.sim, "spread"),
    fairTotal: fairLine(proj.sim, "total"),
    home,
    away,
    homeB2B: proj.homeB2B,
    awayB2B: proj.awayB2B,
    markets,
    quotes: priced,
    projection: proj,
  };
}

/** Projicerar alla matcher som startar inom `hours`. */
export async function projectUpcoming(db: NbaPrisma, opts: { hours?: number; params?: NbaModelParams; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const now = Date.now();
  const games = await db.nbaGame.findMany({
    where: { status: "scheduled", startAt: { gte: new Date(now - 3600e3), lte: new Date(now + (opts.hours ?? 36) * 3600e3) } },
    orderBy: { startAt: "asc" },
  });
  if (!games.length) return { games: 0, flagged: 0 };
  const h = await loadHistory(db, new Date(now - HISTORY_DAYS * 864e5));
  const injuries = new Map((await db.nbaInjury.findMany()).map((i) => [i.playerId, { status: i.status, detail: i.detail }]));
  const names = new Map((await db.nbaPlayer.findMany({ select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const teams = new Map((await db.nbaTeam.findMany()).map((t) => [t.id, t.abbr]));
  let flagged = 0;
  for (const g of games) {
    const r = await projectStoredGame(db, g.id, { h, params: opts.params, save: true, injuries, names });
    if (!r) continue;
    const s = r.summary;
    const f = r.quotes.filter((q) => q.flagged);
    flagged += f.length;
    log(
      `${teams.get(g.awayTeamId)} @ ${teams.get(g.homeTeamId)}  modell ${s.awayMean.toFixed(1)}–${s.homeMean.toFixed(1)}  ` +
        `spread ${fmtLine(r.fairSpread)} total ${r.fairTotal}  P(hemma) ${(s.pHomeWin * 100).toFixed(1)} %` +
        (f.length ? `  ⚑ ${f.map((q) => `${sideText(q, teams.get(g.homeTeamId) ?? "H", teams.get(g.awayTeamId) ?? "B")} @${q.bestOdds?.toFixed(2)} ${q.book} +${((q.edge ?? 0) * 100).toFixed(1)} %`).join(", ")}` : "")
    );
  }
  return { games: games.length, flagged };
}

/** Sätter facit på projektioner för spelade matcher. */
export async function settleProjections(db: NbaPrisma): Promise<number> {
  const open = await db.nbaProjection.findMany({ where: { actual: null }, include: { game: true } });
  let n = 0;
  for (const p of open) {
    const g = p.game;
    if (g.status !== "final" || g.homeScore == null || g.awayScore == null) continue;
    await db.nbaProjection.update({ where: { id: p.id }, data: { actual: settle(p.market as NbaMarket, p.line, g.homeScore, g.awayScore) } });
    n++;
  }
  return n;
}

export const fmtLine = (x: number) => (x > 0 ? `+${x}` : `${x}`);

/** "BOS +7.5", "Över 224.5", "ORL" — bästa sidan för ett pris. */
function sideText(q: MarketPrice, home: string, away: string): string {
  const side1 = q.bestSide === "over";
  if (q.market === "total") return `${side1 ? "Över" : "Under"} ${q.line}`;
  const team = side1 ? home : away;
  if (q.market === "ml") return team;
  return `${team} ${fmtLine(side1 ? q.line ?? 0 : -(q.line ?? 0))}`;
}
