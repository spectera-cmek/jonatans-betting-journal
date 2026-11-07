// NBA-modellens parametrar på ett ställe. Backtesten (npm run nba:backtest)
// är det som ska flytta dem — ändra versionen när modellens matte ändras.

export const NBA_MODEL_VERSION = "nba-v4";

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
  /**
   * rubberBand växer med förväntad marginal: + så här mycket per poäng, upp till
   * RUBBER_BAND_MAX. I ojämna matcher är spridningen mindre (vilade startare,
   * garbage time) — backtest 2024–2026: SD(utfall − modell) 14,4 vid jämna matcher,
   * 13,4 vid 9–12 poäng och 12,9 vid 12–16 — men simuleringen gav ~14,7 överallt,
   * så underdogs i ojämna matcher fick för hög chans. 0 = samma överallt.
   */
  rubberBandPerPt: number;
  /** Spridning i antal possessions per match. */
  possSd: number;
  /** Straffar per straffsituation (0,44-regeln ⇒ ≈ 2,27). */
  ftsPerTrip: number;
  /** Antal simulerade matcher. */
  sims: number;
  /** Lagrating: halveringstid i dagar för matcherna bakom ratingen. */
  ratingHalfLifeDays: number;
  /** Lagrating: ridge mot snittlaget (eller förra säsongen), i matcher. */
  ratingRidgeGames: number;
  /**
   * Förra säsongens slutrating som utgångspunkt: värd så här många matcher
   * i början av säsongen. Laget drar sig bort från den när det spelat fler.
   */
  priorGames: number;
  /** Andel av förra säsongens rating som behålls över sommaren (resten mot snittet). */
  priorKeep: number;
  /** Hemmafördel i poäng per 100 possessions (marginal). */
  homeRtg: number;
  /** Back-to-back i poäng per 100 possessions för laget som spelar igen. */
  b2bRtg: number;
  /**
   * Hur mycket lagratingen bestämmer nivån: 1 = lagrating (+ spelarjustering),
   * 0 = bara spelarmodellen (nba-v1).
   */
  ratingMix: number;
  /** Hur mycket av spelarmodellens skillnad mellan kvällens och normal uppställning som läggs på lagratingen. */
  playerAdjK: number;
  /**
   * Vikt för RAPM-justeringen (spelarnas påverkan på anfall OCH försvar ur
   * play-by-play) av kvällens uppställning mot den normala. 0 = av.
   */
  rapmK: number;
  /** Slutspel: poäng per 100 possessions för båda lagen (tätare försvar). */
  playoffRtg: number;
  /** Slutspel: possessions per 48 (lägre tempo). */
  playoffPace: number;
  /**
   * Slutspel: lagens skillnad sträcks ut så här mycket till (utöver marginStretch).
   * Rotationerna kortas och stjärnorna spelar mer, så skillnaderna blir större än
   * grundseriens siffror säger. 1 = av.
   */
  playoffStretch: number;
  /** Slutspel: extra hemmafördel i poäng per 100 possessions (marginal), utöver homeRtg. */
  playoffHomeRtg: number;
  /**
   * Vikt för marknadens lagrating (ur tidigare matchers stängningslinjer, se
   * marketRatings.ts) mot modellens egen grundnivå, före kvällens
   * uppställningsjusteringar. 0 = av.
   */
  marketMix: number;
  /**
   * Sträcker ut skillnaden mellan lagens ORtg runt deras snitt (totalen rörs
   * inte), före RAPM och slutspelsjusteringen. Lagrating och spelarmodell är
   * båda krympta skattningar, och ett vägt snitt av dem med vikter som
   * summerar till 1 trycker ihop skillnaderna ytterligare. 1 = av.
   * Hemmaplan och back-to-back sträcks inte.
   */
  marginStretch: number;
  /**
   * Spelare utan NBA-data är ersättningsnivå, inte ligasnitt: kvällens
   * uppställning tappar så här många poäng per 100 possessions i netto
   * (halva i anfall, halva i försvar) per hel andel okända minuter. En spelare
   * räknas som okänd till andelen K / (possessions i RAPM + K), K = lowDataPoss.
   * Kräver RAPM (possessions). 0 = av.
   */
  lowDataRtg: number;
  lowDataPoss: number;
  /**
   * Avdrag i netto per 100 possessions per hel andel av lagets normala minuter
   * (baseLineup) som saknas i kväll — utöver RAPM, som krymper alla spelare mot
   * snittet och därför undervärderar bortfall. 0 = av.
   */
  missRtg: number;
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
  // 0,0028: underdogs kalibrerade (modellens 0–10 % → utfall 6,8 %, förut 15,5 % → 10,2 %
  // i 10–20 %), log loss ml 0,5838 → 0,5830.
  rubberBandPerPt: 0.0028,
  possSd: 4,
  ftsPerTrip: 1 / 0.44,
  sims: 20000,
  // nba-v3, kalibrerad på tre säsonger (backtest nov 2024–jun 2026, 2 471
  // matcher, varav 1 066 med DraftKings-linje): 60 % lagrating med 40 dagars
  // halveringstid, RAPM i stället för spelarmodellens uppställningsjustering,
  // slutspels- och back-to-back-justering. På samma matcher som marknaden:
  // marginal-MAE 11,60 (v2 11,62, marknaden 11,20), total 14,96 (v2 15,29,
  // marknaden 14,58), log loss spread 0,7145 / total 0,7075.
  ratingHalfLifeDays: 40,
  ratingRidgeGames: 3,
  // Av som standard: på säsongens första 88 matcher (okt 2026) gav förra
  // säsongens rating SÄMRE spread (log loss 0,7392 mot 0,7261) — trupperna
  // ändras för mycket över sommaren. Prova igen med --param priorGames=10.
  priorGames: 0,
  priorKeep: 0.6,
  homeRtg: 1.6,
  b2bRtg: -3,
  ratingMix: 0.6,
  // Spelarmodellens justering (bara anfall) ersätts av RAPM (anfall + försvar):
  // med båda på samtidigt blev det sämre. 0,8 → 0,3 i nba-v4: marknaden rörde sig
  // mindre än modellen på RAPM-skillnaden (t ≈ −11), och missRtg tar bortfallen.
  playerAdjK: 0,
  rapmK: 0.3,
  playoffRtg: -3,
  playoffPace: -2,
  // Slutspel 2024–2026 (247 matcher): utfallet = 1,18 × modellens marginal och Pinnacles
  // spread = 1,26 × modellens (81 matcher), mot 0,96 och 0,92 i grundserien.
  playoffStretch: 1.25,
  // Slutspel: Pinnacles spread ligger 1,5 poäng närmare hemmalaget än modellen (81 matcher,
  // t ≈ 5), utfallen 2,1 ± 1,0 (247 matcher, 2024–2026).
  playoffHomeRtg: 1.5,
  // 0,4: modellens grundnivå avvek från Pinnacles stängning med ~3,3 p utan att det sa
  // något om utfallet (β 0,03), och de största edgarna var därför ungefär dubbelt för
  // stora (β 0,41–0,58). Med 0,4: stora avvikelser (≥ 4 p) β 1,12 ± 0,35, log loss
  // ml 0,5838 → 0,5824, spread 0,7034 → 0,7009, marginal-MAE 11,31 → 11,29 (samma matcher).
  marketMix: 0.4,
  // nba-v4, backtest jan 2025–nov 2026 (2 272 matcher, 1 168 med Pinnacle-/DraftKings-
  // stängning). I nba-v3 var utfallet = 1,22 × modellens marginal (lagrating ensam 1,08,
  // spelarmodellen ensam 1,26) och underdogs fick för hög chans (marknadens 5–10 % blev
  // 18 % i modellen, utfall 0 %). Modellens fel hängde också ihop med minuter till
  // spelare utan data (t ≈ −5; marknadens fel gjorde det inte) — tankande lag i mars–april
  // med G-League-spelare såg ut som snittlag — och med andelen normala minuter som
  // saknades (t ≈ −3,5). Med de fyra, playoffStretch och rubberBandPerPt: lutning 1,00,
  // marginal-MAE 11,33 → 11,11, log loss ml 0,6008 → 0,5841, spread 0,7118 → 0,7043.
  marginStretch: 1.06,
  lowDataRtg: 16,
  lowDataPoss: 3000,
  // 8: bortfallstermen var den enda delen av modellens avvikelse från Pinnacles stängning
  // som förutsade utfallet (β 2,0 ± 0,9 vid 4); 4 → 8 gav log loss ml 0,5845 → 0,5838.
  missRtg: 8,
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

/** Tak för rubberBand när den växer med förväntad marginal. */
export const RUBBER_BAND_MAX = 0.07;

/** Minuter per lag och match i ordinarie tid. */
export const TEAM_MINUTES = 240;
/** Tak för en spelares förväntade minuter. */
export const MAX_PLAYER_MINUTES = 42;
