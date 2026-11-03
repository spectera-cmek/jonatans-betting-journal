import { describe, it, expect } from "vitest";
import { valueWindows } from "../lib/nba/lag";

const T0 = Date.parse("2026-03-01T12:00:00Z");
const at = (min: number, price: number, active = true) => ({ createdAt: new Date(T0 + min * 60e3).toISOString(), price, active });

describe("värdefönster", () => {
  const start = T0 + 600 * 60e3;

  it("öppnar när Pinnacle flyttar och bolaget hänger efter, stänger när bolaget kommer ifatt", () => {
    const w = valueWindows(
      {
        // Pinnacle 1,95/1,95 → 1,70/2,25 efter 60 min (nyhet: sida 1 starkare).
        ref1: [at(0, 1.95), at(60, 1.7)],
        ref2: [at(0, 1.95), at(60, 2.25)],
        // Bolaget 1,90/1,90 och flyttar först efter 75 min.
        book1: [at(0, 1.9), at(75, 1.65)],
        book2: [at(0, 1.9), at(75, 2.15)],
      },
      { from: T0, start, minEv: 0.02 }
    );
    expect(w).toHaveLength(1);
    expect(w[0].side).toBe(1);
    expect((w[0].closedAt - w[0].openedAt) / 60e3).toBe(15);
    expect(w[0].closedBy).toBe("book");
    expect(w[0].ev).toBeGreaterThan(0.08); // 1,90 när rättvist ≈ 1,74
    expect(w[0].evClose!).toBeGreaterThan(0.08); // Pinnacle stannade där
  });

  it("brus: Pinnacle flyttar tillbaka — stängt av Pinnacle, inget värde mot stängningen", () => {
    const w = valueWindows(
      {
        ref1: [at(0, 1.95), at(60, 1.7), at(70, 1.95)],
        ref2: [at(0, 1.95), at(60, 2.25), at(70, 1.95)],
        book1: [at(0, 1.9)],
        book2: [at(0, 1.9)],
      },
      { from: T0, start, minEv: 0.02 }
    );
    expect(w).toHaveLength(1);
    expect(w[0].closedBy).toBe("ref");
    expect(w[0].evClose!).toBeLessThan(0);
  });

  it("stängd marknad hos bolaget stänger fönstret; tunna linjer utanför bandet ignoreras", () => {
    const s = {
      ref1: [at(0, 1.95), at(60, 1.7)],
      ref2: [at(0, 1.95), at(60, 2.25)],
      book1: [at(0, 1.9), at(65, 1.9, false)],
      book2: [at(0, 1.9), at(65, 1.9, false)],
    };
    const w = valueWindows(s, { from: T0, start, minEv: 0.02 });
    expect(w[0].closedBy).toBe("suspended");
    expect(valueWindows(s, { from: T0, start, minEv: 0.02, priceBand: [1.8, 2.2] })).toHaveLength(0);
  });

  it("ett fönster som är öppet vid matchstart stängs av starten", () => {
    const w = valueWindows(
      { ref1: [at(0, 1.7)], ref2: [at(0, 2.25)], book1: [at(0, 1.9)], book2: [at(0, 1.9)] },
      { from: T0, start, minEv: 0.02 }
    );
    expect(w[0].closedBy).toBe("start");
    expect(w[0].closedAt).toBe(start);
  });
});
