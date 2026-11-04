// Props för en sparad match: simulera varje spelare med kvällens minuter,
// prissätt mot alla sparade prop-linjer och spara projektionen.

import type { NbaPrisma } from "../nbaDb";
import { priceTwoWay } from "../cs2/pricing";
import { DEFAULT_NBA_PARAMS, NBA_MODEL_VERSION, isFlagged, type NbaModelParams } from "./params";
import {
  DEFAULT_PROP_PARAMS,
  PROP_BLEND_W,
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
import { playerRates, type History, type League } from "./ratings";
import type { RatingTable } from "./teamRatings";
import { minutesIfPlaying, type MinutesRow } from "./minutes";

/** Marknadsreferensen (går inte att spela på i Sverige) — väljs inte som bästa linje. */
const REFERENCE_BOOK = process.env.ODDSPAPI_BOOKMAKER ?? "pinnacle";

/** Spelare under så här många minuter får ingen projektion. */
export const PROP_MIN_MINUTES = 8;

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
  pMarket: number | null;
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
      }
    >
  >;
}

export function priceProp(samples: Int16Array, line: number, over: number, under: number, w = PROP_BLEND_W) {
  const m = overProb(samples, line);
  const pr = priceTwoWay(m.p, m.push, over, under, w);
  return { pModel: pr.pModel, pPush: pr.pPush, pMarket: pr.pMarket, pFinal: pr.pFinal, edgeOver: pr.edgeOver, edgeUnder: pr.edgeUnder, bestSide: pr.bestSide, edge: pr.edge, bestOdds: pr.bestOdds };
}

/** Senaste linje per bok, spelare och statistik. */
async function latestPropLines(db: NbaPrisma, gameId: number) {
  const rows = await db.nbaPropLine.findMany({ where: { gameId }, orderBy: { capturedAt: "desc" } });
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.playerId}|${r.stat}|${r.book}|${r.source === "manual" ? r.id : ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
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
  }
): Promise<PlayerPropView[]> {
  const p = opts.params ?? DEFAULT_NBA_PARAMS;
  const pp = opts.propParams ?? DEFAULT_PROP_PARAMS;
  const lines = await latestPropLines(db, opts.gameId);
  const out: PlayerPropView[] = [];
  for (const [teamId, oppId, rows] of [
    [opts.homeId, opts.awayId, opts.home],
    [opts.awayId, opts.homeId, opts.away],
  ] as const) {
    const env = propEnv(opts.ratings, teamId, oppId);
    for (const r of rows) {
      // Props prisas på minuterna om han spelar — spelar han inte blir spelet ogiltigt.
      const minutes = minutesIfPlaying(r);
      if (minutes < PROP_MIN_MINUTES) continue;
      const rates = playerRates(opts.h, r.playerId, opts.t, opts.league, p);
      const samples: PropSamples = simulatePlayer(rates, minutes, env, pp, (opts.gameId * 31 + r.playerId) >>> 0);
      const view: PlayerPropView = { playerId: r.playerId, name: r.name, teamId, minutes, stats: {} };
      for (const stat of PROP_STATS) {
        const x = samples[stat];
        const quotes: PropQuote[] = lines
          .filter((l) => l.playerId === r.playerId && l.stat === stat)
          .map((l) => {
            const pr = priceProp(x, l.line, l.over, l.under);
            return {
              id: l.id,
              book: l.book,
              line: l.line,
              over: l.over,
              under: l.under,
              source: l.source,
              pModel: pr.pModel,
              pPush: pr.pPush,
              pMarket: pr.pMarket,
              pFinal: pr.pFinal,
              edgeOver: pr.edgeOver,
              edgeUnder: pr.edgeUnder,
              bestSide: pr.bestSide,
              edge: pr.edge,
              flagged: isFlagged(pr.edge, pr.bestOdds),
            };
          });
        // Bästa linjen bland bolag du kan spela på; Pinnacle (referensen) bara om inget annat finns.
        const bettable = quotes.filter((q) => q.book !== REFERENCE_BOOK);
        const pool = bettable.length ? bettable : quotes;
        const best = pool.reduce<PropQuote | null>((a, q) => (q.edge != null && (!a || (a.edge ?? -9) < q.edge) ? q : a), null);
        view.stats[stat] = { ...summarizeSamples(x), hist: opts.withHist ? histogram(x) : [], quotes, best };
      }
      out.push(view);
    }
  }
  if (opts.save) {
    for (const v of out) {
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
          modelVersion: NBA_MODEL_VERSION,
        };
        await db.nbaPropProjection.upsert({
          where: { gameId_playerId_stat: { gameId: opts.gameId, playerId: v.playerId, stat } },
          create: { gameId: opts.gameId, playerId: v.playerId, stat, ...data },
          update: data,
        });
      }
    }
  }
  return out;
}

/** Facit för prop-projektioner i spelade matcher. */
export async function settleProps(db: NbaPrisma): Promise<number> {
  const open = await db.nbaPropProjection.findMany({ where: { actual: null }, select: { id: true, gameId: true, playerId: true, stat: true } });
  if (!open.length) return 0;
  const gameIds = [...new Set(open.map((o) => o.gameId))];
  const done = await db.nbaGame.findMany({ where: { id: { in: gameIds }, status: "final", boxFetchedAt: { not: null } }, select: { id: true } });
  const doneSet = new Set(done.map((d) => d.id));
  const box = await db.nbaPlayerGame.findMany({ where: { gameId: { in: [...doneSet] } } });
  const byKey = new Map(box.map((b) => [`${b.gameId}|${b.playerId}`, b]));
  let n = 0;
  for (const o of open) {
    if (!doneSet.has(o.gameId)) continue;
    const b = byKey.get(`${o.gameId}|${o.playerId}`);
    // Spelade inte (DNP eller saknas i boxscoren): projektionen tas bort — props blir void.
    if (!b || b.minutes <= 0) {
      await db.nbaPropProjection.delete({ where: { id: o.id } });
      continue;
    }
    await db.nbaPropProjection.update({ where: { id: o.id }, data: { actual: actualStat(o.stat as PropStat, b) } });
    n++;
  }
  return n;
}
