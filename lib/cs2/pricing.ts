// Från modellens sannolikhet till fair odds och edge mot bokens pris.
//
// Samma principer som skottmodellen: fair odds sätts på P(över | ingen push),
// bokens egna två sidor avviggas till en marknadsreferens, och modellen vägs
// mot den. Edge är EV per satsad enhet, med insatsen tillbaka vid push.

import { blendProb, marketProbOver } from "../shotModel";

/** Modellvikt mot bokens avviggade pris. 1 = ren modell. */
export const DEFAULT_CS2_BLEND_W = 0.5;
export const CS2_MODEL_VERSION = "cs2-v4";

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
}

const clamp = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));

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
  return {
    pModel: clamp(pModelNoPush),
    pMarket,
    pFinal,
    pPush,
    fairOver: 1 / pFinal,
    fairUnder: 1 / (1 - pFinal),
    edgeOver,
    edgeUnder,
    bestSide,
    bestOdds: bestSide === "over" ? overOdds ?? null : bestSide === "under" ? underOdds ?? null : null,
    edge: bestSide === "over" ? edgeOver : bestSide === "under" ? edgeUnder : null,
  };
}
