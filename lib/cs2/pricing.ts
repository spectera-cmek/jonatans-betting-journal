// Från modellens sannolikhet till fair odds och edge mot bokens pris.
//
// Samma principer som skottmodellen: fair odds sätts på P(över | ingen push),
// bokens egna två sidor avviggas till en marknadsreferens, och modellen vägs
// mot den. Edge är EV per satsad enhet, med insatsen tillbaka vid push.

import { blendProb, marketProbOver } from "../shotModel";

/** Modellvikt mot bokens avviggade pris. 1 = ren modell. */
export const DEFAULT_CS2_BLEND_W = 0.5;
export const CS2_MODEL_VERSION = "cs2-v5";

export interface Price {
  /** P(över / sida 1) ur modellen, betingat på ingen push. */
  pModel: number;
  pMarket: number | null;
  pFinal: number;
  pPush: number;
  fairOver: number;
  fairUnder: number;
  edgeOver: number | null;
  edgeUnder: number | null;
  bestSide: "over" | "under" | null;
  bestOdds: number | null;
  /** Bästa sidans EV per satsad enhet. 0.05 = +5 %. */
  edge: number | null;
  /**
   * true när modellen och boken är så oense att marknaden troligen är
   * feltolkad. Då sätts edge, bestSide och bestOdds till null: raden visas,
   * men den är inget spel. Se PLAUSIBLE_GAP.
   */
  implausible: boolean;
}

const clamp = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));

/**
 * Hur långt ifrån bokens pris modellen får ligga, i log-odds, innan raden
 * räknas som feltolkad i stället för som en edge.
 *
 * Boken har hela marknaden bakom sig. Ligger modellen tolv gånger ifrån den i
 * odds är det nästan alltid vi som läst marknaden fel — fel karta, fel
 * marknad, fel spelare — inte boken som missat. Mätt på databasens 4 979
 * sparade prissättningar: de 3 785 rader där marknaden lästs rätt ligger alla
 * under 1,8 (99,9-percentilen 1,4), medan alla 1 194 rader från den
 * feltolkade kartlinjen ligger över 3,5 i median 4,5. 2,5 skiljer dem åt utan
 * att röra en enda rimlig rad.
 */
export const PLAUSIBLE_GAP = 2.5;

/** Är modellen och boken så oense att marknaden troligen är feltolkad? */
export function isImplausible(pModel: number, pMarket: number | null | undefined): boolean {
  return pMarket != null && Math.abs(logit(pModel) - logit(pMarket)) > PLAUSIBLE_GAP;
}

export function priceTwoWay(
  pModelNoPush: number,
  pPush: number,
  overOdds: number | null | undefined,
  underOdds: number | null | undefined,
  blendW = DEFAULT_CS2_BLEND_W
): Price {
  const hasOver = overOdds != null && overOdds > 1;
  const hasUnder = underOdds != null && underOdds > 1;
  const pMarket = hasOver ? marketProbOver(overOdds, hasUnder ? underOdds : null) : hasUnder ? (() => {
    const pu = marketProbOver(underOdds, null);
    return pu == null ? null : 1 - pu;
  })() : null;
  const pFinal = clamp(blendProb(clamp(pModelNoPush), pMarket, blendW));
  const live = 1 - pPush;
  const edgeOver = hasOver ? overOdds! * pFinal * live + pPush - 1 : null;
  const edgeUnder = hasUnder ? underOdds! * (1 - pFinal) * live + pPush - 1 : null;
  let bestSide: Price["bestSide"] = null;
  if (edgeOver != null || edgeUnder != null) bestSide = (edgeOver ?? -Infinity) >= (edgeUnder ?? -Infinity) ? "over" : "under";
  const implausible = isImplausible(pModelNoPush, pMarket);
  const odds = bestSide === "over" ? overOdds ?? null : bestSide === "under" ? underOdds ?? null : null;
  return {
    pModel: clamp(pModelNoPush),
    pMarket,
    pFinal,
    pPush,
    fairOver: 1 / pFinal,
    fairUnder: 1 / (1 - pFinal),
    edgeOver,
    edgeUnder,
    bestSide: implausible ? null : bestSide,
    bestOdds: implausible ? null : odds,
    edge: implausible ? null : bestSide === "over" ? edgeOver : bestSide === "under" ? edgeUnder : null,
    implausible,
  };
}
