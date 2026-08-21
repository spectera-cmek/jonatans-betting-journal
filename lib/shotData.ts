// Kopplingen mellan lagrad matchdata och skottmodellen: ligaregister,
// uppslagning av competition_id, och byggandet av en färdig ligamodell
// (ligasnitt + ratings + dispersion) ur ShotMatch-rader.
//
// Delas av ingest-skripten, backtestet och /api/shots så att alla tre räknar
// på exakt samma sätt.

import { searchCompetitions, type StatsCompetition } from "./theStatsApi";
import {
  computeRatings,
  correlatedTotalPmf,
  fitCalibration,
  fitDispersion,
  leagueBaseline,
  lineProbs,
  negBinPmfVector,
  projectMatch,
  IDENTITY_CALIBRATION,
  type Calibration,
  type LeagueBaseline,
  type RatingOptions,
  type ShotMetric,
  type TeamMatchObs,
  type TeamRating,
} from "./shotModel";

export interface ShotLeague {
  /** Nyckel i CLI och URL:er. */
  key: string;
  label: string;
  /** Söktermer mot /football/competitions, i fallande prioritet. */
  search: string[];
  /** Land att matcha på — namnen skiljer sig mellan källor, landet gör det inte. */
  country: string;
  /**
   * Fast competition_id, när sökning inte duger. Europacuperna saknar land i
   * API:et, så landsmatchningen nedan skulle förkasta varje träff.
   */
  competitionId?: string;
  /** Ungefärligt antal matcher per säsong, för anropsbudgeten. */
  matchesPerSeason: number;
}

export const SHOT_LEAGUES: ShotLeague[] = [
  { key: "allsvenskan", label: "Allsvenskan", search: ["Allsvenskan"], country: "Sweden", matchesPerSeason: 240 },
  { key: "premier-league", label: "Premier League", search: ["Premier League"], country: "England", matchesPerSeason: 380 },
  { key: "laliga", label: "LaLiga", search: ["LaLiga", "La Liga", "Primera División"], country: "Spain", matchesPerSeason: 380 },
  // Europacuperna saknar land i API:et, så de slås upp på id i stället för
  // sökning + landsmatchning. Champions League är comp_3498 och Conference
  // League comp_408698 om registret ska breddas.
  {
    key: "europa-league",
    label: "Europa League",
    search: ["UEFA Europa League"],
    country: "",
    competitionId: "comp_7739",
    matchesPerSeason: 200,
  },
];

export function findLeague(key: string): ShotLeague | null {
  const k = key.trim().toLowerCase();
  return SHOT_LEAGUES.find((l) => l.key === k) ?? null;
}

const competitionCache = new Map<string, StatsCompetition>();

/**
 * Slår upp ligans competition_id.
 *
 * Två fällor: "Premier League" finns i ett dussin länder, så landet måste
 * stämma. Och en sökning på "LaLiga" träffar även "LaLiga 2" — därför vinner
 * exakt namnlikhet före ordningen i träfflistan. Utan det avgör API:ets
 * sorteringsordning vilken division modellen tränar på.
 */
export async function resolveCompetition(league: ShotLeague): Promise<StatsCompetition | null> {
  const cached = competitionCache.get(league.key);
  if (cached) return cached;

  // Fast id går före sökning — ingen tvetydighet att lösa.
  if (league.competitionId) {
    const hit = { id: league.competitionId, name: league.label };
    competitionCache.set(league.key, hit);
    return hit;
  }

  const wanted = league.country.toLowerCase();
  for (const term of league.search) {
    const hits = (await searchCompetitions(term)).filter(
      (c) => (c.country ?? "").toLowerCase() === wanted
    );
    if (hits.length === 0) continue;
    const exact = hits.find((c) => c.name.trim().toLowerCase() === term.trim().toLowerCase());
    const hit = exact ?? (hits.length === 1 ? hits[0] : null);
    if (hit) {
      competitionCache.set(league.key, hit);
      return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Från lagrade rader till observationer
// ---------------------------------------------------------------------------

/** Delmängden av ShotMatch som modellen faktiskt läser. */
export interface ShotMatchRow {
  id: string;
  kickoffAt: Date;
  homeTeamId: string;
  awayTeamId: string;
  homeShots: number | null;
  awayShots: number | null;
  homeSot: number | null;
  awaySot: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeXg: number | null;
  awayXg: number | null;
}

/**
 * Signaler en rating kan byggas på. Bredare än `ShotMetric`: xG är ingen
 * marknad man kan spela, men det är ett mindre brusigt mått på anfallstryck
 * än hörnor och därför en bättre prediktor för dem.
 */
export type RatingSource = ShotMetric | "xg";

export const RATING_SOURCES: RatingSource[] = ["shots", "sot", "corners", "xg"];

/** Hem- och bortavärde för en signal på en rad, eller null när den saknas. */
export function sourceValues(row: ShotMatchRow, source: RatingSource): { home: number; away: number } | null {
  const pair =
    source === "shots"
      ? [row.homeShots, row.awayShots]
      : source === "sot"
        ? [row.homeSot, row.awaySot]
        : source === "corners"
          ? [row.homeCorners, row.awayCorners]
          : [row.homeXg, row.awayXg];
  const [home, away] = pair;
  if (home == null || away == null) return null;
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home, away };
}

/** Hem- och bortavärde för ett spelbart mätetal. */
export function metricValues(row: ShotMatchRow, metric: ShotMetric): { home: number; away: number } | null {
  return sourceValues(row, metric);
}

/** Två observationer per match — en ur varje lags perspektiv. */
export function observationsFor(rows: ShotMatchRow[], metric: RatingSource): TeamMatchObs[] {
  const obs: TeamMatchObs[] = [];
  for (const row of rows) {
    const v = sourceValues(row, metric);
    if (!v) continue;
    const kickoffAt = row.kickoffAt.getTime();
    obs.push({
      teamId: row.homeTeamId,
      opponentId: row.awayTeamId,
      isHome: true,
      kickoffAt,
      produced: v.home,
      conceded: v.away,
    });
    obs.push({
      teamId: row.awayTeamId,
      opponentId: row.homeTeamId,
      isHome: false,
      kickoffAt,
      produced: v.away,
      conceded: v.home,
    });
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Ligamodell
// ---------------------------------------------------------------------------

export interface LeagueModel {
  metric: ShotMetric;
  baseline: LeagueBaseline;
  ratings: Map<string, TeamRating>;
  /** Negativ binomial-dispersion, skattad ur residualer utanför träningsdata. */
  dispersion: number;
  /** Antal matcher bakom modellen. */
  matches: number;
  /** Antal matcher dispersionen mättes på. 0 = för lite data, phi = Infinity. */
  dispersionSample: number;
  /**
   * Uppmätt korrelation mellan modellens prognosfel för de två lagen. Verklig
   * och negativ (−0,10 till −0,27 på hörnor), men används INTE som default —
   * se `useResidualRho`. Rapporteras för genomlysning.
   */
  homeAwayRho: number;
  /** ρ som faktiskt användes för matchtotalen. 0 om korrelationen är avstängd. */
  appliedRho: number;
  /**
   * Uppmätt omkalibrering. Rapporteras för genomlysning men appliceras bara
   * när `useCalibration` är på — se den flaggan för mätresultatet.
   */
  measuredCalibration: Calibration;
  /** Den kalibrering som faktiskt appliceras. Identitet om flaggan är av. */
  calibration: Calibration;
}

/** Pearson-korrelation, krympt mot 0 med `shrinkN` fiktiva observationer. */
function correlation(xs: number[], ys: number[], shrinkN: number): number {
  const n = xs.length;
  if (n < 10) return 0;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return 0;
  const r = num / Math.sqrt(dx * dy);
  if (!Number.isFinite(r)) return 0;
  return (r * n) / (n + shrinkN);
}

/**
 * Korrelation mellan hemma- och bortalagets RÅA utfall.
 *
 * Beskriver verkligheten (lagen delar på bollen ⇒ negativ), men är fel storhet
 * för matchtotalens spridning. Se `residualCorrelation`.
 */
export function homeAwayCorrelation(rows: ShotMatchRow[], metric: ShotMetric, shrinkN = 50): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const v = metricValues(r, metric);
    if (!v) continue;
    xs.push(v.home);
    ys.push(v.away);
  }
  return correlation(xs, ys, shrinkN);
}

/**
 * Korrelation mellan modellens PROGNOSFEL för hemma- och bortalaget.
 *
 * Det är den här — inte den råa utfallskorrelationen — som styr hur bred
 * matchtotalens fördelning ska vara. Var[X+Y] byggs av osäkerheten kring
 * modellens egna väntevärden, och den råa korrelationen blandar ihop två
 * motverkande saker: bollinnehavets nollsummespel (negativt) och
 * matchgemensamma faktorer som gör båda lagens utfall höga samtidigt
 * (positivt). Bara residualerna skiljer dem åt.
 */
export function residualCorrelation(
  samples: Array<{ homeActual: number; homeExpected: number; awayActual: number; awayExpected: number }>,
  shrinkN = 50
): number {
  const xs = samples.map((s) => s.homeActual - s.homeExpected);
  const ys = samples.map((s) => s.awayActual - s.awayExpected);
  return correlation(xs, ys, shrinkN);
}

/** Vikt per signal. Behöver inte summera till 1 — normaliseras. */
export type SignalWeights = Partial<Record<RatingSource, number>>;

export interface BuildModelOptions extends RatingOptions {
  /**
   * Andel av historiken (nyast) som hålls utanför rating-anpassningen och bara
   * används för att mäta dispersion. In-sample-residualer är för små och skulle
   * ge för tunna svansar — dvs. systematiskt överdriven edge på höga linjer.
   */
  holdoutFraction?: number;
  /**
   * Vilka signaler ratingen ska byggas på och med vilken vikt. Utelämnad
   * betyder ren självprediktion (hörnor ur hörnor), vilket är det backtestet
   * 2026-08-17 visade var för brusigt för att slå marknaden.
   */
  signalWeights?: SignalWeights;
  /**
   * Låt matchtotalen använda den uppmätta residualkorrelationen.
   *
   * Av som default, och det är ett mätresultat — inte en förbisedd detalj.
   * Korrelationen är verklig (−0,10 till −0,27 på hörnor), men modellens
   * fördelning är redan för smal: kalibreringen visar 67 % predikterat mot
   * 56 % utfall. Att smalna av den ytterligare förvärrade log-loss i alla tre
   * ligorna (Allsvenskan 0,6878 → 0,6887, PL 0,6998 → 0,7002). Slå på den
   * först när överkonfidensen är åtgärdad — då ska de två felen ta ut varandra.
   */
  useResidualRho?: boolean;
  /**
   * Applicera den uppmätta omkalibreringen på modellens sannolikheter.
   *
   * Av som default — även det ett mätresultat. Kalibreringen anpassas på
   * syntetiska trösklar kring λ, som spänner hela sannolikhetsskalan, medan
   * bookmakerlinjer klumpar ihop sig kring 50/50. Dessutom bygger holdouten på
   * 60 % av datan och är brusigare än modellen som faktiskt prissätter, så
   * krympningen blir för hård. Log-loss försämrades i alla tre ligorna
   * (Allsvenskan 0,6878 → 0,6916, PL 0,6997 → 0,7027, LaLiga 0,6949 → 0,6998)
   * och PL:s kalibrering gick från 63→51 till 63→44.
   *
   * Rätt väg om någon tar upp det igen: anpassa på faktiska bookmakerlinjer
   * i stället för syntetiska trösklar, och på samma ratingdjup som används
   * live.
   */
  useCalibration?: boolean;
}

const DEFAULT_HOLDOUT = 0.4;

/**
 * Sammanvägd rating över flera signaler.
 *
 * Ratings är multiplikativa faktorer kring 1,0, så de vägs geometriskt:
 *   attack = Π attack_s ^ w_s,  Σ w_s = 1
 * Aritmetiskt medelvärde skulle bryta symmetrin mellan ett lag som skjuter
 * dubbelt så mycket och ett som skjuter hälften.
 *
 * Poängen är brusreduktion: ett lag producerar ~5 hörnor men ~14 skott per
 * match, så skottratingen bygger på nästan tre gånger så många händelser och
 * skattar anfallstrycket stabilare än hörnorna själva gör.
 */
function blendRatings(
  perSource: Array<{ weight: number; ratings: Map<string, TeamRating> }>,
  teamIds: Set<string>
): Map<string, TeamRating> {
  const total = perSource.reduce((s, x) => s + x.weight, 0);
  const out = new Map<string, TeamRating>();
  if (total <= 0) return out;

  for (const teamId of teamIds) {
    let logAttack = 0;
    let logDefence = 0;
    let matches = 0;
    let weight = 0;
    let used = 0;
    for (const src of perSource) {
      const r = src.ratings.get(teamId);
      if (!r) continue;
      const w = src.weight / total;
      logAttack += w * Math.log(Math.max(1e-6, r.attack));
      logDefence += w * Math.log(Math.max(1e-6, r.defence));
      matches = Math.max(matches, r.matches);
      weight = Math.max(weight, r.weight);
      used += w;
    }
    if (used <= 0) continue;
    // Normalisera om någon signal saknades för just det här laget.
    out.set(teamId, {
      teamId,
      attack: Math.exp(logAttack / used),
      defence: Math.exp(logDefence / used),
      matches,
      weight,
    });
  }
  return out;
}

/** Ratings för en uppsättning rader, sammanvägda enligt `signalWeights`. */
function ratingsFor(
  rows: ShotMatchRow[],
  metric: ShotMetric,
  weights: SignalWeights | undefined,
  opts: RatingOptions
): Map<string, TeamRating> | null {
  const active = (Object.entries(weights ?? { [metric]: 1 }) as Array<[RatingSource, number]>).filter(
    ([, w]) => w > 0
  );
  if (active.length === 0) return null;

  const teamIds = new Set<string>();
  for (const r of rows) {
    teamIds.add(r.homeTeamId);
    teamIds.add(r.awayTeamId);
  }

  const perSource: Array<{ weight: number; ratings: Map<string, TeamRating> }> = [];
  for (const [source, weight] of active) {
    const obs = observationsFor(rows, source);
    const base = leagueBaseline(obs);
    if (!base) continue; // signalen saknas i den här ligan
    perSource.push({ weight, ratings: computeRatings(obs, base, opts) });
  }
  if (perSource.length === 0) return null;
  if (perSource.length === 1) return perSource[0].ratings;
  return blendRatings(perSource, teamIds);
}

/**
 * Bygger ligans modell för ett mätetal: ligasnitt, lagratings och dispersion.
 *
 * Ligasnittet kommer alltid från målmätetalet — det är hörnor som ska
 * prissättas. Bara *ratingen* får låna styrka från andra signaler.
 *
 * Dispersionen mäts på en holdout: ratings anpassas på den äldre delen av
 * historiken och residualerna räknas på den nyare. Backtestet gör samma sak
 * matchvis (walk-forward); det här är den billiga varianten som duger för
 * prissättning i realtid.
 */
export function buildLeagueModel(
  rows: ShotMatchRow[],
  metric: ShotMetric,
  opts: BuildModelOptions = {}
): LeagueModel | null {
  const usable = rows
    .filter((r) => metricValues(r, metric) !== null)
    .sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime());
  if (usable.length < 2) return null;

  const baseline = leagueBaseline(observationsFor(usable, metric));
  if (!baseline) return null;

  const ratings = ratingsFor(usable, metric, opts.signalWeights, opts);
  if (!ratings) return null;

  // Dispersion ur out-of-sample-residualer.
  const holdout = Math.min(0.9, Math.max(0, opts.holdoutFraction ?? DEFAULT_HOLDOUT));
  const splitIdx = Math.floor(usable.length * (1 - holdout));
  let dispersion = Infinity;
  let dispersionSample = 0;
  let rho = 0;
  let calibration: Calibration = IDENTITY_CALIBRATION;

  if (splitIdx >= 2 && splitIdx < usable.length) {
    const trainRows = usable.slice(0, splitIdx);
    const trainBaseline = leagueBaseline(observationsFor(trainRows, metric));
    const trainRatings = trainBaseline ? ratingsFor(trainRows, metric, opts.signalWeights, opts) : null;
    if (trainBaseline && trainRatings) {
      const samples: { observed: number; expected: number }[] = [];
      const pairs: Array<{ homeActual: number; homeExpected: number; awayActual: number; awayExpected: number }> = [];
      for (const row of usable.slice(splitIdx)) {
        const v = metricValues(row, metric)!;
        const p = projectMatch(
          trainRatings.get(row.homeTeamId),
          trainRatings.get(row.awayTeamId),
          trainBaseline
        );
        samples.push({ observed: v.home, expected: p.home });
        samples.push({ observed: v.away, expected: p.away });
        pairs.push({ homeActual: v.home, homeExpected: p.home, awayActual: v.away, awayExpected: p.away });
      }
      dispersion = fitDispersion(samples);
      dispersionSample = samples.length / 2;
      // ρ mäts på samma out-of-sample-residualer som dispersionen.
      rho = residualCorrelation(pairs);

      // Kalibreringen anpassas på samma holdout. Linjerna behöver inte komma
      // från en bookmaker — trösklar kring väntevärdet spänner upp hela
      // sannolikhetsskalan, och utfallet är känt.
      const appliedForFit = opts.useResidualRho ? rho : 0;
      const calSamples: Array<{ p: number; hit: number }> = [];
      for (const pr of pairs) {
        const sides: Array<{ pmf: number[]; actual: number; mu: number }> = [
          { pmf: negBinPmfVector(pr.homeExpected, dispersion), actual: pr.homeActual, mu: pr.homeExpected },
          { pmf: negBinPmfVector(pr.awayExpected, dispersion), actual: pr.awayActual, mu: pr.awayExpected },
          {
            pmf: correlatedTotalPmf(pr.homeExpected, pr.awayExpected, dispersion, appliedForFit),
            actual: pr.homeActual + pr.awayActual,
            mu: pr.homeExpected + pr.awayExpected,
          },
        ];
        for (const sd of sides) {
          const centre = Math.round(sd.mu);
          for (let k = centre - 3; k <= centre + 3; k++) {
            if (k < 0) continue;
            const line = k + 0.5; // halvlinje ⇒ ingen push
            calSamples.push({ p: lineProbs(sd.pmf, line).pOverNoPush, hit: sd.actual > line ? 1 : 0 });
          }
        }
      }
      calibration = fitCalibration(calSamples);
    }
  }

  return {
    metric,
    baseline,
    ratings,
    dispersion,
    matches: usable.length,
    dispersionSample,
    homeAwayRho: rho,
    appliedRho: opts.useResidualRho ? rho : 0,
    measuredCalibration: calibration,
    calibration: opts.useCalibration ? calibration : IDENTITY_CALIBRATION,
  };
}

/** Väntevärden för en kommande match ur ligamodellen. */
export function projectFixture(model: LeagueModel, homeTeamId: string, awayTeamId: string) {
  return projectMatch(model.ratings.get(homeTeamId), model.ratings.get(awayTeamId), model.baseline);
}
