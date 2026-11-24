import { describe, it, expect } from "vitest";
import {
  buchholz,
  calibrate,
  devigLogit,
  fitCalibration,
  isBo3,
  pairGroup,
  expectedHits,
  greedyPicks,
  optimizePicks,
  pHitAtLeast,
  scorePicks,
  simulateSwiss,
  tally,
  type Outcome,
  type SwissTeam,
} from "../lib/cs2/pickem";

describe("isBo3", () => {
  it("är bo3 när avancering eller elimination står på spel", () => {
    expect(isBo3(2, 0)).toBe(true);
    expect(isBo3(0, 2)).toBe(true);
    expect(isBo3(2, 1)).toBe(true);
    expect(isBo3(1, 2)).toBe(true);
    expect(isBo3(2, 2)).toBe(true);
  });

  it("är bo1 i övriga ronder", () => {
    expect(isBo3(0, 0)).toBe(false);
    expect(isBo3(1, 0)).toBe(false);
    expect(isBo3(0, 1)).toBe(false);
    expect(isBo3(1, 1)).toBe(false);
  });
});

describe("buchholz", () => {
  it("summerar motståndarnas facit", () => {
    const rec = new Map([
      [1, { w: 2, l: 0 }],
      [2, { w: 0, l: 2 }],
      [3, { w: 1, l: 1 }],
    ]);
    expect(buchholz(rec, [1, 2, 3])).toBe(0);
    expect(buchholz(rec, [1, 1])).toBe(4);
    expect(buchholz(rec, [])).toBe(0);
  });
});

describe("pairGroup", () => {
  it("parar högsta mot lägsta efter buchholz, därefter seed", () => {
    const g = [
      { id: 1, buchholz: 2, seed: 1 },
      { id: 2, buchholz: 1, seed: 5 },
      { id: 3, buchholz: 0, seed: 3 },
      { id: 4, buchholz: -1, seed: 9 },
    ];
    expect(pairGroup(g, new Set())).toEqual([
      [1, 4],
      [2, 3],
    ]);
  });

  it("skiljer lika buchholz på seed, lägst seed först", () => {
    const g = [
      { id: 7, buchholz: 0, seed: 12 },
      { id: 8, buchholz: 0, seed: 2 },
    ];
    expect(pairGroup(g, new Set())).toEqual([[8, 7]]);
  });

  it("byter par för att undvika omatch", () => {
    const g = [
      { id: 1, buchholz: 3, seed: 1 },
      { id: 2, buchholz: 2, seed: 2 },
      { id: 3, buchholz: 1, seed: 3 },
      { id: 4, buchholz: 0, seed: 4 },
    ];
    // 1 och 4 har redan mötts: 1 ska i stället möta 3, och 2 möta 4.
    expect(pairGroup(g, new Set(["1|4"]))).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it("parar ändå när varje tänkbart par redan mötts", () => {
    const g = [
      { id: 1, buchholz: 1, seed: 1 },
      { id: 2, buchholz: 0, seed: 2 },
    ];
    const pairs = pairGroup(g, new Set(["1|2"]));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].slice().sort()).toEqual([1, 2]);
  });
});

/** Deterministisk rng så simuleringstesterna är reproducerbara. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS: SwissTeam[] = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, seed: i + 1 }));
const R1: Array<[number, number]> = [
  [1, 9],
  [2, 10],
  [3, 11],
  [4, 12],
  [5, 13],
  [6, 14],
  [7, 15],
  [8, 16],
];

describe("simulateSwiss", () => {
  it("ger alltid exakt 8 avancerade och 8 utslagna", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const out = simulateSwiss(SEEDS, R1, () => 0.5, rng);
      expect(out.size).toBe(16);
      expect([...out.values()].filter((o) => o === "3-0" || o === "adv").length).toBe(8);
      expect([...out.values()].filter((o) => o === "0-3" || o === "out").length).toBe(8);
    }
  });

  it("ger minst ett 3-0 och minst ett 0-3", () => {
    const out = simulateSwiss(SEEDS, R1, () => 0.5, mulberry32(7));
    expect([...out.values()].filter((o) => o === "3-0").length).toBeGreaterThanOrEqual(1);
    expect([...out.values()].filter((o) => o === "0-3").length).toBeGreaterThanOrEqual(1);
  });

  it("låter det starkare laget gå 3-0 när det alltid vinner", () => {
    const out = simulateSwiss(SEEDS, R1, (a) => (a === 1 ? 1 : 0.5), mulberry32(3));
    expect(out.get(1)).toBe("3-0");
  });

  it("spelar mellan tre och fem matcher per lag, aldrig mer", () => {
    const counts = new Map<number, number>();
    simulateSwiss(
      SEEDS,
      R1,
      (a, b) => {
        counts.set(a, (counts.get(a) ?? 0) + 1);
        counts.set(b, (counts.get(b) ?? 0) + 1);
        return 0.5;
      },
      mulberry32(11)
    );
    for (const n of counts.values()) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it("väljer format efter facit: rond 1 är alltid bo1, senare ronder har bo3", () => {
    const formats: string[] = [];
    simulateSwiss(
      SEEDS,
      R1,
      (_a, _b, f) => {
        formats.push(f);
        return 0.5;
      },
      mulberry32(5)
    );
    expect(formats.slice(0, 8).every((f) => f === "bo1")).toBe(true);
    expect(formats.some((f) => f === "bo3")).toBe(true);
  });
});

describe("scorePicks", () => {
  const out = new Map<number, Outcome>([
    [1, "3-0"],
    [2, "adv"],
    [3, "0-3"],
    [4, "out"],
    [5, "adv"],
  ]);

  it("räknar rätt val i varje slot", () => {
    expect(scorePicks({ threeZero: [1], advance: [2, 5], zeroThree: [3] }, out)).toBe(4);
  });

  it("räknar ett 3-0-val som fel när laget går 3-1", () => {
    expect(scorePicks({ threeZero: [2], advance: [], zeroThree: [] }, out)).toBe(0);
  });

  it("räknar inte ett 3-0-lag som ett avancerings-val", () => {
    expect(scorePicks({ threeZero: [], advance: [1], zeroThree: [] }, out)).toBe(0);
  });

  it("räknar inte ett lag utslaget på 2-3 som 0-3", () => {
    expect(scorePicks({ threeZero: [], advance: [], zeroThree: [4] }, out)).toBe(0);
  });
});

const TEAM_IDS = Array.from({ length: 16 }, (_, i) => i + 1);

/** Ett facit byggt ur en rangordning: 2 på 3-0, 6 på adv, 2 på 0-3, 6 out. */
function outcomesFromOrder(order: number[]): Map<number, Outcome> {
  const m = new Map<number, Outcome>();
  order.forEach((id, i) => {
    m.set(id, i < 2 ? "3-0" : i < 8 ? "adv" : i < 14 ? "out" : "0-3");
  });
  return m;
}

/** Favoriterna håller varje gång: lag 1–2 går 3-0, 3–8 avancerar, 15–16 går 0-3. */
function favouriteSims(): Array<Map<number, Outcome>> {
  return Array.from({ length: 200 }, () => outcomesFromOrder(TEAM_IDS));
}

/** Favoriterna håller i 70 % av fallen, annars slumpas rangordningen. */
function mixedSims(): Array<Map<number, Outcome>> {
  const rng = mulberry32(99);
  return Array.from({ length: 2000 }, () => {
    if (rng() < 0.7) return outcomesFromOrder(TEAM_IDS);
    const order = [...TEAM_IDS];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return outcomesFromOrder(order);
  });
}

describe("tally och pHitAtLeast", () => {
  const sims = [
    new Map<number, Outcome>([
      [1, "3-0"],
      [2, "adv"],
      [3, "0-3"],
    ]),
    new Map<number, Outcome>([
      [1, "adv"],
      [2, "3-0"],
      [3, "0-3"],
    ]),
  ];

  it("ger marginalsannolikheter per lag", () => {
    const t = tally(sims, [1, 2, 3]);
    expect(t.p30.get(1)).toBeCloseTo(0.5);
    expect(t.pAdv.get(1)).toBeCloseTo(0.5);
    expect(t.p03.get(3)).toBeCloseTo(1);
  });

  it("räknar P(minst n rätt) över simuleringarna", () => {
    const t = tally(sims, [1, 2, 3]);
    expect(pHitAtLeast(t, { threeZero: [1], advance: [], zeroThree: [3] }, 2)).toBeCloseTo(0.5);
    expect(pHitAtLeast(t, { threeZero: [1], advance: [], zeroThree: [3] }, 1)).toBeCloseTo(1);
  });

  it("ger förväntat antal rätt som summan av marginalerna", () => {
    const t = tally(sims, [1, 2, 3]);
    expect(expectedHits(t, { threeZero: [1], advance: [], zeroThree: [3] })).toBeCloseTo(1.5);
  });
});

describe("optimizePicks", () => {
  it("ger tio olika lag i rätt antal per slot", () => {
    const table = tally(favouriteSims(), TEAM_IDS);
    const best = optimizePicks(table, 5, mulberry32(1));
    const all = [...best.picks.threeZero, ...best.picks.advance, ...best.picks.zeroThree];
    expect(new Set(all).size).toBe(10);
    expect(best.picks.threeZero).toHaveLength(2);
    expect(best.picks.advance).toHaveLength(6);
    expect(best.picks.zeroThree).toHaveLength(2);
    expect(best.pHit).toBeGreaterThan(0.9);
  });

  it("slår det giriga EV-valet eller tangerar det", () => {
    const table = tally(mixedSims(), TEAM_IDS);
    const best = optimizePicks(table, 5, mulberry32(2));
    expect(best.pHit).toBeGreaterThanOrEqual(pHitAtLeast(table, greedyPicks(table), 5) - 1e-9);
  });
});

describe("devigLogit", () => {
  it("ger sannolikheter som summerar till ett", () => {
    const d = devigLogit(1.47, 2.6)!;
    expect(d.pA + d.pB).toBeCloseTo(1, 10);
    expect(d.pA).toBeGreaterThan(1 / 1.47 - 0.05);
    expect(d.pA).toBeLessThan(1 / 1.47 + 0.05);
  });

  it("lämnar ett rättvist par orört", () => {
    expect(devigLogit(2, 2)!.pA).toBeCloseTo(0.5, 10);
  });

  it("ger favoriten mer än multiplikativ de-vig, som smickrar höga odds", () => {
    const d = devigLogit(1.1, 9)!;
    const mult = 1 / 1.1 / (1 / 1.1 + 1 / 9);
    // Multiplikativ de-vig drar av marginalen proportionellt och lämnar
    // därmed för mycket hos skrällen: 0,109 mot additivas 0,101.
    expect(d.pA).toBeGreaterThan(mult);
    expect(d.pB).toBeLessThan(1 - mult);
  });

  it("ger null när ett odds saknas eller är orimligt", () => {
    expect(devigLogit(NaN, 2)).toBeNull();
    expect(devigLogit(1, 2)).toBeNull();
  });
});

describe("fitCalibration", () => {
  it("ger k=1 när modellen redan möter marknaden", () => {
    const pts = [0.3, 0.45, 0.6, 0.75].map((p) => ({ pModel: p, pMarket: p }));
    expect(fitCalibration(pts).k).toBeCloseTo(1, 2);
  });

  it("ger k under 1 när modellen är för tvärsäker", () => {
    const pts = [0.1, 0.2, 0.8, 0.9].map((p) => ({ pModel: p, pMarket: calibrate(p, 0.6) }));
    const f = fitCalibration(pts);
    expect(f.k).toBeCloseTo(0.6, 1);
    expect(f.warning).toBeNull();
  });

  it("faller tillbaka på k=1 med varning vid för få punkter", () => {
    const f = fitCalibration([{ pModel: 0.6, pMarket: 0.5 }]);
    expect(f.k).toBe(1);
    expect(f.n).toBe(1);
    expect(f.warning).not.toBeNull();
  });
});
