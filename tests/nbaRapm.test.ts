import { describe, it, expect } from "vitest";
import { fitRapm, lineupImpact, type StintRow } from "../lib/nba/rapm";
import { mulberry32 } from "../lib/nba/sim";
import { parseStints, periodStart } from "../lib/nba/stints";
import fs from "node:fs";

describe("RAPM", () => {
  // Syntetisk liga: 20 spelare med kända värden, slumpade femmor, brus i poängen.
  const truth = new Map<number, { off: number; def: number }>();
  for (let i = 1; i <= 20; i++) truth.set(i, { off: i === 1 ? 8 : i === 2 ? -6 : 0, def: i === 3 ? 7 : 0 });
  const rand = mulberry32(42);
  const rows: StintRow[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (let s = 0; s < 6000; s++) {
    const pool = [...truth.keys()].sort(() => rand() - 0.5);
    const home = pool.slice(0, 5);
    const away = pool.slice(5, 10);
    const poss = 20;
    const rate = (o: number[], d: number[]) => 112 + o.reduce((a, id) => a + truth.get(id)!.off, 0) - d.reduce((a, id) => a + truth.get(id)!.def, 0);
    const pts = (r: number) => Math.round((r / 100) * poss + (rand() - 0.5) * 6);
    rows.push({ t: t0 + s * 60e3, homeIds: home, awayIds: away, homePts: pts(rate(home, away) + 0.8), awayPts: pts(rate(away, home) - 0.8), poss });
  }
  const fit = fitRapm(rows, t0 + 400 * 864e5, { lambda: 500, halfLifeDays: 10000, homeRtg: 1.6, minPoss: 1, iterations: 300 });

  it("hittar spelarna med verklig påverkan", () => {
    expect(fit.players.get(1)!.off).toBeGreaterThan(5);
    expect(fit.players.get(2)!.off).toBeLessThan(-3);
    expect(fit.players.get(3)!.def).toBeGreaterThan(4);
    // Neutrala spelare nära 0.
    expect(Math.abs(fit.players.get(10)!.off)).toBeLessThan(2.5);
  });

  it("framtida stintar räknas inte", () => {
    expect(fitRapm(rows, t0).stints).toBe(0);
  });

  it("uppställningens påverkan: utan spelare 1 tappar anfallet", () => {
    const base = [1, 4, 5, 6, 7].map((playerId) => ({ playerId, minutes: 48 }));
    const today = [8, 4, 5, 6, 7].map((playerId) => ({ playerId, minutes: 48 }));
    const d = lineupImpact(fit, today, base);
    expect(d.off).toBeLessThan(-4);
  });
});

describe("stintar ur ESPN:s play-by-play", () => {
  it("periodernas starttid inklusive förlängning", () => {
    expect(periodStart(1)).toBe(0);
    expect(periodStart(5)).toBe(2880);
    expect(periodStart(6)).toBe(3180);
  });

  it("fixturen saknar plays och ger null i stället för fel", () => {
    const j = JSON.parse(fs.readFileSync("tests/fixtures/espn-nba-summary.json", "utf8"));
    expect(parseStints(j)).toBeNull();
  });

  it("en riktig match: poäng och minuter stämmer med boxscoren", () => {
    const j = JSON.parse(fs.readFileSync("tests/fixtures/espn-nba-pbp.json", "utf8"));
    const r = parseStints(j)!;
    expect(r.valid).toBe(true);
    expect(r.stints.reduce((a, s) => a + s.homePts, 0)).toBe(90);
    expect(r.stints.reduce((a, s) => a + s.awayPts, 0)).toBe(112);
    expect(r.stints.reduce((a, s) => a + s.seconds, 0)).toBe(2880);
    expect(r.minuteMae).toBeLessThan(0.5);
    for (const s of r.stints) {
      expect(s.homeIds).toHaveLength(5);
      expect(s.awayIds).toHaveLength(5);
    }
  });
});
