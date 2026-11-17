// Rättvis sannolikhet ur ett tvåvägspris (över/under) — fyra sätt att ta bort
// marginalen. Vilket som stämmer bäst med utfallen mäts i nba:props-line-backtest.
//
//   prop   — proportionellt: p = (1/o) / (1/o + 1/u)
//   power  — p = (1/o)^k med k så att sidorna summerar till 1 (mer marginal på långa odds)
//   shin   — Shins modell (insiderandel z), samma idé som power men härledd
//   logit  — lika stort avdrag i log-odds på båda sidor

import { devigPower } from "./stale";

export type DevigMethod = "prop" | "power" | "shin" | "logit";
export const DEVIG_METHODS: DevigMethod[] = ["prop", "power", "shin", "logit"];

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Rättvis P(sida 1) ur decimalodds o1/o2, eller null. */
export function devigTwoWay(o1: number, o2: number, method: DevigMethod = "prop"): number | null {
  if (!(o1 > 1) || !(o2 > 1) || !Number.isFinite(o1) || !Number.isFinite(o2)) return null;
  const a = 1 / o1;
  const b = 1 / o2;
  if (method === "prop") return a / (a + b);
  if (method === "power") return devigPower(o1, o2);
  if (method === "logit") {
    // σ(logit a − c) + σ(logit b − c) = 1 — c genom bisektion.
    let lo = -5;
    let hi = 5;
    for (let i = 0; i < 80; i++) {
      const c = (lo + hi) / 2;
      if (sigmoid(logit(Math.min(0.999999, a)) - c) + sigmoid(logit(Math.min(0.999999, b)) - c) > 1) lo = c;
      else hi = c;
    }
    return sigmoid(logit(Math.min(0.999999, a)) - (lo + hi) / 2);
  }
  // Shin: p_i = (√(z² + 4(1−z)·π_i²/B) − z) / (2(1−z)), z så att Σp = 1.
  const B = a + b;
  if (B <= 1) return a / B;
  const shinP = (pi: number, z: number) => (Math.sqrt(z * z + (4 * (1 - z) * pi * pi) / B) - z) / (2 * (1 - z));
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 80; i++) {
    const z = (lo + hi) / 2;
    if (shinP(a, z) + shinP(b, z) > 1) lo = z;
    else hi = z;
  }
  const z = (lo + hi) / 2;
  const pa = shinP(a, z);
  return pa / (pa + shinP(b, z));
}
