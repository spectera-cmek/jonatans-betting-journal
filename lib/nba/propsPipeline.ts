// Props för en sparad match: simulera varje spelare med kvällens minuter,
// prissätt alla färska prop-linjer och spara projektionen.
//
// Prissättningen (props-v2) förankras i Pinnacle: Pinnacles rättvisa
// sannolikhet flyttas till bokens linje med modellens spridning, och modellen
// lutar med en vikt per statistik som backtesten mot riktiga linjer satt
// (propPricing.ts). Utan färsk Pinnacle-linje prissätts mot bokens eget pris
// och flaggas aldrig.

import type { NbaPrisma } from "../nbaDb";
import { priceTwoWay } from "../cs2/pricing";
import { DEFAULT_NBA_PARAMS, isFlagged, type NbaModelParams } from "./params";
import {
  DEFAULT_PROP_PARAMS,
  PROP_MODEL_VERSION,
  PROP_OWN_BLEND_W,
  PROP_STATS,
  actualStat,
  histogram,
  overProb,
  simulatePlayer,
  summarizeSamples,
  type PropParams,
  type PropSamples,
  type PropStat,
  type PropSummary,
} from "./props";
import { propEnv } from "./propEnv";
import { playerRates, type History, type League, type PlayerRates } from "./ratings";
import { playerPropRates, scaleRates, usageMultipliers } from "./propRates";
import type { RatingTable } from "./teamRatings";
import { baseLineup, minutesIfPlaying, type MinutesRow } from "./minutes";
import { devigTwoWay } from "./devig";
import { ANCHOR_MAX_AGE_MIN, PROP_ANCHOR_W, PROP_DEVIG, mainLineOf, priceAnchoredProp, shapeOf, translate, type PinAnchor } from "./propPricing";

/** Marknadsreferensen (går inte att spela på i Sverige) — väljs inte som bästa linje. */
const REFERENCE_BOOK = (process.env.ODDSPAPI_BOOKMAKER ?? "pinnacle").toLowerCase();

/** Spelare under så här många minuter får ingen projektion. */
export const PROP_MIN_MINUTES = 8;

/**
 * Äldsta "senast sedd" som räknas som en öppen linje, per bok (minuter).
 * Kambi och Pinnacle (arcadia) fångas varje timme, OddsPapi två gånger om dagen.
 */
export const LINE_MAX_AGE_MIN: Record<string, number> = { kambi: 150, pinnacle: 150 };
const DEFAULT_LINE_MAX_AGE_MIN = 14 * 60;

export interface PropQuote {
  id: number;
  book: string;
  line: number;
  over: number;
  under: number;
  source: string;
  /** Modellens P(över | ingen push). */
  pModel: number;
  pPush: number;
  /** Bokens eget avviggade pris (visas för jämförelse). */
  pMarket: number | null;
  /** pinnacle = förankrat i Pinnacles rättvisa pris, own = bokens eget. */
  anchor: "pinnacle" | "own";
  /** Pinnacles rättvisa P(över) på den här linjen (anchor = pinnacle). */
  pAnchor: number | null;
  pFinal: number;
  edgeOver: number | null;
  edgeUnder: number | null;
  bestSide: "over" | "under" | null;
  edge: number | null;
  flagged: boolean;
}

export interface PlayerPropView {
  playerId: number;
  name: string;
  teamId: number;
  minutes: number;
  stats: Partial<
    Record<
      PropStat,
      PropSummary & {
        hist: number[];
        quotes: PropQuote[];
        /** Bästa priset (högst edge) bland böckerna. */
        best: PropQuote | null;
        /** Pinnacles huvudlinje (ankaret), med ålder i minuter. */
        pin: (PinAnchor & { ageMin: number; fair: number | null }) | null;
        /** Varians/medel i modellens fördelning (för översättning mellan linjer). */
        vmr: number;
      }
    >
  >;
}

/** Den gamla vägen: modellen mot bokens eget avviggade pris (används som reserv och i tester). */
export function priceProp(samples: Int16Array, line: number, over: number, under: number, w = PROP_OWN_BLEND_W) {
  const m = overProb(samples, line);
  const pr = priceTwoWay(m.p, m.push, over, under, w);
  return { pModel: pr.pModel, pPush: pr.pPush, pMarket: pr.pMarket, pFinal: pr.pFinal, edgeOver: pr.edgeOver, edgeUnder: pr.edgeUnder, bestSide: pr.bestSide, edge: pr.edge, bestOdds: pr.bestOdds };
}

export interface PropLineRow {
  id: number;
  playerId: number;
  stat: string;
  book: string;
  source: string;
  line: number;
  over: number;
  under: number;
  capturedAt: Date;
  seenAt: Date | null;
  maxStake: number | null;
}

const seenOf = (r: PropLineRow) => (r.seenAt ?? r.capturedAt).getTime();

/**
 * Öppna linjer vid `asOf`: per bok och källa bara rader från den senaste
 * fångsten (sedda inom 2 min från bokens senaste) och inte äldre än bokens
 * maxålder; senaste raden per spelare, statistik och linje. Egna (manuella)
 * linjer gäller alltid.
 */
export function freshLines(rows: PropLineRow[], asOf: number): PropLineRow[] {
  const usable = rows.filter((r) => r.capturedAt.getTime() <= asOf);
  const lastSeen = new Map<string, number>();
  for (const r of usable) {
    const k = `${r.book}|${r.source}`;
    lastSeen.set(k, Math.max(lastSeen.get(k) ?? 0, seenOf(r)));
  }
  const newest = new Map<string, PropLineRow>();
  for (const r of usable) {
    if (r.source !== "manual") {
      const latest = lastSeen.get(`${r.book}|${r.source}`) ?? 0;
      const maxAge = (LINE_MAX_AGE_MIN[r.book] ?? DEFAULT_LINE_MAX_AGE_MIN) * 60e3;
      if (seenOf(r) < latest - 2 * 60e3 || asOf - seenOf(r) > maxAge) continue;
    }
    const k = `${r.playerId}|${r.stat}|${r.book}|${r.source}|${r.line}|${r.source === "manual" ? r.id : ""}`;
    const cur = newest.get(k);
    if (!cur || r.capturedAt > cur.capturedAt) newest.set(k, r);
  }
  return [...newest.values()];
}

/**
 * Pinnacles ankare per spelare och statistik: huvudlinjen (jämnast pris) bland
 * de färskaste Pinnacle-raderna — Pinnacles webb-API (arcadia, varje timme)
 * före OddsPapi när båda finns.
 */
export function pinAnchors(lines: PropLineRow[]): Map<string, PinAnchor> {
  const by = new Map<string, PropLineRow[]>();
  for (const r of lines) {
    if (r.book !== "pinnacle") continue;
    const k = `${r.playerId}|${r.stat}`;
    { const l_ = by.get(k); if (l_) l_.push(r); else by.set(k, [r]); }
  }
  const out = new Map<string, PinAnchor>();
  for (const [k, rs] of by) {
    const pool = rs.some((r) => r.source === "arcadia") ? rs.filter((r) => r.source === "arcadia") : rs;
    const m = mainLineOf(pool);
    if (m) out.set(k, { line: m.line, over: m.over, under: m.under, maxStake: m.maxStake, seenAt: seenOf(m) });
  }
  return out;
}

async function loadPropLines(db: NbaPrisma, gameId: number): Promise<PropLineRow[]> {
  return db.nbaPropLine.findMany({
    where: { gameId },
    select: { id: true, playerId: true, stat: true, book: true, source: true, line: true, over: true, under: true, capturedAt: true, seenAt: true, maxStake: true },
  });
}

export async function gameProps(
  db: NbaPrisma,
  opts: {
    h: History;
    league: League;
    ratings?: RatingTable;
    gameId: number;
    homeId: number;
    awayId: number;
    t: number;
    home: MinutesRow[];
    away: MinutesRow[];
    params?: NbaModelParams;
    propParams?: PropParams;
    save?: boolean;
    withHist?: boolean;
    /** Tidpunkt för prissättningen (standard: nu, högst matchstart). */
    now?: number;
  }
): Promise<PlayerPropView[]> {
  const p = opts.params ?? DEFAULT_NBA_PARAMS;
  const pp = opts.propParams ?? DEFAULT_PROP_PARAMS;
  const now = Math.min(opts.now ?? Date.now(), opts.t);
  const lines = freshLines(await loadPropLines(db, opts.gameId), now);
  const anchors = pinAnchors(lines);
  const out: PlayerPropView[] = [];
  for (const [teamId, oppId, rows] of [
    [opts.homeId, opts.awayId, opts.home],
    [opts.awayId, opts.homeId, opts.away],
  ] as const) {
    const env = propEnv(opts.ratings, teamId, oppId);
    const rateCache = new Map<number, PlayerRates>();
    const rateOf = (id: number) => {
      let x = rateCache.get(id);
      if (!x) rateCache.set(id, (x = pp.rateModel ? playerPropRates(opts.h, id, opts.t, opts.league, pp) : playerRates(opts.h, id, opts.t, opts.league, p)));
      return x;
    };
    const tonight = rows.filter((x) => x.minutes > 0).map((x) => ({ playerId: x.playerId, minutes: x.minutes }));
    const mult = usageMultipliers(tonight, pp.usageBeta || pp.astBeta || pp.rebBeta ? baseLineup(opts.h, teamId, opts.t) : [], rateOf, pp);
    for (const r of rows) {
      // Props prisas på minuterna om han spelar — spelar han inte blir spelet ogiltigt.
      const minutes = minutesIfPlaying(r);
      if (minutes < PROP_MIN_MINUTES) continue;
      const rates = scaleRates(rateOf(r.playerId), mult.get(r.playerId));
      const samples: PropSamples = simulatePlayer(rates, minutes, env, pp, (opts.gameId * 31 + r.playerId) >>> 0);
      const view: PlayerPropView = { playerId: r.playerId, name: r.name, teamId, minutes, stats: {} };
      for (const stat of PROP_STATS) {
        const x = samples[stat];
        const vmr = shapeOf(x).vmr;
        const pin = anchors.get(`${r.playerId}|${stat}`) ?? null;
        const quotes: PropQuote[] = lines
          .filter((l) => l.playerId === r.playerId && l.stat === stat)
          .map((l) => {
            const m = overProb(x, l.line);
            const pr = priceAnchoredProp({ p: m.p, push: m.push, vmr }, l, pin, PROP_ANCHOR_W[stat], { now, ownW: PROP_OWN_BLEND_W });
            return {
              id: l.id,
              book: l.book,
              line: l.line,
              over: l.over,
              under: l.under,
              source: l.source,
              pModel: pr.pModel,
              pPush: pr.pPush,
              pMarket: devigTwoWay(l.over, l.under, "prop"),
              anchor: pr.anchor,
              pAnchor: pr.anchor === "pinnacle" ? pr.pAnchor : null,
              pFinal: pr.pFinal,
              edgeOver: pr.edgeOver,
              edgeUnder: pr.edgeUnder,
              bestSide: pr.bestSide,
              edge: pr.edge,
              // Flagga bara förankrade priser hos bolag du kan spela på.
              flagged: pr.anchor === "pinnacle" && l.book !== REFERENCE_BOOK && isFlagged(pr.edge, pr.bestOdds),
            };
          });
        // Bästa linjen bland bolag du kan spela på; Pinnacle (referensen) bara om inget annat finns.
        const bettable = quotes.filter((q) => q.book !== REFERENCE_BOOK);
        const pool = bettable.length ? bettable : quotes;
        const best = pool.reduce<PropQuote | null>((a, q) => (q.edge != null && (!a || (a.edge ?? -9) < q.edge) ? q : a), null);
        const pinView = pin ? { ...pin, ageMin: Math.round((now - pin.seenAt) / 60e3), fair: devigTwoWay(pin.over, pin.under, PROP_DEVIG) } : null;
        view.stats[stat] = { ...summarizeSamples(x), hist: opts.withHist ? histogram(x) : [], quotes, best, pin: pinView, vmr };
      }
      out.push(view);
    }
  }
  if (opts.save) await saveGameProps(db, opts.gameId, out);
  return out;
}

async function saveGameProps(db: NbaPrisma, gameId: number, views: PlayerPropView[]) {
  const picked = new Set(
    (await db.nbaPropPick.findMany({ where: { gameId }, select: { playerId: true, stat: true } })).map((x) => `${x.playerId}|${x.stat}`)
  );
  for (const v of views) {
    for (const stat of PROP_STATS) {
      const s = v.stats[stat];
      if (!s) continue;
      const b = s.best;
      const data = {
        teamId: v.teamId,
        minutes: v.minutes,
        mean: s.mean,
        median: s.median,
        q10: s.q10,
        q90: s.q90,
        vmr: s.vmr,
        line: b?.line ?? null,
        book: b?.book ?? null,
        over: b?.over ?? null,
        under: b?.under ?? null,
        pModel: b?.pModel ?? null,
        pPush: b?.pPush ?? null,
        pMarket: b?.pMarket ?? null,
        pFinal: b?.pFinal ?? null,
        edgeOver: b?.edgeOver ?? null,
        edgeUnder: b?.edgeUnder ?? null,
        anchor: b?.anchor ?? null,
        pAnchor: b?.pAnchor ?? null,
        pinLine: s.pin?.line ?? null,
        pinOver: s.pin?.over ?? null,
        pinUnder: s.pin?.under ?? null,
        pinMaxStake: s.pin?.maxStake ?? null,
        modelVersion: PROP_MODEL_VERSION,
      };
      await db.nbaPropProjection.upsert({
        where: { gameId_playerId_stat: { gameId, playerId: v.playerId, stat } },
        create: { gameId, playerId: v.playerId, stat, ...data },
        update: data,
      });
      // Låst pick: första gången spelaren och statistiken flaggas — skrivs aldrig över.
      const flagged = s.quotes.filter((q) => q.flagged).sort((a, c) => (c.edge ?? 0) - (a.edge ?? 0))[0];
      if (flagged && !picked.has(`${v.playerId}|${stat}`)) {
        const side = flagged.bestSide === "under" ? 2 : 1;
        await db.nbaPropPick.create({
          data: {
            gameId,
            playerId: v.playerId,
            stat,
            book: flagged.book,
            line: flagged.line,
            side,
            price: side === 1 ? flagged.over : flagged.under,
            pFinal: side === 1 ? flagged.pFinal : 1 - flagged.pFinal,
            pAnchor: flagged.pAnchor == null ? null : side === 1 ? flagged.pAnchor : 1 - flagged.pAnchor,
            pPush: flagged.pPush,
            vmr: s.vmr,
            edge: flagged.edge ?? 0,
            modelVersion: PROP_MODEL_VERSION,
          },
        });
        picked.add(`${v.playerId}|${stat}`);
      }
    }
  }
}

/** Pinnacles stängning för en spelare/statistik: huvudlinjen bland raderna som var öppna vid start. */
function pinCloseOf(rows: PropLineRow[], startMs: number): PinAnchor | null {
  const open = freshLines(rows, startMs);
  const pool = open.some((r) => r.source === "arcadia") ? open.filter((r) => r.source === "arcadia") : open;
  const m = mainLineOf(pool);
  return m ? { line: m.line, over: m.over, under: m.under, maxStake: m.maxStake, seenAt: seenOf(m) } : null;
}

/** Värde mot Pinnacles rättvisa stängning för en sida på en linje. */
export function evAgainstClose(close: PinAnchor, line: number, side: 1 | 2, price: number, vmr: number): { closeFair: number; evClose: number } | null {
  const p = devigTwoWay(close.over, close.under, PROP_DEVIG);
  if (p == null) return null;
  const tr = translate(p, close.line, line, vmr);
  const fair = side === 1 ? tr.p : 1 - tr.p;
  return { closeFair: fair, evClose: price * fair * (1 - tr.push) + tr.push - 1 };
}

/** Facit för prop-projektioner och låsta picks i spelade matcher, med CLV mot Pinnacles stängning. */
export async function settleProps(db: NbaPrisma): Promise<number> {
  const open = await db.nbaPropProjection.findMany({
    where: { actual: null },
    select: { id: true, gameId: true, playerId: true, stat: true, line: true, over: true, under: true, edgeOver: true, edgeUnder: true, vmr: true },
  });
  const openPicks = await db.nbaPropPick.findMany({ where: { result: null } });
  if (!open.length && !openPicks.length) return 0;
  const gameIds = [...new Set([...open.map((o) => o.gameId), ...openPicks.map((o) => o.gameId)])];
  const done = await db.nbaGame.findMany({ where: { id: { in: gameIds }, status: "final", boxFetchedAt: { not: null } }, select: { id: true, startAt: true } });
  const startOf = new Map(done.map((d) => [d.id, d.startAt.getTime()]));
  const box = await db.nbaPlayerGame.findMany({ where: { gameId: { in: [...startOf.keys()] } } });
  const byKey = new Map(box.map((b) => [`${b.gameId}|${b.playerId}`, b]));
  const pinRows = await db.nbaPropLine.findMany({
    where: { gameId: { in: [...startOf.keys()] }, book: "pinnacle" },
    select: { id: true, gameId: true, playerId: true, stat: true, book: true, source: true, line: true, over: true, under: true, capturedAt: true, seenAt: true, maxStake: true },
  });
  const pinBy = new Map<string, PropLineRow[]>();
  for (const r of pinRows) { const l_ = pinBy.get(`${r.gameId}|${r.playerId}|${r.stat}`); if (l_) l_.push(r); else pinBy.set(`${r.gameId}|${r.playerId}|${r.stat}`, [r]); }
  const closeOf = (gameId: number, playerId: number, stat: string) => pinCloseOf(pinBy.get(`${gameId}|${playerId}|${stat}`) ?? [], startOf.get(gameId)!);

  let n = 0;
  for (const o of open) {
    if (!startOf.has(o.gameId)) continue;
    const b = byKey.get(`${o.gameId}|${o.playerId}`);
    // Spelade inte (DNP eller saknas i boxscoren): projektionen tas bort — props blir void.
    if (!b || b.minutes <= 0) {
      await db.nbaPropProjection.delete({ where: { id: o.id } });
      continue;
    }
    let clv: { closeFair: number | null; evClose: number | null } = { closeFair: null, evClose: null };
    const close = closeOf(o.gameId, o.playerId, o.stat);
    if (close && o.line != null && o.over != null && o.under != null) {
      const side: 1 | 2 = (o.edgeOver ?? -9) >= (o.edgeUnder ?? -9) ? 1 : 2;
      const ev = evAgainstClose(close, o.line, side, side === 1 ? o.over : o.under, o.vmr ?? 1.3);
      const pOverClose = devigTwoWay(close.over, close.under, PROP_DEVIG);
      if (ev && pOverClose != null) clv = { closeFair: translate(pOverClose, close.line, o.line, o.vmr ?? 1.3).p, evClose: ev.evClose };
    }
    await db.nbaPropProjection.update({ where: { id: o.id }, data: { actual: actualStat(o.stat as PropStat, b), ...clv } });
    n++;
  }
  for (const pk of openPicks) {
    if (!startOf.has(pk.gameId)) continue;
    const b = byKey.get(`${pk.gameId}|${pk.playerId}`);
    if (!b || b.minutes <= 0) {
      await db.nbaPropPick.update({ where: { id: pk.id }, data: { result: "V" } });
      continue;
    }
    const actual = actualStat(pk.stat as PropStat, b);
    const close = closeOf(pk.gameId, pk.playerId, pk.stat);
    const ev = close ? evAgainstClose(close, pk.line, pk.side as 1 | 2, pk.price, pk.vmr ?? 1.3) : null;
    const result = actual === pk.line ? "P" : (pk.side === 1 ? actual > pk.line : actual < pk.line) ? "W" : "L";
    await db.nbaPropPick.update({ where: { id: pk.id }, data: { actual, result, closeFair: ev?.closeFair ?? null, evClose: ev?.evClose ?? null } });
  }
  return n;
}

export { ANCHOR_MAX_AGE_MIN };
