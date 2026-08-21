// Skottmodellen — egna förväntningar på lagskott, skott på mål och hörnor.
//
// Kedjan: observerade matcher → attack/försvar-ratings per lag → väntevärde λ
// för en kommande match → negativ binomial fördelning → sannolikhet över/under
// en linje → fair odds. Marknadens avviggade pris blandas in separat.
//
// Rent räknande: inga Prisma-anrop, ingen fetch, inga datum-objekt utom epoch-
// millisekunder. Speglar lib/fairOdds.ts och lib/staking.ts så modulen är
// trivialt enhetstestbar.

import { devigOneSided, devigProportional, priceEdge } from "./fairOdds";

// Edge-beräkningen hör till modellens publika yta även om matten bor i
// fairOdds — anropare ska slippa veta var gränsen går.
export { priceEdge } from "./fairOdds";

/** Mätetalen modellen prissätter. */
export type ShotMetric = "shots" | "sot" | "corners";
/** Vem linjen avser: ett av lagen, eller matchtotalen. */
export type MatchSide = "home" | "away" | "match";

/** Halveringstid i matcher för recency-vikten. 10 ≈ en tredjedels säsong. */
export const DEFAULT_HALF_LIFE = 10;
/** Shrinkage mot ligasnittet, uttryckt som antal fiktiva snittmatcher. */
export const DEFAULT_SHRINK_K = 6;
/**
 * Modellvikt i blenden mot marknaden.
 *
 * Satt av backtestet 2026-08-17, inte gissad. Optimal vikt per liga och
 * mätetal låg på 0,00 (Allsvenskan hörnor, 629 linjer), 0,15 (PL hörnor, 289)
 * och 0,30 (LaLiga hörnor, 328) — och vinsten mot ren marknad var i bästa fall
 * 0,0007 i log-loss. Med andra ord: modellen slår ännu inte bet365/BetMGM på
 * hörnor. 0,15 är mitten av det spann backtestet stöder; höj den inte utan att
 * köra om `npm run shots:backtest` och se att minimum flyttat.
 */
export const DEFAULT_BLEND_W = 0.15;
/** Antal varv i den iterativa rating-anpassningen (schemastyrka). */
export const DEFAULT_ITERATIONS = 4;
/** Övre gräns för fördelningarnas stöd. Lagskott toppar ~35, matchtotal ~60. */
export const MAX_COUNT = 80;
/** phi över detta behandlas som Poisson (ingen mätbar överdispersion). */
export const POISSON_PHI = 1e6;

const P_EPS = 1e-9;
const clampProb = (p: number) => Math.min(1 - P_EPS, Math.max(P_EPS, p));
const finitePos = (x: number) => Number.isFinite(x) && x > 0;

// ---------------------------------------------------------------------------
// Fördelningar
// ---------------------------------------------------------------------------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(z) via Lanczos — behövs för negativ binomial i en enskild punkt. */
export function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const w = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (w + i + 1);
  const t = w + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (w + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * P(X = k) för X ~ NegBin med väntevärde `mean` och dispersion `phi` (NB2:
 * Var = mean + mean²/phi). phi → ∞ ger Poisson, som används direkt när phi
 * saknas eller är orimligt stor.
 */
export function negBinPmf(k: number, mean: number, phi: number): number {
  if (!Number.isInteger(k) || k < 0 || !finitePos(mean)) return 0;
  if (!finitePos(phi) || phi >= POISSON_PHI) {
    // Poisson: e^(−μ) μ^k / k!
    return Math.exp(-mean + k * Math.log(mean) - logGamma(k + 1));
  }
  const p = phi / (phi + mean);
  const logP =
    logGamma(k + phi) - logGamma(phi) - logGamma(k + 1) + phi * Math.log(p) + k * Math.log(1 - p);
  return Math.exp(logP);
}

/**
 * Hela pmf:en 0…maxK som vektor, via rekursionen
 *   P(k) = P(k−1) · (k−1+phi)/k · (1−p)
 * (Poisson-motsvarigheten P(k) = P(k−1)·μ/k när phi är oändlig). Snabbare och
 * stabilare än att anropa negBinPmf per punkt. Summerar till ~1 så länge maxK
 * ligger tillräckligt långt ut i svansen.
 */
export function negBinPmfVector(mean: number, phi: number, maxK: number = MAX_COUNT): number[] {
  const n = Math.max(0, Math.floor(maxK));
  const out = new Array<number>(n + 1).fill(0);
  if (!finitePos(mean)) {
    out[0] = 1;
    return out;
  }
  const poisson = !finitePos(phi) || phi >= POISSON_PHI;
  if (poisson) {
    out[0] = Math.exp(-mean);
    for (let k = 1; k <= n; k++) out[k] = (out[k - 1] * mean) / k;
    return out;
  }
  const p = phi / (phi + mean);
  out[0] = Math.pow(p, phi);
  for (let k = 1; k <= n; k++) out[k] = (out[k - 1] * (k - 1 + phi) * (1 - p)) / k;
  return out;
}

/** P(X ≥ k) ur en pmf-vektor. */
export function tailFromPmf(pmf: number[], k: number): number {
  if (k <= 0) return 1;
  let s = 0;
  for (let j = k; j < pmf.length; j++) s += pmf[j];
  return Math.min(1, Math.max(0, s));
}

/** P(X ≥ k) för X ~ NegBin(mean, phi). */
export function negBinAtLeast(k: number, mean: number, phi: number): number {
  if (k <= 0) return 1;
  if (!finitePos(mean)) return 0;
  let cdf = 0;
  const poisson = !finitePos(phi) || phi >= POISSON_PHI;
  const p = poisson ? 0 : phi / (phi + mean);
  let term = poisson ? Math.exp(-mean) : Math.pow(p, phi);
  cdf = term;
  for (let j = 1; j < k; j++) {
    term = poisson ? (term * mean) / j : (term * (j - 1 + phi) * (1 - p)) / j;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/**
 * Faltning av två pmf:er — matchtotalen är summan av lagens fördelningar.
 * Summan av två negativa binomialer har ingen sluten form när p skiljer sig,
 * så den räknas numeriskt. Antagandet om oberoende överskattar totalens
 * varians något (lagens skott är svagt negativt korrelerade via bollinnehav),
 * vilket drar fair odds åt det försiktiga hållet.
 */
export function convolvePmf(a: number[], b: number[], maxK: number = MAX_COUNT): number[] {
  const n = Math.max(0, Math.floor(maxK));
  const out = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < a.length && i <= n; i++) {
    if (a[i] === 0) continue;
    const lim = Math.min(b.length - 1, n - i);
    for (let j = 0; j <= lim; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispersion
// ---------------------------------------------------------------------------

export interface DispersionSample {
  observed: number;
  expected: number;
}

/**
 * Momentskattning av phi ur modellens egna residualer (Pearson-χ²):
 *   Σ (obs − μ)²/μ ≈ n + Σμ/phi   →   phi = Σμ / (χ² − n)
 * Underdispersion (χ² ≤ n) ger Infinity, dvs. rena Poisson-svansar.
 * Det här är den korrekta skattningen — den tar hänsyn till att väntevärdet
 * varierar mellan matcher. Använd fitDispersionFromCounts bara innan ratings
 * finns; den blandar in variationen mellan lag och överskattar dispersionen.
 */
export function fitDispersion(samples: DispersionSample[]): number {
  let chi2 = 0;
  let sumMu = 0;
  let n = 0;
  for (const s of samples) {
    if (!finitePos(s.expected) || !Number.isFinite(s.observed) || s.observed < 0) continue;
    const d = s.observed - s.expected;
    chi2 += (d * d) / s.expected;
    sumMu += s.expected;
    n += 1;
  }
  if (n < 2) return Infinity;
  const excess = chi2 - n;
  if (excess <= 0) return Infinity;
  return sumMu / excess;
}

/** Grov phi ur råa räknetal (Var/medel). Överskattar dispersionen — se ovan. */
export function fitDispersionFromCounts(counts: number[]): number {
  const xs = counts.filter((c) => Number.isFinite(c) && c >= 0);
  if (xs.length < 2) return Infinity;
  const mean = xs.reduce((s, c) => s + c, 0) / xs.length;
  if (!finitePos(mean)) return Infinity;
  const varr = xs.reduce((s, c) => s + (c - mean) * (c - mean), 0) / (xs.length - 1);
  if (varr <= mean) return Infinity;
  return (mean * mean) / (varr - mean);
}

// ---------------------------------------------------------------------------
// Kalibrering
// ---------------------------------------------------------------------------

/**
 * Platt-skalning: p_kalibrerad = σ(a + b·logit(p)).
 *
 * b < 1 drar extrema sannolikheter mot 50 % — precis vad en överkonfident
 * modell behöver. b = 1, a = 0 lämnar allt orört.
 */
export interface Calibration {
  a: number;
  b: number;
  /** Antal observationer bakom anpassningen. */
  n: number;
}

export const IDENTITY_CALIBRATION: Calibration = { a: 0, b: 1, n: 0 };

const logit = (p: number) => {
  const q = clampProb(p);
  return Math.log(q / (1 - q));
};
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Anpassar (a, b) med Newton-Raphson (IRLS) på log-oddsen.
 *
 * Ska anpassas på utfall modellen INTE sett — annars mäter man hur väl den
 * memorerat sitt eget stickprov och kalibreringen blir verkningslös i skarpt
 * läge. `b` klampas till [0.2, 1.5]: utanför det intervallet är anpassningen
 * driven av brus snarare än av systematisk skevhet.
 */
export function fitCalibration(samples: Array<{ p: number; hit: number }>, minN = 200): Calibration {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.p) || (s.hit !== 0 && s.hit !== 1)) continue;
    xs.push(logit(s.p));
    ys.push(s.hit);
  }
  const n = xs.length;
  if (n < minN) return { ...IDENTITY_CALIBRATION, n };

  let a = 0;
  let b = 1;
  for (let iter = 0; iter < 40; iter++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < n; i++) {
      const mu = sigmoid(a + b * xs[i]);
      const w = Math.max(1e-9, mu * (1 - mu));
      const r = ys[i] - mu;
      g0 += r;
      g1 += xs[i] * r;
      h00 += w;
      h01 += w * xs[i];
      h11 += w * xs[i] * xs[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da;
    b += db;
    if (Math.abs(da) < 1e-10 && Math.abs(db) < 1e-10) break;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ...IDENTITY_CALIBRATION, n };
  return { a, b: Math.min(1.5, Math.max(0.2, b)), n };
}

/** Applicerar kalibreringen på en sannolikhet. */
export function applyCalibration(p: number, cal: Calibration | null | undefined): number {
  if (!cal || cal.n === 0) return clampProb(p);
  return clampProb(sigmoid(cal.a + cal.b * logit(p)));
}

// ---------------------------------------------------------------------------
// Ligasnitt och ratings
// ---------------------------------------------------------------------------

/** En lagobservation ur en spelad match. Två per match — en per lag. */
export interface TeamMatchObs {
  teamId: string;
  opponentId: string;
  isHome: boolean;
  kickoffAt: number; // epoch ms
  produced: number; // mätetalet laget stod för
  conceded: number; // mätetalet motståndaren stod för
}

export interface LeagueBaseline {
  /** μ för hemmalaget, per match. */
  homeMean: number;
  /** μ för bortalaget, per match. */
  awayMean: number;
  matches: number;
}

/**
 * Ligans snitt per hemma- respektive bortalag. Hemmafördelen ligger i skillnaden
 * mellan de två — ingen separat HFA-multiplikator behövs.
 */
export function leagueBaseline(obs: TeamMatchObs[]): LeagueBaseline | null {
  let homeSum = 0;
  let homeN = 0;
  let awaySum = 0;
  let awayN = 0;
  for (const o of obs) {
    if (!Number.isFinite(o.produced) || o.produced < 0) continue;
    if (o.isHome) {
      homeSum += o.produced;
      homeN += 1;
    } else {
      awaySum += o.produced;
      awayN += 1;
    }
  }
  if (homeN === 0 || awayN === 0) return null;
  const homeMean = homeSum / homeN;
  const awayMean = awaySum / awayN;
  if (!finitePos(homeMean) || !finitePos(awayMean)) return null;
  return { homeMean, awayMean, matches: homeN };
}

export interface TeamRating {
  teamId: string;
  /** Multiplikator på ligasnittet för det laget producerar. 1.0 = snittlag. */
  attack: number;
  /** Multiplikator för vad motståndare producerar mot laget. <1 = bra försvar. */
  defence: number;
  /** Antal observationer bakom ratingen. */
  matches: number;
  /** Effektivt stickprov efter recency-vikt — låg siffra = osäker rating. */
  weight: number;
}

export interface RatingOptions {
  halfLife?: number;
  shrinkK?: number;
  iterations?: number;
  /**
   * Räkna bara på matcher som spelats före den här tidpunkten (epoch ms).
   * Avgörande i backtestet: utan den läcker facit in i ratingen.
   */
  asOf?: number;
}

/**
 * Attack- och försvarsratings via iterativ kvot-anpassning.
 *
 *   attack_t  = Σ w · produced / (μ_venue · defence_motståndare) / Σ w
 *   defence_t = Σ w · conceded / (μ_venue · attack_motståndare)  / Σ w
 *
 * Iterationerna korrigerar för schemastyrka: ett lag som mött enbart passiva
 * försvar ska inte belönas för sin skottvolym. Recency-vikten är
 * w = 0.5^(matcherSedan / halveringstid), räknad per lag. Shrinkage drar mot
 * 1.0 med styrkan `shrinkK` uttryckt i matcher — utan den blir nykomlingar
 * och tidiga säsongsmatcher rent brus.
 */
export function computeRatings(
  obs: TeamMatchObs[],
  baseline: LeagueBaseline,
  opts: RatingOptions = {}
): Map<string, TeamRating> {
  const halfLife = opts.halfLife ?? DEFAULT_HALF_LIFE;
  const shrinkK = opts.shrinkK ?? DEFAULT_SHRINK_K;
  const iterations = Math.max(1, opts.iterations ?? DEFAULT_ITERATIONS);
  const asOf = opts.asOf ?? Infinity;

  // Per lag: observationer sorterade nyast först, så index = "matcher sedan".
  const byTeam = new Map<string, TeamMatchObs[]>();
  for (const o of obs) {
    if (o.kickoffAt >= asOf) continue;
    if (!Number.isFinite(o.produced) || !Number.isFinite(o.conceded)) continue;
    const list = byTeam.get(o.teamId);
    if (list) list.push(o);
    else byTeam.set(o.teamId, [o]);
  }

  const ratings = new Map<string, TeamRating>();
  const weighted = new Map<string, { obs: TeamMatchObs[]; w: number[]; sumW: number }>();
  for (const [teamId, list] of byTeam) {
    list.sort((a, b) => b.kickoffAt - a.kickoffAt);
    const w = list.map((_, i) => Math.pow(0.5, i / halfLife));
    const sumW = w.reduce((s, x) => s + x, 0);
    weighted.set(teamId, { obs: list, w, sumW });
    ratings.set(teamId, { teamId, attack: 1, defence: 1, matches: list.length, weight: sumW });
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Jacobi: läs föregående varvs värden, skriv nya först när alla räknats.
    const prev = new Map<string, { attack: number; defence: number }>();
    for (const [id, r] of ratings) prev.set(id, { attack: r.attack, defence: r.defence });
    const oppAttack = (id: string) => prev.get(id)?.attack ?? 1;
    const oppDefence = (id: string) => prev.get(id)?.defence ?? 1;

    for (const [teamId, { obs: list, w, sumW }] of weighted) {
      let attackNum = 0;
      let defenceNum = 0;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const muFor = o.isHome ? baseline.homeMean : baseline.awayMean;
        const muAgainst = o.isHome ? baseline.awayMean : baseline.homeMean;
        attackNum += (w[i] * o.produced) / (muFor * oppDefence(o.opponentId));
        defenceNum += (w[i] * o.conceded) / (muAgainst * oppAttack(o.opponentId));
      }
      const r = ratings.get(teamId)!;
      // Shrinkage mot 1.0: k fiktiva snittmatcher läggs till både täljare och
      // nämnare, så få matcher ⇒ ratingen ligger kvar nära ligasnittet.
      r.attack = (attackNum + shrinkK) / (sumW + shrinkK);
      r.defence = (defenceNum + shrinkK) / (sumW + shrinkK);
    }
  }

  return ratings;
}

// ---------------------------------------------------------------------------
// Projektion
// ---------------------------------------------------------------------------

export interface MatchLambdas {
  home: number;
  away: number;
  total: number;
}

/**
 * Väntevärde för en kommande match:
 *   λ_hemma = μ_hemma · attack_hemma · försvar_borta
 *   λ_borta = μ_borta · attack_borta · försvar_hemma
 * Saknad rating (nykomling utan historik) faller tillbaka på 1.0, dvs. exakt
 * ligasnittet — rätt default när inget är känt.
 */
export function projectMatch(
  home: TeamRating | null | undefined,
  away: TeamRating | null | undefined,
  baseline: LeagueBaseline
): MatchLambdas {
  const ha = home?.attack ?? 1;
  const hd = home?.defence ?? 1;
  const aa = away?.attack ?? 1;
  const ad = away?.defence ?? 1;
  const h = baseline.homeMean * ha * ad;
  const a = baseline.awayMean * aa * hd;
  return { home: h, away: a, total: h + a };
}

// ---------------------------------------------------------------------------
// Linjer
// ---------------------------------------------------------------------------

export interface LineProbs {
  pOver: number;
  pUnder: number;
  /** > 0 bara på heltalslinjer (Ö10 hörnor), där insatsen returneras. */
  pPush: number;
  /** P(över | inte push) — det är på den fair odds sätts. */
  pOverNoPush: number;
}

/**
 * Sannolikheter kring en linje ur en pmf. Halvlinjer (9.5) kan inte pusha;
 * heltalslinjer (10) gör det, och böckerna returnerar insatsen — därför räknas
 * fair odds på den betingade sannolikheten utan push.
 */
export function lineProbs(pmf: number[], line: number): LineProbs {
  if (!Number.isFinite(line) || line < 0) {
    return { pOver: 0, pUnder: 1, pPush: 0, pOverNoPush: 0 };
  }
  const isWhole = Number.isInteger(line);
  const overFrom = isWhole ? line + 1 : Math.ceil(line);
  const pOver = tailFromPmf(pmf, overFrom);
  const pPush = isWhole ? (pmf[line] ?? 0) : 0;
  const pUnder = Math.max(0, 1 - pOver - pPush);
  const live = pOver + pUnder;
  return {
    pOver,
    pUnder,
    pPush,
    pOverNoPush: live > 0 ? pOver / live : 0,
  };
}

/** Fair decimalodds ur en sannolikhet. */
export function fairOdds(p: number): number {
  return 1 / clampProb(p);
}

// ---------------------------------------------------------------------------
// Marknad och blend
// ---------------------------------------------------------------------------

/**
 * Marknadens fair P(över) för en linje: tvåvägs avviggning när båda sidor är
 * prissatta, annars ensidig med antagen marginal. Återanvänder de-vig-matten
 * i lib/fairOdds.ts.
 */
export function marketProbOver(
  overOdds: number | null | undefined,
  underOdds: number | null | undefined,
  marginPct?: number
): number | null {
  if (!finitePos(overOdds ?? NaN) || (overOdds as number) <= 1) return null;
  const o = overOdds as number;
  const u = underOdds ?? null;
  const d = u != null && u > 1 ? devigProportional(o, [u]) : devigOneSided(o, marginPct);
  return d ? d.p : null;
}

/**
 * Inverterar en över-sannolikhet till ett väntevärde: det λ som ger
 * P(X > line) = pOver för X ~ NegBin(λ, phi). Tailen är strikt växande i λ,
 * så bisektion räcker.
 *
 * Det här är nyckeln till att jämföra böcker som lägger olika linjer: bet365
 * hörnor Ö10,5 och BetMGM Ö13,5 säger båda något om samma match, men kan bara
 * vägas ihop via λ — inte via sannolikheter på var sin linje.
 */
/** Variansen för NegBin(mean, phi): μ + μ²/φ. */
export function negBinVariance(mean: number, phi: number): number {
  if (!finitePos(phi) || phi >= POISSON_PHI) return mean; // Poisson
  return mean + (mean * mean) / phi;
}

/**
 * Matchtotalens fördelning när lagen INTE är oberoende.
 *
 * Uppmätt på 3 791 matcher är korrelationen mellan hemma- och bortalagets
 * produktion konsekvent negativ: skott −0,32 till −0,38, hörnor −0,21 till
 * −0,35, likadant i alla tre ligorna. Lagen delar på bollen, så skjuter det ena
 * mycket skjuter det andra mindre.
 *
 * Att falta fördelningarna som oberoende ignorerar det och ger en total som är
 * omkring 15–20 % för bred. Här matchas i stället de två första momenten:
 *   E[X+Y]   = μ_h + μ_a                     (korrelationen påverkar inte medel)
 *   Var[X+Y] = Var_h + Var_a + 2ρ√(Var_h·Var_a)
 * och en negativ binomial anpassas till dem.
 *
 * Blir variansen mindre än medelvärdet är fördelningen underdispergerad, vilket
 * en negativ binomial inte kan representera — då används Poisson, som är den
 * smalaste familjen den här matten har. Det underskattar hur smal totalen
 * faktiskt är, men åt det försiktiga hållet.
 */
export function correlatedTotalPmf(
  lambdaHome: number,
  lambdaAway: number,
  phi: number,
  rho: number,
  maxK: number = MAX_COUNT
): number[] {
  const mean = lambdaHome + lambdaAway;
  if (!finitePos(mean)) {
    const out = new Array<number>(Math.max(0, Math.floor(maxK)) + 1).fill(0);
    out[0] = 1;
    return out;
  }
  const r = Math.min(0.9, Math.max(-0.9, Number.isFinite(rho) ? rho : 0));
  const vh = negBinVariance(lambdaHome, phi);
  const va = negBinVariance(lambdaAway, phi);
  const variance = vh + va + 2 * r * Math.sqrt(vh * va);

  // Underdispersion — negativ binomial klarar det inte, Poisson är golvet.
  if (variance <= mean) return negBinPmfVector(mean, Infinity, maxK);

  const phiTotal = (mean * mean) / (variance - mean);
  return negBinPmfVector(mean, phiTotal, maxK);
}

/**
 * Bygger fördelningen för ett givet väntevärde. Måste vara SAMMA familj som
 * modellen prissätter sidan med — annars blir linjeöversättningen inkonsekvent.
 */
export type PmfBuilder = (mean: number) => number[];

/** Standardfamiljen: en negativ binomial med fast dispersion. */
export function negBinFamily(phi: number): PmfBuilder {
  return (mean) => negBinPmfVector(mean, phi);
}

/**
 * Familjen för en matchtotal: totalen delas mellan lagen i `homeShare` och
 * delarna faltas. Utan det här skulle en marknadsreferens på matchtotalen
 * läsas av på en bredare fördelning än den modellen själv använder, vilket
 * blåser upp edgen på de yttersta linjerna.
 */
export function convolvedFamily(phi: number, homeShare: number): PmfBuilder {
  const share = Math.min(0.95, Math.max(0.05, homeShare));
  return (mean) =>
    convolvePmf(negBinPmfVector(mean * share, phi), negBinPmfVector(mean * (1 - share), phi));
}

/**
 * Familjen för en matchtotal med uppmätt samvariation mellan lagen. Ersätter
 * `convolvedFamily` överallt där ρ är känd — faltningen antar oberoende och
 * ger en total som är mätbart för bred.
 */
export function correlatedTotalFamily(phi: number, homeShare: number, rho: number): PmfBuilder {
  const share = Math.min(0.95, Math.max(0.05, homeShare));
  return (mean) => correlatedTotalPmf(mean * share, mean * (1 - share), phi, rho);
}

export function lambdaFromLineProb(line: number, pOver: number, pmfFor: PmfBuilder): number | null {
  if (!Number.isFinite(line) || line < 0 || !Number.isFinite(pOver)) return null;
  const target = clampProb(pOver);
  let lo = 0;
  let hi = MAX_COUNT / 2; // långt bortom vad någon lagmarknad ligger på
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = lineProbs(pmfFor(mid), line).pOverNoPush;
    if (p < target) lo = mid;
    else hi = mid;
  }
  const lambda = (lo + hi) / 2;
  return lambda > 0 ? lambda : null;
}

/** Ett bookmakerpris på en bestämd linje. */
export interface MarketQuote {
  bookmaker: string;
  line: number;
  overOdds: number | null;
  underOdds: number | null;
}

export interface MarketReference {
  /** Marknadens fair P(över) på den efterfrågade linjen. */
  p: number;
  /** Bookmakers som bidrog, i den ordning de lästes. */
  books: string[];
  /** true = minst en bok prissatte båda sidor (riktig tvåvägsavviggning). */
  twoSided: boolean;
  /** Marknadens implicita väntevärde, medelvärdat över böckerna. */
  lambda: number;
}

/**
 * Marknadsreferens för en linje, vägd över alla böcker — även de som lagt
 * en annan linje.
 *
 * Två saker gör den här formen nödvändig i praktiken:
 *
 * 1. Pinnacle och Betfair Exchange prissätter aldrig skott- och hörnmarknader,
 *    så det finns ingen skarp bok att luta sig mot. Ordningen är därför skarp
 *    bok om den mot förmodan finns, annars konsensus av de mjuka.
 * 2. Böckerna lägger sällan samma linje — bet365 hörnor Ö10,5 mot BetMGM
 *    Ö13,5. I mätdata överlappade bara 5 % av linjegrupperna. En konsensus som
 *    kräver identisk linje går därför nästan aldrig igång.
 *
 * Lösningen är att gå via väntevärdet: varje boks pris avviggas på SIN linje,
 * inverteras till ett implicit λ, och λ:na medelvärdas. Referenssannolikheten
 * läses sedan av på den efterfrågade linjen. Det gör alla böcker jämförbara
 * oavsett var de lagt sina linjer.
 *
 * Tvåsidiga priser går före ensidiga: en riktig Ö/U-avviggning bär marknadens
 * egen bedömning, medan ensidig avviggning bara är oddset delat med en antagen
 * marginal. Blanda inte de två i samma medelvärde.
 */
export function marketConsensus(
  quotes: MarketQuote[],
  targetLine: number,
  opts: { pmfFor: PmfBuilder; preferBooks?: string[]; marginPct?: number }
): MarketReference | null {
  const { pmfFor, preferBooks = [], marginPct } = opts;

  /** Boken → implicit λ, eller null när priset inte går att tolka. */
  const impliedLambda = (q: MarketQuote): { lambda: number; twoSided: boolean } | null => {
    const hasOver = q.overOdds != null && q.overOdds > 1;
    const hasUnder = q.underOdds != null && q.underOdds > 1;
    if (!hasOver) return null;
    const d = hasUnder
      ? devigProportional(q.overOdds as number, [q.underOdds as number])
      : devigOneSided(q.overOdds as number, marginPct);
    if (!d) return null;
    const lambda = lambdaFromLineProb(q.line, d.p, pmfFor);
    return lambda == null ? null : { lambda, twoSided: hasUnder };
  };

  const evaluate = (lambda: number) => lineProbs(pmfFor(lambda), targetLine).pOverNoPush;

  // 1. Skarp bok, om någon prissatt mätetalet över huvud taget.
  for (const name of preferBooks) {
    const q = quotes.find((x) => x.bookmaker === name);
    if (!q) continue;
    const hit = impliedLambda(q);
    if (hit) {
      return {
        p: clampProb(evaluate(hit.lambda)),
        books: [q.bookmaker],
        twoSided: hit.twoSided,
        lambda: hit.lambda,
      };
    }
  }

  // 2. Konsensus av de mjuka böckerna — ETT λ per bok, inte per kvot.
  //
  // Böcker lägger olika många linjer på samma sida (Paddy Power kan ha fyra
  // hörnlinjer där bet365 har en). Utan att först väga samman inom boken får
  // den som kvoterar flest linjer flest röster, vilket är fel: det är antalet
  // oberoende bedömningar som ska räknas, inte antalet prislappar.
  const perBook = new Map<string, { two: number[]; one: number[] }>();
  for (const q of quotes) {
    const hit = impliedLambda(q);
    if (!hit) continue;
    let entry = perBook.get(q.bookmaker);
    if (!entry) {
      entry = { two: [], one: [] };
      perBook.set(q.bookmaker, entry);
    }
    (hit.twoSided ? entry.two : entry.one).push(hit.lambda);
  }

  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  // En bok som har tvåsidiga priser bidrar bara med dem — ensidiga bär mindre
  // information och ska inte spä ut bokens egen bedömning.
  const perBookLambda: Array<{ book: string; lambda: number; twoSided: boolean }> = [];
  for (const [book, { two, one }] of perBook) {
    if (two.length > 0) perBookLambda.push({ book, lambda: mean(two), twoSided: true });
    else if (one.length > 0) perBookLambda.push({ book, lambda: mean(one), twoSided: false });
  }

  // Finns tvåsidiga böcker alls, låt bara dem bestämma.
  const anyTwoSided = perBookLambda.some((x) => x.twoSided);
  const pick = anyTwoSided ? perBookLambda.filter((x) => x.twoSided) : perBookLambda;
  if (pick.length === 0) return null;

  const lambda = mean(pick.map((x) => x.lambda));
  return {
    p: clampProb(evaluate(lambda)),
    books: pick.map((x) => x.book),
    twoSided: anyTwoSided,
    lambda,
  };
}

/**
 * Blend av modell och marknad: p = w·p_modell + (1−w)·p_marknad.
 * Utan marknadspris återstår bara modellen. Vikten ska sättas av backtestet.
 */
export function blendProb(pModel: number, pMarket: number | null, w: number = DEFAULT_BLEND_W): number {
  if (pMarket == null || !Number.isFinite(pMarket)) return clampProb(pModel);
  const weight = Math.min(1, Math.max(0, w));
  return clampProb(weight * pModel + (1 - weight) * pMarket);
}

// ---------------------------------------------------------------------------
// Prissättning av en linje, hela vägen
// ---------------------------------------------------------------------------

export interface BookPrice {
  bookmaker: string;
  overOdds: number | null;
  underOdds: number | null;
}

export interface PricedLine {
  metric: ShotMetric;
  side: MatchSide;
  line: number;
  lambda: number;
  dispersion: number;
  pModel: number; // modellens P(över), betingat på ingen push
  pMarket: number | null; // marknadens P(över), null när ingen bok prissatt linjen
  /** Bookmakers bakom pMarket. Tom = ren modell, inget marknadsankare. */
  marketBooks: string[];
  /** false = referensen kommer ur ensidig avviggning och är svagare. */
  marketTwoSided: boolean;
  pFinal: number; // blenden
  blendW: number;
  fairOverOdds: number;
  fairUnderOdds: number;
  pPush: number;
  bestBook: string | null;
  bestSide: "over" | "under" | null;
  bestOdds: number | null;
  /** EV per satsad enhet mot bästa pris. 0.04 = 4 % edge. */
  edge: number;
}

export interface PriceLineInput {
  metric: ShotMetric;
  side: MatchSide;
  line: number;
  lambda: number;
  dispersion: number;
  /**
   * Priserna PÅ den här linjen. Edgen räknas bara mot dessa — du kan bara
   * spela den linje boken faktiskt erbjuder.
   */
  books: BookPrice[];
  /**
   * Alla priser på samma (mätetal, sida), oavsett linje — underlaget för
   * marknadsreferensen. Böckerna lägger sällan samma linje, så referensen
   * vägs via implicit λ. Utelämnas den används `books` på den egna linjen.
   */
  marketQuotes?: MarketQuote[];
  /** Bookmakers som räknas som skarpa, i fallande prioritet. */
  sharpBooks?: string[];
  blendW?: number;
  /** Antagen marginal vid ensidig avviggning. */
  marginPct?: number;
  /**
   * Färdig fördelning att prissätta på, i stället för en negativ binomial ur
   * `lambda`. Krävs för matchtotaler: summan av två negativa binomialer är
   * inte själv negativ binomial, utan måste faltas (convolvePmf). `lambda`
   * används då bara för visning.
   */
  pmf?: number[];
  /**
   * Fördelningsfamiljen marknadsreferensen ska översätta linjer med. Måste
   * matcha `pmf` — för matchtotaler `convolvedFamily`, annars `negBinFamily`.
   */
  pmfFor?: PmfBuilder;
  /**
   * Omkalibrering av modellens sannolikhet, anpassad utanför träningsdata.
   * Appliceras FÖRE blenden — marknadens pris ska inte kalibreras om.
   */
  calibration?: Calibration;
}

/** Default-prioritet för den skarpa referensen: börsen först, sedan Pinnacle. */
export const DEFAULT_SHARP_BOOKS = ["betfair-exchange", "pinnacle"];

/**
 * Prissätter en linje hela vägen: modellens fördelning → P(över) → blend mot
 * skarp marknad → fair odds → bästa tillgängliga pris och edge.
 *
 * Edgen räknas mot den sida modellen faktiskt gillar, och mot det bästa priset
 * på den sidan bland *alla* böcker — inklusive de skarpa. Att jämföra mot ett
 * pris man själv använt som referens ger noll edge per konstruktion, vilket är
 * korrekt: finns edgen bara mot referensen är den inte verklig.
 */
export function priceLine(input: PriceLineInput): PricedLine {
  const {
    metric,
    side,
    line,
    lambda,
    dispersion,
    books,
    sharpBooks = DEFAULT_SHARP_BOOKS,
    blendW = DEFAULT_BLEND_W,
    marginPct,
    pmf: pmfOverride,
    pmfFor,
    calibration,
  } = input;

  const pmf = pmfOverride ?? negBinPmfVector(lambda, dispersion);
  const lp = lineProbs(pmf, line);
  const pModel = applyCalibration(lp.pOverNoPush, calibration);

  // Referensen får se alla linjer; edgen längre ned bara den egna.
  const quotes: MarketQuote[] =
    input.marketQuotes ??
    books.map((b) => ({ bookmaker: b.bookmaker, line, overOdds: b.overOdds, underOdds: b.underOdds }));
  const ref = marketConsensus(quotes, line, {
    pmfFor: pmfFor ?? negBinFamily(dispersion),
    preferBooks: sharpBooks,
    marginPct,
  });
  const pMarket = ref?.p ?? null;
  const pFinal = blendProb(pModel, pMarket, blendW);

  // Bästa pris på vardera sidan, oavsett bok.
  let bestOver: { bookmaker: string; odds: number } | null = null;
  let bestUnder: { bookmaker: string; odds: number } | null = null;
  for (const b of books) {
    if (b.overOdds != null && b.overOdds > 1 && (!bestOver || b.overOdds > bestOver.odds)) {
      bestOver = { bookmaker: b.bookmaker, odds: b.overOdds };
    }
    if (b.underOdds != null && b.underOdds > 1 && (!bestUnder || b.underOdds > bestUnder.odds)) {
      bestUnder = { bookmaker: b.bookmaker, odds: b.underOdds };
    }
  }

  const edgeOver = bestOver ? priceEdge(bestOver.odds, pFinal) : -Infinity;
  const edgeUnder = bestUnder ? priceEdge(bestUnder.odds, 1 - pFinal) : -Infinity;
  const takeOver = edgeOver >= edgeUnder;
  const best = takeOver ? bestOver : bestUnder;
  const edge = Math.max(edgeOver, edgeUnder);

  return {
    metric,
    side,
    line,
    lambda,
    dispersion,
    pModel,
    pMarket,
    marketBooks: ref?.books ?? [],
    marketTwoSided: ref?.twoSided ?? false,
    pFinal,
    blendW,
    fairOverOdds: fairOdds(pFinal),
    fairUnderOdds: fairOdds(1 - pFinal),
    pPush: lp.pPush,
    bestBook: best?.bookmaker ?? null,
    bestSide: best ? (takeOver ? "over" : "under") : null,
    bestOdds: best?.odds ?? null,
    edge: Number.isFinite(edge) ? edge : 0,
  };
}
