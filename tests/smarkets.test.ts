import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { bpToDecimal, isNbaEvent, mainLines, netPrice, splitEventName, toLines, type SmContract, type SmEvent, type SmMarket, type SmQuotes } from "../lib/smarkets";
import { priceMarket } from "../lib/nba/pricing";

// Riktigt svar från Smarkets (2026-11-02): Thunder @ Cavaliers och Pistons @ Hornets.
const fx = JSON.parse(fs.readFileSync("tests/fixtures/smarkets-nba.json", "utf8")) as {
  events: SmEvent[];
  markets: SmMarket[];
  contracts: SmContract[];
  quotes: SmQuotes;
};

describe("Smarkets", () => {
  it("känner igen NBA-matcher och delar upp namnet", () => {
    expect(fx.events.every(isNbaEvent)).toBe(true);
    expect(isNbaEvent({ full_slug: "/sport/basketball/euroleague/2026/11/03/x", type: "basketball_match" })).toBe(false);
    expect(splitEventName("Oklahoma City Thunder at Cleveland Cavaliers")).toEqual({ away: "Oklahoma City Thunder", home: "Cleveland Cavaliers" });
  });

  it("plattar ut stegen: hemmalagets handicap, total och vinnare", () => {
    const lines = toLines(fx.markets, fx.contracts, fx.quotes);
    const okc = fx.events[0].id;
    const ml = lines.find((l) => l.eventId === okc && l.kind === "ml")!;
    // Cavs (hemma) favorit: lägre odds än Thunder.
    expect(ml.back1!).toBeLessThan(ml.back2!);
    // Back är alltid sämre (lägre) odds än lay på samma sida.
    expect(ml.back1!).toBeLessThanOrEqual(ml.lay1!);
    const cavs65 = lines.find((l) => l.eventId === okc && l.kind === "spread" && l.line === -6.5)!;
    expect(cavs65).toBeTruthy();
    // Hornets +4 (hemma underdog) i den andra matchen.
    expect(lines.some((l) => l.eventId === fx.events[1].id && l.kind === "spread" && l.line === 4)).toBe(true);
    const totals = lines.filter((l) => l.eventId === okc && l.kind === "total");
    expect(totals.length).toBeGreaterThan(3);
    // Högre total = bättre för över = högre överodds.
    const sorted = [...totals].filter((t) => t.back1).sort((a, b) => a.line! - b.line!);
    expect(sorted[0].back1!).toBeLessThan(sorted[sorted.length - 1].back1!);
  });

  it("huvudlinjen är den jämnaste linjen i stegen", () => {
    const main = mainLines(toLines(fx.markets, fx.contracts, fx.quotes));
    const t = main.find((l) => l.eventId === fx.events[0].id && l.kind === "total")!;
    expect(Math.abs(1 / t.back1! - 1 / t.back2!)).toBeLessThan(0.08);
    expect(main.filter((l) => l.eventId === fx.events[0].id).map((l) => l.kind).sort()).toEqual(["ml", "spread", "total"]);
  });

  it("baspunkter och provision", () => {
    expect(bpToDecimal(5000)).toBe(2);
    expect(netPrice(2)).toBeCloseTo(1.98);
    expect(netPrice(1.5)).toBeCloseTo(1.49);
  });

  it("edge mot Smarkets räknas efter provisionen, men oddsen visas som de är", () => {
    // Påhittad fördelning: totalen 220–229 lika ofta.
    const n = 1000;
    const home = new Int16Array(n);
    const away = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      home[i] = 110 + (i % 10);
      away[i] = 110;
    }
    const sim = { home, away, overtimes: 0, sims: n };
    const q = { market: "total" as const, line: 224.5, price1: 2.0, price2: 1.9 };
    const pin = priceMarket(sim, { ...q, book: "pinnacle" });
    const sm = priceMarket(sim, { ...q, book: "smarkets" });
    expect(sm.edgeOver!).toBeLessThan(pin.edgeOver!);
    expect(sm.price1).toBe(2.0);
  });
});
