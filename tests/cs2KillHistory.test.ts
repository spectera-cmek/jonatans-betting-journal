import { describe, it, expect } from "vitest";
import { demoHistory, killHistory, killRates, leaguePriorFromFacts, teamConcession, vsOpponent, DEFAULT_LEAGUE_PRIOR, KILL_HALF_LIFE_DAYS } from "../lib/cs2/killModel";

const day = 86_400_000;
const now = new Date("2026-10-09T12:00:00Z");
const row = (daysAgo: number, kills: number, opp: number | null = null) => ({
  playedAt: new Date(now.getTime() - daysAgo * day),
  mapName: "nuke",
  kills,
  headshots: Math.round(kills / 2),
  won: 13,
  lost: 9,
  opp,
});

describe("kill-historik", () => {
  it("nya kartor väger mer än gamla (halveringstid)", () => {
    const h = killHistory([row(0, 30), row(KILL_HALF_LIFE_DAYS, 10)], now);
    // Vikt 1 och 0,5: (30 + 5) / (22 · 1,5)
    expect(h.nuke.kills).toBeCloseTo(35, 6);
    expect(h.nuke.roundsWon + h.nuke.roundsLost).toBeCloseTo(33, 6);
    const r = killRates({ demo: {}, hltv: h }, DEFAULT_LEAGUE_PRIOR, ["nuke"]);
    const flipped = killRates({ demo: {}, hltv: killHistory([row(0, 10), row(KILL_HALF_LIFE_DAYS, 30)], now) }, DEFAULT_LEAGUE_PRIOR, ["nuke"]);
    expect(r.nuke.kw).toBeGreaterThan(flipped.nuke.kw);
  });

  it("kills mot ett lag som släpper till mycket räknas ner", () => {
    const h = killHistory([row(0, 24, 7)], now, { 7: 1.2 });
    expect(h.nuke.kills).toBeCloseTo(20, 6);
    expect(killHistory([row(0, 24, 7)], now, {}).nuke.kills).toBeCloseTo(24, 6);
  });

  it("släppta kills per lag, krympt mot ligan", () => {
    // Lag 1 släpper 20 kills/22 rundor, lag 2 släpper 10/22.
    const maps = Array.from({ length: 30 }, () => ({ team1Id: 1, team2Id: 2, rounds: 22, kills1: 10, kills2: 20 }));
    const c = teamConcession(maps, 300);
    expect(c.league).toBeCloseTo(30 / 44, 6);
    expect(c.byTeam[1]).toBeGreaterThan(1);
    expect(c.byTeam[2]).toBeLessThan(1);
    // Krympningen drar mot 1 men behåller ordningen.
    expect(c.byTeam[1]).toBeLessThan((20 / 22) / c.league);
    expect(teamConcession(maps, 0).byTeam[1]).toBeCloseTo((20 / 22) / c.league, 6);
  });

  it("raterna skalas efter kommande motståndare", () => {
    const r = killRates({ demo: {}, hltv: killHistory([row(0, 20)], now) }, DEFAULT_LEAGUE_PRIOR, ["nuke"]);
    const up = vsOpponent(r, 1.1);
    expect(up.nuke.kw).toBeCloseTo(r.nuke.kw * 1.1, 9);
    expect(up.all.kl).toBeCloseTo(r.all.kl * 1.1, 9);
    expect(vsOpponent(r, 1)).toBe(r);
  });

  it("demofakta vägs som HLTV-historiken", () => {
    const facts = { killsWon: 12, killsLost: 6, roundsWon: 13, rounds: 22, headshots: 9, kills: 18 };
    const d = demoHistory(
      [
        { playedAt: now, mapName: "nuke", opp: 7, facts },
        { playedAt: new Date(now.getTime() - KILL_HALF_LIFE_DAYS * day), mapName: "nuke", opp: null, facts },
      ],
      now,
      { 7: 1.2 }
    );
    // Vikt 1 mot ett lag som släpper 1,2× och vikt 0,5 utan motstånd.
    expect(d.nuke.killsWon).toBeCloseTo(12 / 1.2 + 6, 6);
    expect(d.nuke.rounds).toBeCloseTo(33, 6);
  });

  it("ligans nivå ur demofakta, standard vid för lite underlag", () => {
    expect(leaguePriorFromFacts([])).toBe(DEFAULT_LEAGUE_PRIOR);
    const many = Array.from({ length: 250 }, () => ({ killsWon: 9, killsLost: 4, roundsWon: 12, rounds: 22, headshots: 6, kills: 13 }));
    const l = leaguePriorFromFacts(many);
    expect(l.kw).toBeCloseTo(9 / 12, 9);
    expect(l.kl).toBeCloseTo(4 / 10, 9);
    expect(l.hs).toBeCloseTo(6 / 13, 9);
  });
});
