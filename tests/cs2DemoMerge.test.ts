import { describe, it, expect } from "vitest";
import { normalizeRaw } from "../lib/cs2/demo/parseDemo";
import { analyzeDemo } from "../lib/cs2/demo/analyze";
import { mergeDemoParts } from "../lib/cs2/demo/merge";
import { partNumber } from "../lib/cs2/demo/process";
import type { NormalizedDemo } from "../lib/cs2/demo/types";
import { buildRaw } from "./helpers/cs2Synthetic";

/**
 * Delar en hel demo i två filer som efter en serverkrasch: del 1 har rundorna
 * 1..k, del 2 resten numrerade från 1 och med egen tidslinje från tick 0.
 */
function split(d: NormalizedDemo, k: number): [NormalizedDemo, NormalizedDemo] {
  const firstTick2 = d.rounds[k].startTick;
  const part = (from: number, to: number, renum: (n: number) => number, shift: number): NormalizedDemo => {
    const inPart = (n: number) => n >= from && n <= to;
    return {
      ...d,
      rounds: d.rounds
        .filter((r) => inPart(r.n))
        .map((r) => ({ ...r, n: renum(r.n), startTick: r.startTick - shift, freezeEndTick: r.freezeEndTick - shift, endTick: r.endTick - shift })),
      sides: Object.fromEntries(Object.entries(d.sides).filter(([n]) => inPart(Number(n))).map(([n, s]) => [renum(Number(n)), s])),
      kills: d.kills.filter((x) => inPart(x.round)).map((x) => ({ ...x, round: renum(x.round), tick: x.tick - shift })),
      grenades: d.grenades
        .filter((x) => inPart(x.round))
        .map((x) => ({ ...x, round: renum(x.round), throwTick: x.throwTick - shift, landTick: x.landTick - shift })),
      samples: d.samples.filter((x) => inPart(x.round)).map((x) => ({ ...x, round: renum(x.round) })),
      bombs: d.bombs.filter((x) => inPart(x.round)).map((x) => ({ ...x, round: renum(x.round), tick: x.tick - shift })),
      timeouts: d.timeouts.filter((x) => inPart(x.round)).map((x) => ({ ...x, round: renum(x.round) })),
      utilityDamage: d.utilityDamage.filter((x) => inPart(x.round)).map((x) => ({ ...x, round: renum(x.round) })),
    };
  };
  const last = d.rounds[d.rounds.length - 1].n;
  return [part(1, k, (n) => n, 0), part(k + 1, last, (n) => n - k, firstTick2)];
}

describe("demo i flera delar", () => {
  const whole = normalizeRaw(buildRaw());
  const full = analyzeDemo(whole);

  it("två delar ger samma kills och rundor som hela demon", () => {
    const [p1, p2] = split(whole, 7);
    // Var del för sig ger bara en del av killsen — det var felet på karta 240637.
    expect(analyzeDemo(p2).killTotals).not.toEqual(full.killTotals);

    const merged = mergeDemoParts([p1, p2], whole.rounds.length);
    expect(merged.rounds.map((r) => r.n)).toEqual(whole.rounds.map((r) => r.n));
    const a = analyzeDemo(merged);
    expect(a.killTotals).toEqual(full.killTotals);
    expect(a.roundWinners).toEqual(full.roundWinners);
  });

  it("tar bort rundor som spelades om efter återställningen", () => {
    // Återställt till runda 6: del 1 har 1..7, del 2 börjar om på runda 7.
    const [p1] = split(whole, 7);
    const [, p2] = split(whole, 6);
    const merged = mergeDemoParts([p1, p2], whole.rounds.length);
    expect(merged.rounds).toHaveLength(whole.rounds.length);
    expect(analyzeDemo(merged).killTotals).toEqual(full.killTotals);
  });

  it("en del, eller tomma delar, lämnas orörda", () => {
    expect(mergeDemoParts([whole], 13)).toBe(whole);
    const empty = { ...whole, rounds: [] };
    expect(mergeDemoParts([empty, whole], 13)).toBe(whole);
  });

  it("läser delnumret ur filnamnet", () => {
    expect(partNumber("vitality-vs-mouz-m1-inferno.dem")).toBe(0);
    expect(partNumber("vitality-vs-mouz-m1-inferno-p2.dem")).toBe(2);
    expect(partNumber("vitality-vs-mouz-m1-inferno_2.dem")).toBe(2);
    expect(partNumber("C:\\demos\\x-inferno-p3.dem")).toBe(3);
    const files = ["x-inferno-p2.dem", "x-inferno.dem"];
    expect([...files].sort((a, b) => partNumber(a) - partNumber(b))).toEqual(["x-inferno.dem", "x-inferno-p2.dem"]);
  });
});
