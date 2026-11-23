import { describe, it, expect } from "vitest";
import { buchholz, isBo3, pairGroup, simulateSwiss, type SwissTeam } from "../lib/cs2/pickem";

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
