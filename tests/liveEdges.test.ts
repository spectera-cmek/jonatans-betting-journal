import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { americanToDecimal, parseKambi, parsePinnacle, type LiveEvent } from "../lib/live/books";
import { describeEdge, edgeKey, findEdges, matchEvents, updateWindows, type OpenWindow } from "../lib/live/edges";

// Riktigt svar från Kambi (Unibet SE, 2026-11-03).
const kambi = JSON.parse(fs.readFileSync("tests/fixtures/kambi-nba.json", "utf8"));

describe("Kambi", () => {
  it("läser vinnare, spread och total med hemmalaget som sida 1", () => {
    const evs = parseKambi(kambi);
    const det = evs.find((e) => e.home === "Detroit Pistons")!;
    expect(det.away).toBe("Philadelphia 76ers");
    expect(det.markets.find((m) => m.kind === "ml")).toMatchObject({ price1: 1.81, price2: 2.02 });
    expect(det.markets.find((m) => m.kind === "spread")).toMatchObject({ line: -1.5, price1: 1.92, price2: 1.9 });
    expect(det.markets.find((m) => m.kind === "total")).toMatchObject({ line: 218.5, price1: 1.9, price2: 1.92 });
    // Hemmalaget underdog: positiv handicap.
    expect(evs.find((e) => e.home === "Brooklyn Nets")!.markets.find((m) => m.kind === "spread")!.line).toBe(2.5);
  });

  it("hoppar över startade matcher och stängda utfall", () => {
    const j = JSON.parse(JSON.stringify(kambi));
    j.events[0].event.state = "STARTED";
    j.events[1].betOffers[0].outcomes[0].status = "SUSPENDED";
    const evs = parseKambi(j);
    expect(evs.find((e) => e.home === "Detroit Pistons")).toBeUndefined();
    expect(evs.find((e) => e.home === "Brooklyn Nets")!.markets.some((m) => m.kind === "ml")).toBe(false);
  });
});

describe("Pinnacle", () => {
  const matchups = [
    { id: 1, type: "matchup", startTime: "2026-11-05T00:00:00Z", participants: [{ alignment: "home", name: "Detroit Pistons" }, { alignment: "away", name: "Philadelphia 76ers" }] },
    { id: 2, type: "matchup", parentId: 1, startTime: "2026-11-05T00:00:00Z", participants: [] },
    { id: 9, type: "special", startTime: "2026-10-31T09:00:00Z", participants: [{ alignment: "neutral", name: "Boston Celtics" }] },
  ];
  const markets = [
    { matchupId: 1, type: "moneyline", period: 0, status: "open", prices: [{ designation: "home", price: -130 }, { designation: "away", price: 112 }] },
    { matchupId: 1, type: "spread", period: 0, status: "open", prices: [{ designation: "home", price: -105, points: -2.5 }, { designation: "away", price: -105, points: 2.5 }] },
    { matchupId: 1, type: "spread", period: 0, status: "open", isAlternate: true, prices: [{ designation: "home", price: 120, points: -4.5 }, { designation: "away", price: -145, points: 4.5 }] },
    { matchupId: 1, type: "total", period: 0, status: "open", prices: [{ designation: "over", price: -108, points: 219.5 }, { designation: "under", price: -102, points: 219.5 }] },
    { matchupId: 1, type: "total", period: 1, status: "open", prices: [{ designation: "over", price: -110, points: 110.5 }, { designation: "under", price: -110, points: 110.5 }] },
  ];

  it("amerikanska odds till decimal", () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1.909, 3);
    expect(americanToDecimal(150)).toBe(2.5);
  });

  it("bara riktiga matcher, hela matchen, med alternativa linjer markerade", () => {
    const evs = parsePinnacle(matchups, markets);
    expect(evs).toHaveLength(1);
    const e = evs[0];
    expect(e.home).toBe("Detroit Pistons");
    expect(e.markets.filter((m) => m.kind === "spread")).toHaveLength(2);
    expect(e.markets.find((m) => m.kind === "spread" && !m.alt)!.line).toBe(-2.5);
    expect(e.markets.find((m) => m.kind === "total")!.line).toBe(219.5); // inte första halvleken
  });
});

describe("sega linjer live", () => {
  const ev = (markets: LiveEvent["markets"], home = "Detroit Pistons"): LiveEvent => ({ id: "1", home, away: "Philadelphia 76ers", start: Date.parse("2026-11-05T00:00:00Z"), markets });

  it("kopplar matcher på smeknamn och starttid", () => {
    const k = [ev([])];
    const p = [{ ...ev([]), id: "p", home: "Detroit Pistons", start: Date.parse("2026-11-05T00:10:00Z") }];
    expect(matchEvents(k, p)).toHaveLength(1);
    expect(matchEvents(k, [{ ...p[0], start: Date.parse("2026-11-06T00:00:00Z") }])).toHaveLength(0);
  });

  it("larmar när Kambi hänger efter Pinnacle, inte annars", () => {
    // Pinnacle har flyttat till hemma −4,5; Kambi ligger kvar på −1,5.
    const pin = ev([{ kind: "spread", line: -4.5, price1: 1.95, price2: 1.95 }]);
    const slow = ev([{ kind: "spread", line: -1.5, price1: 1.92, price2: 1.9 }]);
    const edges = findEdges(slow, pin, 0.03);
    expect(edges).toHaveLength(1);
    expect(edges[0].side).toBe(1);
    expect(edges[0].sameLine).toBe(false);
    expect(describeEdge(slow, edges[0])).toMatch(/^Detroit Pistons −1,5 @ 1,92 \(rättvist 1,\d\d\) \+\d+,\d %$/);
    // Negativt värde skrivs med minus, inte "+-".
    expect(describeEdge(slow, { ...edges[0], ev: -0.002 })).toMatch(/ −0,2 %$/);
    // Samma linje och normal marginal: inget larm.
    expect(findEdges(ev([{ kind: "spread", line: -4.5, price1: 1.91, price2: 1.91 }]), pin, 0.03)).toHaveLength(0);
  });

  it("ett fönster larmar en gång, igen bara om EV stiger tydligt, och stängs när det försvinner", () => {
    const open = new Map<string, OpenWindow>();
    const e = { kind: "total" as const, line: 220.5, side: 1 as const, price: 2.0, fairPrice: 1.9, ev: 0.04, refLine: 222.5, sameLine: false };
    const key = edgeKey("ubse", "1", e);
    expect(updateWindows(open, [{ key, edge: e }], 0).alert).toHaveLength(1);
    expect(updateWindows(open, [{ key, edge: { ...e, ev: 0.05 } }], 30e3).alert).toHaveLength(0);
    expect(updateWindows(open, [{ key, edge: { ...e, ev: 0.065 } }], 60e3).alert).toHaveLength(1);
    const r = updateWindows(open, [], 90e3);
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0].maxEv).toBe(0.065);
    expect(open.size).toBe(0);
  });
});

describe("larmens värde mot stängningen", () => {
  it("värderar ett taget pris mot Pinnacles senaste rättvisa pris", async () => {
    const { valueAgainst } = await import("../lib/live/edges");
    const pin = { id: "p", home: "Detroit Pistons", away: "Philadelphia 76ers", start: 0, markets: [{ kind: "spread" as const, line: -4.5, price1: 1.95, price2: 1.95 }] };
    // Taget hemma −1,5 @ 1,92 medan Pinnacle stängde på −4,5: klart värde.
    const v = valueAgainst(pin, "spread", -1.5, 1, 1.92)!;
    expect(v.ev).toBeGreaterThan(0.05);
    expect(v.fairPrice).toBeLessThan(1.92);
    // Samma linje som stängningen till 1,95 (rättvist 2,00): negativt.
    expect(valueAgainst(pin, "spread", -4.5, 1, 1.95)!.ev).toBeLessThan(0);
    expect(valueAgainst(pin, "total", 220.5, 1, 1.9)).toBeNull();
  });
});
