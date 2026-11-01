// NBA-modellens parametrar på ett ställe. Backtesten (npm run nba:backtest)
// är det som ska flytta dem — ändra versionen när modellens matte ändras.

export const NBA_MODEL_VERSION = "nba-v1";

export interface NbaModelParams {
  /** Spelartakter: halveringstid i spelarens egna matcher. */
  playerHalfLifeGames: number;
  /** Prior i minuter mot positionens snitt (takter per minut). */
  priorMinutes: number;
  /** Prior i försök mot positionens träffprocent. */
  pct2PriorAtt: number;
  pct3PriorAtt: number;
  ftPriorAtt: number;
  /** Lagens tempo och försvar: halveringstid i lagets matcher. */
  teamHalfLifeGames: number;
  /** Krympning av försvar/tempo mot ligasnittet, i matcher. */
  teamShrinkGames: number;
  /** Logit-tillägg på hemmalagets träffprocent (och avdrag för bortalaget). */
  homeLogit: number;
  /** Logit-avdrag på träffprocenten för ett lag som spelar andra dagen i rad. */
  b2bLogit: number;
  /**
   * Usage/effektivitet: när spelarna på planen tillsammans skapar färre avslut
   * än ett normalt lag (en stjärna saknas) måste rollspelarna ta fler och
   * svårare skott. Logit-tillägg = usageK · ln(kvot), kvoten begränsad till
   * 0,8–1,2. Utan den blir ett lag ibland BÄTTRE när stjärnan är borta.
   */
  usageK: number;
  /** Logit-tillägg på båda lagens träffprocent — kalibrerar nivån på totalen. */
  effLogit: number;
  /** Lagets dagsform: N(0, σ) på lagets träff-logit per simulerad match. */
  nightSigma: number;
  /** Matchens gemensamma dagsform för båda lagen (påverkar totalen, inte marginalen). */
  sharedSigma: number;
  /**
   * Logit per 10 poängs avvikelse från förväntad ledning som laget i ledning
   * tappar (och laget efter vinner). Utan den blir marginalens spridning
   * ~16,5 poäng. 0,035 gör att simuleringens spridning (14,7) matchar
   * modellens faktiska fel mot utfallet (14,9) — backtest dec 2025–jun 2026.
   */
  rubberBand: number;
  /** Spridning i antal possessions per match. */
  possSd: number;
  /** Straffar per straffsituation (0,44-regeln ⇒ ≈ 2,27). */
  ftsPerTrip: number;
  /** Antal simulerade matcher. */
  sims: number;
}

export const DEFAULT_NBA_PARAMS: NbaModelParams = {
  playerHalfLifeGames: 25,
  priorMinutes: 250,
  pct2PriorAtt: 150,
  pct3PriorAtt: 250,
  ftPriorAtt: 60,
  teamHalfLifeGames: 20,
  teamShrinkGames: 12,
  homeLogit: 0.018,
  b2bLogit: -0.015,
  usageK: 1,
  effLogit: 0,
  nightSigma: 0.03,
  sharedSigma: 0.04,
  rubberBand: 0.035,
  possSd: 4,
  ftsPerTrip: 1 / 0.44,
  sims: 20000,
};

/**
 * Modellvikt mot marknaden per marknad. 1 = ren modell. Sätts av backtesten.
 *
 * Backtest nba-v1, 1 026 matcher dec 2025–jun 2026 mot DraftKings stängning
 * (npm run nba:backtest): marknaden ensam gav lägst log loss i alla tre
 * marknaderna, och 10 % modell kostade nästan inget (+0,0003–0,0010).
 * Modellen slår alltså inte en stängningslinje än — vikten är låg med flit,
 * så att den bara knuffar priset. Höj den först när backtesten visar det.
 */
export const DEFAULT_NBA_BLEND_W: Record<"ml" | "spread" | "total", number> = {
  ml: 0.1,
  spread: 0.1,
  total: 0.1,
};

/** Edge (EV per satsad enhet) som markeras som spelvärd på /nba. */
export const NBA_EDGE_THRESHOLD = 0.05;

/**
 * Högsta odds som markeras. På långa odds räcker en procentenhets skillnad
 * för 5 % edge, och där är modellen som minst pålitlig: i backtesten gick
 * moneyline-spel över 4,0 kraftigt back.
 */
export const NBA_MAX_FLAG_ODDS = 4;

/** Spelvärd: edge över tröskeln på ett pris som inte är en longshot. */
export function isFlagged(edge: number | null | undefined, odds: number | null | undefined): boolean {
  return edge != null && odds != null && edge >= NBA_EDGE_THRESHOLD && odds <= NBA_MAX_FLAG_ODDS;
}

/** Minuter per lag och match i ordinarie tid. */
export const TEAM_MINUTES = 240;
/** Tak för en spelares förväntade minuter. */
export const MAX_PLAYER_MINUTES = 42;
