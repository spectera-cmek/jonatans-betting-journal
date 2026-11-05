import { describe, it, expect } from "vitest";
import { devigTwoWay, DEVIG_METHODS } from "../lib/nba/devig";
import { blendLogit, countPmf, edges, meanForProb, overProbShape, shapeOf, translate } from "../lib/nba/propPricing";
import { clusteredMean, outcome, splitTime, type LineRecord } from "../lib/nba/propsLineBacktest";

describe("devig", () => {
  it("alla metoder ger 50 % på jämna odds och summerar till 1", () => {
    for (const m of DEVIG_METHODS) {
      expect(devigTwoWay(1.9, 1.9, m)).toBeCloseTo(0.5, 6);
      const p = devigTwoWay(1.6, 2.4, m)!;
      const q = devigTwoWay(2.4, 1.6, m)!;
      expect(p + q).toBeCloseTo(1, 6);
    }
  });

  it("power och Shin tar mer marginal från långa odds än proportionellt", () => {
    const prop = devigTwoWay(1.3, 3.6, "prop")!;
    expect(devigTwoWay(1.3, 3.6, "power")!).toBeGreaterThan(prop);
    expect(devigTwoWay(1.3, 3.6, "shin")!).toBeGreaterThan(prop);
  });

  it("ogiltiga odds ger null", () => {
    expect(devigTwoWay(1, 2)).toBeNull();
    expect(devigTwoWay(NaN, 2)).toBeNull();
  });
});

describe("NB-form och översättning", () => {
  it("pmf summerar till ~1 och har rätt medel, Poisson och NB", () => {
    for (const vmr of [1, 1.8]) {
      const pmf = countPmf(12, vmr, 120);
      const sum = pmf.reduce((a, b) => a + b, 0);
      const mean = pmf.reduce((a, p, k) => a + p * k, 0);
      const varr = pmf.reduce((a, p, k) => a + p * (k - mean) ** 2, 0);
      expect(sum).toBeCloseTo(1, 6);
      expect(mean).toBeCloseTo(12, 3);
      expect(varr / mean).toBeCloseTo(vmr, 2);
    }
  });

  it("formen ur sampel", () => {
    const s = shapeOf([2, 4, 6, 8]);
    expect(s.mean).toBe(5);
    expect(s.vmr).toBeCloseTo(20 / 3 / 5, 6);
  });

  it("översättning: identitet på samma linje, monoton i linjen", () => {
    expect(translate(0.55, 20.5, 20.5, 1.6).p).toBeCloseTo(0.55, 9);
    const a = translate(0.55, 20.5, 18.5, 1.6).p;
    const b = translate(0.55, 20.5, 22.5, 1.6).p;
    expect(a).toBeGreaterThan(0.55);
    expect(b).toBeLessThan(0.55);
    // Medlet som ges ger tillbaka referensens sannolikhet.
    const m = meanForProb(0.55, 20.5, 1.6);
    expect(overProbShape({ mean: m, vmr: 1.6 }, 20.5).p).toBeCloseTo(0.55, 4);
  });

  it("heltalslinje ger push", () => {
    const r = translate(0.5, 20.5, 20, 1.5);
    expect(r.push).toBeGreaterThan(0.03);
    expect(r.push).toBeLessThan(0.15);
  });

  it("logit-blandning: w = 0 ger ankaret, w = 1 modellen", () => {
    expect(blendLogit(0.7, 0.5, 0)).toBeCloseTo(0.5, 9);
    expect(blendLogit(0.7, 0.5, 1)).toBeCloseTo(0.7, 9);
    const mid = blendLogit(0.7, 0.5, 0.5);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.7);
  });

  it("edge med push: insatsen tillbaka", () => {
    const e = edges(0.5, 0, 2.1, 1.8);
    expect(e.edgeOver).toBeCloseTo(0.05, 9);
    expect(e.edgeUnder).toBeCloseTo(-0.1, 9);
    const ep = edges(0.5, 0.1, 2, 2);
    expect(ep.edgeOver).toBeCloseTo(0, 9);
  });
});

describe("backtestens hjälpare", () => {
  it("utfall mot linje och push", () => {
    expect(outcome(21, 20.5)).toBe(1);
    expect(outcome(20, 20.5)).toBe(0);
    expect(outcome(20, 20)).toBeNull();
  });

  it("klustrat snitt: hela matcher som kluster", () => {
    const r = clusteredMean([
      { x: 1, g: 1 },
      { x: 1, g: 1 },
      { x: -1, g: 2 },
      { x: -1, g: 2 },
    ]);
    expect(r.mean).toBe(0);
    expect(r.n).toBe(4);
    expect(r.se).toBeGreaterThan(0);
  });

  it("tidsdelning efter matchdagar", () => {
    const day = 864e5;
    const recs = [0, 1, 2, 3, 4].map((d) => ({ t: d * day }) as LineRecord);
    expect(splitTime(recs, 0.6)).toBe(3 * day);
  });
});
