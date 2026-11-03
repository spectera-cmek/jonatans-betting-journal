import { describe, it, expect } from "vitest";
import { devigPower, invNormalCdf, outcomeAt, staleEv } from "../lib/nba/stale";
import { closingFromHistory, type MarketSpec } from "../lib/oddspapi/markets";
import { normalCdf } from "../lib/variance";

describe("sega linjer", () => {
  it("Φ⁻¹ är inversen av Φ", () => {
    for (const p of [0.05, 0.3, 0.5, 0.77, 0.99]) expect(normalCdf(invNormalCdf(p))).toBeCloseTo(p, 6);
  });

  it("samma linje ger Pinnacles rättvisa sannolikhet tillbaka", () => {
    const o = outcomeAt("spread", -5.5, 0.5, -5.5);
    expect(o.win1).toBeCloseTo(0.5, 6);
    expect(outcomeAt("total", 224.5, 0.6, 224.5).win1).toBeCloseTo(0.6, 6);
  });

  it("en bättre siffra hos bolaget ger högre chans", () => {
    // Pinnacle hemma −5,5 till 50 %. Bolaget hemma −4: hemma täcker oftare.
    expect(outcomeAt("spread", -5.5, 0.5, -4.5).win1).toBeGreaterThan(0.5);
    // Över 222,5 hos bolaget när Pinnacle har 224,5 till 50 %: över går oftare.
    expect(outcomeAt("total", 224.5, 0.5, 222.5).win1).toBeGreaterThan(0.5);
    // En poäng ≈ 2–3 procentenheter i NBA.
    const d = outcomeAt("spread", -5.5, 0.5, -4.5).win1 - 0.5;
    expect(d).toBeGreaterThan(0.02);
    expect(d).toBeLessThan(0.035);
  });

  it("heltalslinjer får push", () => {
    const o = outcomeAt("spread", -5.5, 0.5, -5);
    expect(o.push).toBeGreaterThan(0.015);
    expect(o.win1 + o.push + o.win2).toBeCloseTo(1, 9);
  });

  it("EV: samma linje och samma pris som Pinnacle utan marginal = 0; bättre odds = positiv", () => {
    const pin = { line: -5.5, price1: 1.95, price2: 1.95 };
    const fair = staleEv("spread", pin, { line: -5.5, price1: 2.0, price2: 2.0 })!;
    expect(fair.ev1).toBeCloseTo(0, 6);
    const soft = staleEv("spread", pin, { line: -4.5, price1: 1.91, price2: 1.91 })!;
    // Hemma −4,5 till 1,91 när rättvist är −5,5: ≈ 52,8 % mot 52,4 % som 1,91 kräver → knappt +1 %.
    expect(soft.ev1).toBeGreaterThan(0.005);
    expect(soft.ev1).toBeLessThan(0.015);
    expect(soft.ev2).toBeLessThan(0);
    expect(staleEv("ml", { line: null, price1: 1.5, price2: 2.8 }, { line: null, price1: 1.6, price2: 2.5 })!.ev1).toBeGreaterThan(0);
  });

  it("power-avviggning ger underdogen lägre chans än proportionell", () => {
    // 1,25 / 4,20: proportionellt ≈ 22,9 % för underdogen.
    const prop = (1 / 4.2) / (1 / 1.25 + 1 / 4.2);
    const pow = 1 - devigPower(1.25, 4.2)!;
    expect(pow).toBeLessThan(prop);
    expect(devigPower(1.95, 1.95)).toBeCloseTo(0.5, 9);
    expect(devigPower(1.9, 2.0)! + devigPower(2.0, 1.9)!).toBeCloseTo(1, 9);
  });

  it("stängd marknad vid tidpunkten ger inget pris — inte ett äldre", () => {
    const markets: Record<string, MarketSpec> = { "111": { kind: "ml", line: null, sides: { "111": 1, "112": 2 } } };
    const h = {
      fixtureId: "x",
      bookmakers: {
        kambi: {
          markets: {
            "111": {
              outcomes: {
                "111": { players: { "0": [{ createdAt: "2026-03-01T10:00:00Z", price: 1.5, active: true }, { createdAt: "2026-03-01T12:00:00Z", price: 1.5, active: false }] } },
                "112": { players: { "0": [{ createdAt: "2026-03-01T10:00:00Z", price: 2.6, active: true }] } },
              },
            },
          },
        },
      },
    };
    const stats = { suspended: 0 };
    expect(closingFromHistory(h as never, "kambi", markets, new Date("2026-03-01T13:00:00Z"), stats)).toEqual([]);
    expect(stats.suspended).toBe(1);
    // Före stängningen fanns priset.
    expect(closingFromHistory(h as never, "kambi", markets, new Date("2026-03-01T11:00:00Z"))).toHaveLength(1);
  });
});
