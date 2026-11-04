import { describe, it, expect } from "vitest";
import { freshLines, pinAnchors, evAgainstClose, type PropLineRow } from "../lib/nba/propsPipeline";
import { priceAnchoredProp, mainLineOf } from "../lib/nba/propPricing";
import { usageMultipliers, scaleRates } from "../lib/nba/propRates";
import { anchoredOutcome } from "../lib/nba/pricing";
import type { PlayerRates } from "../lib/nba/ratings";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const min = (m: number) => new Date(T0 + m * 60e3);
let nextId = 1;
const row = (o: Partial<PropLineRow>): PropLineRow => ({
  id: nextId++,
  playerId: 1,
  stat: "pts",
  book: "kambi",
  source: "kambi",
  line: 20.5,
  over: 1.9,
  under: 1.9,
  capturedAt: min(0),
  seenAt: min(0),
  maxStake: null,
  ...o,
});

describe("färska linjer", () => {
  it("bara bokens senaste fångst räknas; indragna linjer faller bort", () => {
    const rows = [
      row({ playerId: 1, capturedAt: min(-120), seenAt: min(0) }),
      row({ playerId: 2, capturedAt: min(-120), seenAt: min(-60) }), // drogs in för en timme sedan
      row({ playerId: 3, book: "eget", source: "manual", capturedAt: min(-600), seenAt: null }),
    ];
    const ids = freshLines(rows, T0).map((r) => r.playerId).sort();
    expect(ids).toEqual([1, 3]);
  });

  it("för gamla fångster räknas inte, och framtida rader ignoreras", () => {
    const rows = [row({ capturedAt: min(-400), seenAt: min(-300) }), row({ playerId: 2, capturedAt: min(10), seenAt: min(10) })];
    expect(freshLines(rows, T0)).toHaveLength(0);
  });

  it("Pinnacle-ankaret: arcadia före OddsPapi, huvudlinjen = jämnast pris", () => {
    const rows = [
      row({ book: "pinnacle", source: "oddspapi", line: 21.5, over: 1.95, under: 1.85 }),
      row({ book: "pinnacle", source: "arcadia", line: 20.5, over: 1.7, under: 2.15 }),
      row({ book: "pinnacle", source: "arcadia", line: 21.5, over: 1.93, under: 1.89, maxStake: 500 }),
    ];
    const a = pinAnchors(rows).get("1|pts")!;
    expect(a.line).toBe(21.5);
    expect(a.over).toBe(1.93);
    expect(a.maxStake).toBe(500);
    expect(mainLineOf([])).toBeNull();
  });
});

describe("förankrat prop-pris", () => {
  const pin = { line: 20.5, over: 1.9, under: 1.9, maxStake: 500, seenAt: T0 };
  it("w = 0 ger Pinnacles rättvisa pris, w = 1 modellens", () => {
    const a = priceAnchoredProp({ p: 0.6, push: 0, vmr: 1.5 }, { line: 20.5, over: 2.1, under: 1.75 }, pin, 0, { now: T0 });
    expect(a.anchor).toBe("pinnacle");
    expect(a.pFinal).toBeCloseTo(0.5, 6);
    expect(a.edgeOver).toBeCloseTo(0.05, 6);
    const b = priceAnchoredProp({ p: 0.6, push: 0, vmr: 1.5 }, { line: 20.5, over: 2.1, under: 1.75 }, pin, 1, { now: T0 });
    expect(b.pFinal).toBeCloseTo(0.6, 6);
  });

  it("annan linje: Pinnacles pris flyttas, lägre linje ger högre P(över)", () => {
    const a = priceAnchoredProp({ p: 0.5, push: 0, vmr: 1.5 }, { line: 18.5, over: 1.6, under: 2.3 }, pin, 0, { now: T0 });
    expect(a.pAnchor!).toBeGreaterThan(0.6);
  });

  it("gammalt ankare: bokens eget pris (own)", () => {
    const old = { ...pin, seenAt: T0 - 3 * 3600e3 };
    const a = priceAnchoredProp({ p: 0.6, push: 0, vmr: 1.5 }, { line: 20.5, over: 1.9, under: 1.9 }, old, 0.1, { now: T0, ownW: 0.15 });
    expect(a.anchor).toBe("own");
    expect(a.pFinal).toBeCloseTo(0.15 * 0.6 + 0.85 * 0.5, 6);
  });

  it("CLV mot stängningen på samma linje", () => {
    const ev = evAgainstClose({ line: 20.5, over: 1.8, under: 2.0, maxStake: 1000, seenAt: T0 }, 20.5, 1, 2.0, 1.5)!;
    expect(ev.closeFair).toBeGreaterThan(0.5);
    expect(ev.evClose).toBeGreaterThan(0.04);
  });
});

describe("usage-omfördelning", () => {
  const rates = (u: number, ast: number, reb: number): PlayerRates => ({ a2: u * 0.5, a3: u * 0.3, fta: 0, tov: u * 0.2, oreb: reb * 0.2, dreb: reb * 0.8, ast, pct2: 0.5, pct3: 0.35, ftPct: 0.8, sample: 1000 });
  const R = new Map<number, PlayerRates>([
    [1, rates(0.9, 0.15, 0.15)], // stjärnan
    [2, rates(0.5, 0.1, 0.2)],
    [3, rates(0.4, 0.08, 0.3)],
  ]);
  const base = [
    { playerId: 1, minutes: 35 },
    { playerId: 2, minutes: 30 },
    { playerId: 3, minutes: 25 },
  ];
  const tonight = [
    { playerId: 2, minutes: 45 },
    { playerId: 3, minutes: 45 },
  ];
  const pp = { usageBeta: 1, astBeta: 1, rebBeta: 1, usageGamma: 1 };

  it("β = 0 ändrar ingenting", () => {
    const m = usageMultipliers(tonight, base, (id) => R.get(id)!, { ...pp, usageBeta: 0, astBeta: 0, rebBeta: 0 });
    expect(m.get(2)).toEqual({ vol: 1, ast: 1, reb: 1 });
  });

  it("β = 1 bevarar lagets plays och assist när stjärnan saknas", () => {
    const m = usageMultipliers(tonight, base, (id) => R.get(id)!, pp);
    const vol = (id: number) => R.get(id)!.a2 + R.get(id)!.a3 + 0.44 * R.get(id)!.fta + R.get(id)!.tov;
    const team = (lineup: typeof base, f: (id: number) => number, mult: (id: number) => number) => lineup.reduce((a, p) => a + p.minutes * f(p.playerId) * mult(p.playerId), 0);
    expect(team(tonight, vol, (id) => m.get(id)!.vol)).toBeCloseTo(team(base, vol, () => 1), 6);
    expect(team(tonight, (id) => R.get(id)!.ast, (id) => m.get(id)!.ast)).toBeCloseTo(team(base, (id) => R.get(id)!.ast, () => 1), 6);
    expect(m.get(2)!.vol).toBeGreaterThan(1);
    const s = scaleRates(R.get(2)!, m.get(2));
    expect(s.a2).toBeCloseTo(R.get(2)!.a2 * m.get(2)!.vol, 9);
  });
});

describe("matchmodellen krympt mot Pinnacle", () => {
  const ref = { line: -4.5, price1: 1.91, price2: 1.91 };
  it("k = 0 ger Pinnacles rättvisa pris, k = 1 modellens väntevärde", () => {
    const a = anchoredOutcome("spread", ref, -4.5, { mean: 10, pMl: 0.8 }, 0)!;
    expect(a.win1).toBeCloseTo(0.5, 6);
    const b = anchoredOutcome("spread", ref, -4.5, { mean: 10, pMl: 0.8 }, 1)!;
    expect(b.win1).toBeGreaterThan(0.6);
    const ml0 = anchoredOutcome("ml", { line: null, price1: 1.5, price2: 2.7 }, null, { mean: 0, pMl: 0.5 }, 0)!;
    expect(ml0.win1).toBeGreaterThan(0.6);
  });

  it("heltalslinje ger push", () => {
    const a = anchoredOutcome("total", { line: 220.5, price1: 1.91, price2: 1.91 }, 220, { mean: 220.5, pMl: 0.5 }, 0)!;
    expect(a.push).toBeGreaterThan(0.01);
  });
});
