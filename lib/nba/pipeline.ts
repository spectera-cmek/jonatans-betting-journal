// Från databasen till ett pris: historik → minuter → simulering → marknader.
// Används av npm run nba:update och av API:t när du ändrar minuter i appen.

import type { NbaPrisma } from "../nbaDb";
import { oddspapiBookmaker } from "../oddspapi";
import { isUnreliableHistory } from "./oddspapiCapture";
import { baseLineup, baselineMinutes, projectMinutes, roleBaseline, type MinutesInput, type MinutesRow } from "./minutes";
import { clvPoints, gradePick, modelLine, pickFromLine, type PickMarket } from "./picks";
import { fitTeamRatings, type RatingTable } from "./teamRatings";
import { gameProps, settleProps, type PlayerPropView } from "./propsPipeline";
import { DEFAULT_NBA_BLEND_W, DEFAULT_NBA_PARAMS, NBA_MODEL_VERSION, isFlagged, type NbaModelParams } from "./params";
import { fairLine, priceMarket, settle, type MarketPrice, type MarketQuote, type NbaMarket } from "./pricing";
import { leagueAverages, type History, type League } from "./ratings";
import { projectGame, type Projection } from "./project";
import { loadHistory, loadMarketLines, loadPlayerImpact, loadStints, savePlayerImpact } from "./store";
import { fitMarketRatings, MARKET_LINE_DAYS, type MarketRatings } from "./marketRatings";
import { fitRapm, type RapmFit } from "./rapm";
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
    if (isUnreliableHistory(r.source, r.book)) continue;
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
  cache?: { injuries?: Map<number, { status: string; detail: string | null }>; names?: Map<number, string>; absSpread?: number | null }
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
  // Startfemman, om ESPN publicerat den: grundminuter efter kvällens roll.
  const starters = await db.nbaStarter.findMany({ where: { gameId, teamId }, select: { playerId: true } });
  const starterSet = starters.length === 5 ? new Set(starters.map((s) => s.playerId)) : null;
  const roleBase = (playerId: number, b: number) => (starterSet ? roleBaseline(h, playerId, t, starterSet.has(playerId), b) : b);
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
      baseline: Math.round(roleBase(b.playerId, b.baseline) * 10) / 10,
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
  return { teamId, rows: projectMinutes(inputs, undefined, undefined, { absSpread: cache?.absSpread }) };
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
  /** Modellens linjer i poäng (hemmalagets handicap och total, en decimal). */
  modelSpread: number;
  modelTotal: number;
  /** Lagratingens mål: poäng per 100, tempo och spelarjustering. */
  targets: Projection["targets"];
  /** Alla sparade priser (alla böcker och dina egna), prissatta. */
  quotes: Array<MarketPrice & { id: number; source: string; capturedAt: string; flagged: boolean }>;
  /** Spelarprops (bara när props begärs). */
  props?: PlayerPropView[];
  projection: Projection;
}

/** Projicerar en sparad match. save = skriv NbaProjection för referenspriserna. */
export async function projectStoredGame(
  db: NbaPrisma,
  gameId: number,
  opts: {
    h?: History;
    league?: League;
    ratings?: RatingTable;
    /** Spelarnas RAPM; saknas den läses senast sparade. */
    rapm?: RapmFit;
    /** Marknadens lagrating; saknas den räknas den ur tidigare stängningslinjer. */
    market?: MarketRatings;
    params?: NbaModelParams;
    save?: boolean;
    /** Räkna props: true = utan fördelningskurvor, "hist" = med (för matchsidan). */
    props?: boolean | "hist";
    injuries?: Map<number, { status: string; detail: string | null }>;
    names?: Map<number, string>;
  } = {}
): Promise<GameProjection | null> {
  const g = await db.nbaGame.findUnique({ where: { id: gameId } });
  if (!g) return null;
  const p = opts.params ?? DEFAULT_NBA_PARAMS;
  const t = g.startAt.getTime();
  const h = opts.h ?? (await loadHistory(db, new Date(t - HISTORY_DAYS * 864e5)));
  const league = opts.league ?? leagueAverages(h, t, p);
  const ratings = opts.ratings ?? (p.ratingMix > 0 ? fitTeamRatings(h, t, p) : undefined);
  const rapm = opts.rapm ?? (p.rapmK > 0 ? await loadPlayerImpact(db) : undefined);
  const market = opts.market ?? (p.marketMix > 0 ? await marketRatingsAt(db, t) : undefined);
  const cache = { injuries: opts.injuries, names: opts.names ?? new Map<number, string>() };
  // Marknadens spread styr utklassningsrisken i minuterna — hämta priserna först.
  const quotes = await latestQuotes(db, g.id, g.status === "scheduled" ? undefined : g.startAt);
  const spreadQ = referenceQuote(quotes, "spread");
  const lineupCache = { ...cache, absSpread: spreadQ?.line != null ? Math.abs(spreadQ.line) : null };
  const [home, away] = await Promise.all([
    buildLineup(db, h, g.homeTeamId, g.id, t, lineupCache),
    buildLineup(db, h, g.awayTeamId, g.id, t, lineupCache),
  ]);
  const proj = projectGame(
    h,
    {
      homeId: g.homeTeamId,
      awayId: g.awayTeamId,
      t,
      neutral: g.neutral,
      seasonType: g.seasonType,
      homeLineup: home.rows.map((r) => ({ playerId: r.playerId, minutes: r.minutes })),
      awayLineup: away.rows.map((r) => ({ playerId: r.playerId, minutes: r.minutes })),
      homeBaseLineup: baseLineup(h, g.homeTeamId, t),
      awayBaseLineup: baseLineup(h, g.awayTeamId, t),
      rapm,
      market,
    },
    p,
    league,
    ratings
  );
  const modelSpread = modelLine("spread", proj.summary.homeMean, proj.summary.awayMean);
  const modelTotal = modelLine("total", proj.summary.homeMean, proj.summary.awayMean);
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
    // Låst pick: första gången matchen har en linje sparas modellens pick mot
    // den, och den ändras aldrig efter det.
    if (g.status === "scheduled") {
      for (const market of ["spread", "total"] as PickMarket[]) {
        const ref = referenceQuote(quotes, market);
        if (!ref || ref.line == null || ref.price1 == null || ref.price2 == null) continue;
        const exists = await db.nbaPick.findUnique({ where: { gameId_market: { gameId: g.id, market } }, select: { id: true } });
        if (exists) continue;
        const ml = market === "spread" ? modelSpread : modelTotal;
        const pk = pickFromLine(market, ml, ref.line);
        await db.nbaPick
          .create({
            data: {
              gameId: g.id,
              market,
              book: ref.book ?? "?",
              line: ref.line,
              price1: ref.price1,
              price2: ref.price2,
              modelLine: ml,
              side: pk.side,
              edgePts: pk.edgePts,
              modelVersion: NBA_MODEL_VERSION,
            },
          })
          .catch(() => null);
      }
    }
  }
  const props =
    opts.props || opts.save
      ? await gameProps(db, {
          h,
          league,
          ratings,
          gameId: g.id,
          homeId: g.homeTeamId,
          awayId: g.awayTeamId,
          t,
          home: home.rows,
          away: away.rows,
          params: p,
          save: !!opts.save && g.status === "scheduled",
          withHist: opts.props === "hist",
        })
      : undefined;
  return {
    gameId: g.id,
    props,
    summary: proj.summary,
    fairSpread: fairLine(proj.sim, "spread"),
    fairTotal: fairLine(proj.sim, "total"),
    home,
    away,
    homeB2B: proj.homeB2B,
    awayB2B: proj.awayB2B,
    markets,
    modelSpread,
    modelTotal,
    targets: proj.targets,
    quotes: priced,
    projection: proj,
  };
}

/** Marknadens lagrating vid t ur tidigare matchers stängningslinjer (bara matcher före t). */
export async function marketRatingsAt(db: NbaPrisma, t: number): Promise<MarketRatings> {
  const lines = await loadMarketLines(db, new Date(t - MARKET_LINE_DAYS * 864e5), new Date(t), oddspapiBookmaker());
  return fitMarketRatings(lines, t);
}

/** Projicerar alla matcher som startar inom `hours`. */
export async function projectUpcoming(
  db: NbaPrisma,
  opts: { hours?: number; params?: NbaModelParams; refitRapm?: boolean; log?: (m: string) => void } = {}
) {
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
  const params = opts.params ?? DEFAULT_NBA_PARAMS;
  // Liga och lagrating ur samma historik för alla kvällens matcher.
  const league = leagueAverages(h, now, params);
  const ratings = params.ratingMix > 0 ? fitTeamRatings(h, now, params) : undefined;
  // RAPM: räknas om i dagskörningen (två säsonger stintar), annars läses den sparade.
  let rapm: RapmFit | undefined;
  if (params.rapmK > 0) {
    if (opts.refitRapm) {
      try {
        const stints = await loadStints(db, new Date(now - 800 * 864e5), { log });
        rapm = fitRapm(stints, now);
        const n = await savePlayerImpact(db, rapm);
        log(`RAPM: ${n} spelare ur ${rapm.stints} stintar`);
      } catch (e) {
        // Hellre gårdagens RAPM än ingen körning alls.
        log(`RAPM kunde inte räknas om (${e instanceof Error ? e.message.split("\n").pop() : e}) — använder den senast sparade`);
        rapm = await loadPlayerImpact(db);
      }
    } else rapm = await loadPlayerImpact(db);
  }
  // Marknadens lagrating: samma för kvällens alla matcher (linjer från matcher som redan spelats).
  const market = params.marketMix > 0 ? await marketRatingsAt(db, now) : undefined;
  let flagged = 0;
  for (const g of games) {
    const r = await projectStoredGame(db, g.id, { h, league, ratings, rapm, market, params, save: true, injuries, names });
    if (!r) continue;
    const s = r.summary;
    const f = r.quotes.filter((q) => q.flagged);
    flagged += f.length;
    log(
      `${teams.get(g.awayTeamId)} @ ${teams.get(g.homeTeamId)}  modell ${s.awayMean.toFixed(1)}–${s.homeMean.toFixed(1)}  ` +
        `spread ${fmtLine(r.modelSpread)} total ${r.modelTotal}  P(hemma) ${(s.pHomeWin * 100).toFixed(1)} %` +
        (Math.abs(r.targets.homeAdj) >= 0.5 || Math.abs(r.targets.awayAdj) >= 0.5
          ? `  uppställning ${r.targets.awayAdj >= 0 ? "+" : ""}${r.targets.awayAdj.toFixed(1)}/${r.targets.homeAdj >= 0 ? "+" : ""}${r.targets.homeAdj.toFixed(1)}`
          : "") +
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

/** Facit och CLV för låsta picks i spelade matcher. */
export { settleProps };

export async function settlePicks(db: NbaPrisma): Promise<number> {
  const open = await db.nbaPick.findMany({ where: { result: null }, include: { game: true } });
  let n = 0;
  for (const pk of open) {
    const g = pk.game;
    if (g.status !== "final" || g.homeScore == null || g.awayScore == null) continue;
    const market = pk.market as PickMarket;
    // Stängning: samma boks senaste linje före start.
    const close = await db.nbaOdds.findFirst({
      where: { gameId: g.id, market, book: pk.book, capturedAt: { lte: g.startAt } },
      orderBy: { capturedAt: "desc" },
    });
    const side = pk.side === 1 ? 1 : 2;
    await db.nbaPick.update({
      where: { id: pk.id },
      data: {
        result: gradePick(market, side, pk.line, g.homeScore, g.awayScore),
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        closingLine: close?.line ?? null,
        closingPrice: close ? (side === 1 ? close.price1 : close.price2) : null,
        clv: close?.line != null ? clvPoints(market, side, pk.line, close.line) : null,
      },
    });
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
