// Edge-screenen: prissätter varje skott- och hörnlinje böckerna erbjuder på
// kommande matcher och sorterar dem på edge.
//
// Bygger ligamodellen ur lagrade ShotMatch-rader och priserna ur lagrade
// ShotOddsSnapshot-rader — inga API-anrop här. Att fylla på med färska odds är
// `npm run shots:odds -- --upcoming --confirm`.

import { shotsPrisma as prisma } from "./shotsDb";
import {
  DEFAULT_BLEND_W,
  DEFAULT_SHARP_BOOKS,
  correlatedTotalPmf,
  negBinPmfVector,
  priceLine,
  negBinFamily,
  correlatedTotalFamily,
  type BookPrice,
  type MarketQuote,
  type MatchSide,
  type ShotMetric,
} from "./shotModel";
import { SHOT_LEAGUES, buildLeagueModel, projectFixture, type LeagueModel, type ShotMatchRow } from "./shotData";

export const SHOT_METRICS: ShotMetric[] = ["shots", "sot", "corners"];

export const METRIC_LABEL: Record<ShotMetric, string> = {
  shots: "Skott",
  sot: "Skott på mål",
  corners: "Hörnor",
};

/** Hur långt fram screenen tittar som default. */
export const DEFAULT_HORIZON_DAYS = 7;

export interface ShotScreenRow {
  matchId: string;
  leagueKey: string;
  leagueLabel: string;
  kickoffAt: string;
  homeTeam: string;
  awayTeam: string;

  metric: ShotMetric;
  metricLabel: string;
  side: MatchSide;
  /** "Malmö FF", "GAIS" eller "Matchen" — vem linjen avser. */
  sideLabel: string;
  line: number;

  lambda: number;
  dispersion: number;
  pModel: number;
  pMarket: number | null;
  /** Bookmakers bakom pMarket. Tom = ingen marknadsreferens, ren modell. */
  marketBooks: string[];
  /** false = referensen är ensidigt avviggad och därmed svagare. */
  marketTwoSided: boolean;
  pFinal: number;
  /** Modellvikten som användes i blenden. */
  blendW: number;
  pPush: number;
  fairOverOdds: number;
  fairUnderOdds: number;

  bestBook: string | null;
  bestSide: "over" | "under" | null;
  bestOdds: number | null;
  /** EV per satsad enhet. 0.04 = 4 %. */
  edge: number;

  /** Alla priser på linjen, för detaljvyn. */
  books: BookPrice[];
  ratings: {
    homeAttack: number;
    homeDefence: number;
    awayAttack: number;
    awayDefence: number;
  };
}

export interface ShotScreenMeta {
  leagues: Array<{
    key: string;
    label: string;
    matches: number;
    models: Array<{ metric: ShotMetric; dispersion: number; dispersionSample: number; homeAwayRho: number; homeMean: number; awayMean: number }>;
  }>;
  fixtures: number;
  pricedLines: number;
  blendW: number;
  horizonDays: number;
  /** true när inga odds finns lagrade alls — då är screenen tom av rätt skäl. */
  missingOdds: boolean;
}

export interface ShotScreenOptions {
  leagueKeys?: string[];
  metrics?: ShotMetric[];
  horizonDays?: number;
  blendW?: number;
  /** Lägsta edge som tas med, som andel (0.02 = 2 %). */
  minEdge?: number;
  limit?: number;
}

const MATCH_ROW_SELECT = {
  id: true,
  kickoffAt: true,
  homeTeamId: true,
  awayTeamId: true,
  homeShots: true,
  awayShots: true,
  homeSot: true,
  awaySot: true,
  homeCorners: true,
  awayCorners: true,
  homeXg: true,
  awayXg: true,
} as const;

/**
 * Modellens fördelning för en sida. Matchtotalen är faltningen av lagens två
 * fördelningar; lagsidorna använder sin egen direkt.
 */
function pmfForSide(
  lambdas: { home: number; away: number },
  dispersion: number,
  side: MatchSide,
  rho: number
): number[] {
  if (side === "home") return negBinPmfVector(lambdas.home, dispersion);
  if (side === "away") return negBinPmfVector(lambdas.away, dispersion);
  // Matchtotalen: lagen är negativt korrelerade, inte oberoende.
  return correlatedTotalPmf(lambdas.home, lambdas.away, dispersion, rho);
}

/** λ för en sida — matchtotalen är summan. */
function lambdaForSide(lambdas: { home: number; away: number }, side: MatchSide): number {
  if (side === "home") return lambdas.home;
  if (side === "away") return lambdas.away;
  return lambdas.home + lambdas.away;
}

/** En kommande match med modellens väntevärden, för prissättning av egna odds. */
export interface FixtureProjection {
  matchId: string;
  leagueKey: string;
  leagueLabel: string;
  kickoffAt: string;
  homeTeam: string;
  awayTeam: string;
  /** Per mätetal: λ för hemmalag, bortalag och matchtotal, plus dispersion. */
  metrics: Array<{
    metric: ShotMetric;
    metricLabel: string;
    home: number;
    away: number;
    total: number;
    dispersion: number;
    /** Korrelation hemma/borta — behövs för matchtotalen. */
    rho: number;
    /** Omkalibrering av sannolikheten; klienten måste applicera den. */
    calA: number;
    calB: number;
    calN: number;
  }>;
}

/**
 * Kommande matcher med modellens väntevärden per mätetal.
 *
 * Skild från `buildShotScreen`: den senare kräver lagrade bookmakerpriser och
 * kan bara visa linjer API:et känner till. Den här returnerar modellens siffror
 * utan odds, så priser från böcker API:et inte täcker (Betsson, Bethard,
 * NordicBet — alla med skottlinjer på Allsvenskan) kan matas in för hand.
 */
export async function buildFixtureProjections(
  opts: { leagueKeys?: string[]; horizonDays?: number } = {}
): Promise<FixtureProjection[]> {
  const leagues = opts.leagueKeys?.length
    ? SHOT_LEAGUES.filter((l) => opts.leagueKeys!.includes(l.key))
    : SHOT_LEAGUES;
  const horizonDays = opts.horizonDays ?? 10;
  const now = new Date();
  const until = new Date(now.getTime() + horizonDays * 86_400_000);

  const out: FixtureProjection[] = [];
  for (const league of leagues) {
    const history = (await prisma.shotMatch.findMany({
      where: { leagueKey: league.key, status: "finished", statsFetchedAt: { not: null } },
      orderBy: { kickoffAt: "asc" },
      select: MATCH_ROW_SELECT,
    })) as ShotMatchRow[];

    const models = new Map<ShotMetric, LeagueModel>();
    for (const metric of SHOT_METRICS) {
      const m = buildLeagueModel(history, metric);
      if (m) models.set(metric, m);
    }
    if (models.size === 0) continue;

    const fixtures = await prisma.shotMatch.findMany({
      where: { leagueKey: league.key, status: "scheduled", kickoffAt: { gte: now, lte: until } },
      orderBy: { kickoffAt: "asc" },
      select: {
        id: true,
        kickoffAt: true,
        homeTeamId: true,
        awayTeamId: true,
        homeTeamName: true,
        awayTeamName: true,
      },
    });

    for (const f of fixtures) {
      const metrics: FixtureProjection["metrics"] = [];
      for (const [metric, model] of models) {
        const l = projectFixture(model, f.homeTeamId, f.awayTeamId);
        metrics.push({
          metric,
          metricLabel: METRIC_LABEL[metric],
          home: l.home,
          away: l.away,
          total: l.total,
          // JSON kan inte bära Infinity — skicka ett stort tal som betyder Poisson.
          dispersion: Number.isFinite(model.dispersion) ? model.dispersion : 1e9,
          rho: model.appliedRho,
          calA: model.calibration.a,
          calB: model.calibration.b,
          calN: model.calibration.n,
        });
      }
      out.push({
        matchId: f.id,
        leagueKey: league.key,
        leagueLabel: league.label,
        kickoffAt: f.kickoffAt.toISOString(),
        homeTeam: f.homeTeamName,
        awayTeam: f.awayTeamName,
        metrics,
      });
    }
  }
  out.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
  return out;
}

export async function buildShotScreen(
  opts: ShotScreenOptions = {}
): Promise<{ rows: ShotScreenRow[]; meta: ShotScreenMeta }> {
  const leagues = opts.leagueKeys?.length
    ? SHOT_LEAGUES.filter((l) => opts.leagueKeys!.includes(l.key))
    : SHOT_LEAGUES;
  const metrics = opts.metrics?.length ? opts.metrics : SHOT_METRICS;
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const blendW = opts.blendW ?? DEFAULT_BLEND_W;
  const minEdge = opts.minEdge ?? 0;
  const limit = opts.limit ?? 300;

  const now = new Date();
  const until = new Date(now.getTime() + horizonDays * 86_400_000);

  const rows: ShotScreenRow[] = [];
  const metaLeagues: ShotScreenMeta["leagues"] = [];
  let fixtureCount = 0;
  let anyOdds = false;

  for (const league of leagues) {
    // Historik → ligamodell per mätetal.
    const history = (await prisma.shotMatch.findMany({
      where: { leagueKey: league.key, status: "finished", statsFetchedAt: { not: null } },
      orderBy: { kickoffAt: "asc" },
      select: MATCH_ROW_SELECT,
    })) as ShotMatchRow[];

    const models = new Map<ShotMetric, LeagueModel>();
    for (const metric of metrics) {
      const m = buildLeagueModel(history, metric);
      if (m) models.set(metric, m);
    }

    metaLeagues.push({
      key: league.key,
      label: league.label,
      matches: history.length,
      models: [...models.values()].map((m) => ({
        metric: m.metric,
        dispersion: m.dispersion,
        dispersionSample: m.dispersionSample,
        homeAwayRho: m.homeAwayRho,
        homeMean: m.baseline.homeMean,
        awayMean: m.baseline.awayMean,
      })),
    });

    if (models.size === 0) continue;

    // Kommande matcher inom horisonten.
    const fixtures = await prisma.shotMatch.findMany({
      where: {
        leagueKey: league.key,
        status: "scheduled",
        kickoffAt: { gte: now, lte: until },
      },
      orderBy: { kickoffAt: "asc" },
      select: {
        id: true,
        kickoffAt: true,
        homeTeamId: true,
        awayTeamId: true,
        homeTeamName: true,
        awayTeamName: true,
      },
    });
    fixtureCount += fixtures.length;
    if (fixtures.length === 0) continue;

    // Senast sedda priser för de matcherna.
    const odds = await prisma.shotOddsSnapshot.findMany({
      where: { matchId: { in: fixtures.map((f) => f.id) }, isClosing: true, metric: { in: metrics } },
      select: { matchId: true, bookmaker: true, metric: true, side: true, line: true, overOdds: true, underOdds: true },
    });
    if (odds.length > 0) anyOdds = true;

    // (matchId, metric, side, line) → priser per bok, för edgen.
    const grouped = new Map<string, { matchId: string; metric: ShotMetric; side: MatchSide; line: number; books: BookPrice[] }>();
    // (matchId, metric, side) → alla priser oavsett linje, för referensen.
    const quotesBySide = new Map<string, MarketQuote[]>();
    for (const o of odds) {
      const key = `${o.matchId}|${o.metric}|${o.side}|${o.line}`;
      let g = grouped.get(key);
      if (!g) {
        g = {
          matchId: o.matchId,
          metric: o.metric as ShotMetric,
          side: o.side as MatchSide,
          line: o.line,
          books: [],
        };
        grouped.set(key, g);
      }
      g.books.push({ bookmaker: o.bookmaker, overOdds: o.overOdds, underOdds: o.underOdds });

      const sideKey = `${o.matchId}|${o.metric}|${o.side}`;
      const list = quotesBySide.get(sideKey);
      const quote: MarketQuote = {
        bookmaker: o.bookmaker,
        line: o.line,
        overOdds: o.overOdds,
        underOdds: o.underOdds,
      };
      if (list) list.push(quote);
      else quotesBySide.set(sideKey, [quote]);
    }

    const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

    for (const g of grouped.values()) {
      const fixture = fixtureById.get(g.matchId);
      const model = models.get(g.metric);
      if (!fixture || !model) continue;

      const lambdas = projectFixture(model, fixture.homeTeamId, fixture.awayTeamId);
      const priced = priceLine({
        metric: g.metric,
        side: g.side,
        line: g.line,
        lambda: lambdaForSide(lambdas, g.side),
        dispersion: model.dispersion,
        // Matchtotalen faltas ur lagens två fördelningar; lagsidorna får sin
        // negativa binomial direkt ur λ.
        pmf: pmfForSide(lambdas, model.dispersion, g.side, model.appliedRho),
        // Marknadsreferensen måste översätta linjer med SAMMA fördelning som
        // modellen prissätter sidan med.
        pmfFor:
          g.side === "match"
            ? correlatedTotalFamily(
                model.dispersion,
                lambdas.total > 0 ? lambdas.home / lambdas.total : 0.5,
                model.appliedRho
              )
            : negBinFamily(model.dispersion),
        books: g.books,
        // Referensen vägs över samtliga linjer böckerna lagt på samma sida.
        marketQuotes: quotesBySide.get(`${g.matchId}|${g.metric}|${g.side}`),
        sharpBooks: DEFAULT_SHARP_BOOKS,
        blendW,
        calibration: model.calibration,
      });

      if (priced.edge < minEdge) continue;

      const homeRating = model.ratings.get(fixture.homeTeamId);
      const awayRating = model.ratings.get(fixture.awayTeamId);

      rows.push({
        matchId: g.matchId,
        leagueKey: league.key,
        leagueLabel: league.label,
        kickoffAt: fixture.kickoffAt.toISOString(),
        homeTeam: fixture.homeTeamName,
        awayTeam: fixture.awayTeamName,
        metric: g.metric,
        metricLabel: METRIC_LABEL[g.metric],
        side: g.side,
        sideLabel:
          g.side === "home" ? fixture.homeTeamName : g.side === "away" ? fixture.awayTeamName : "Matchen",
        line: g.line,
        lambda: priced.lambda,
        dispersion: priced.dispersion,
        pModel: priced.pModel,
        pMarket: priced.pMarket,
        marketBooks: priced.marketBooks,
        marketTwoSided: priced.marketTwoSided,
        pFinal: priced.pFinal,
        blendW: priced.blendW,
        pPush: priced.pPush,
        fairOverOdds: priced.fairOverOdds,
        fairUnderOdds: priced.fairUnderOdds,
        bestBook: priced.bestBook,
        bestSide: priced.bestSide,
        bestOdds: priced.bestOdds,
        edge: priced.edge,
        books: g.books,
        ratings: {
          homeAttack: homeRating?.attack ?? 1,
          homeDefence: homeRating?.defence ?? 1,
          awayAttack: awayRating?.attack ?? 1,
          awayDefence: awayRating?.defence ?? 1,
        },
      });
    }
  }

  rows.sort((a, b) => b.edge - a.edge);
  const pricedLines = rows.length;

  return {
    rows: rows.slice(0, limit),
    meta: {
      leagues: metaLeagues,
      fixtures: fixtureCount,
      pricedLines,
      blendW,
      horizonDays,
      missingOdds: !anyOdds,
    },
  };
}
