import { describe, it, expect } from "vitest";
import { changedLines } from "../lib/cs2/lineStore";
import { lineKey } from "../lib/cs2/lineInput";
import { latestPerLine } from "../lib/cs2/settle";

const kills = (line: number, overOdds: number | null, underOdds: number | null, playerId = 7) => ({
  market: "kills",
  scope: "map1",
  playerId,
  player2Id: null,
  teamId: null,
  line,
  overOdds,
  underOdds,
});

describe("automatiska linjer", () => {
  it("nyckeln skiljer på linje och spelare men inte på odds", () => {
    expect(lineKey(kills(15.5, 1.8, 2))).toBe(lineKey(kills(15.5, 1.9, 1.9)));
    expect(lineKey(kills(15.5, 1.8, 2))).not.toBe(lineKey(kills(16.5, 1.8, 2)));
    expect(lineKey(kills(15.5, 1.8, 2))).not.toBe(lineKey(kills(15.5, 1.8, 2, 8)));
  });

  it("sparar nya linjer och ändrade odds, inte oförändrade", () => {
    const saved = [
      { id: 1, ...kills(15.5, 1.8, 2) },
      { id: 2, ...kills(16.5, 2.1, 1.7) },
      // Senare version av 16,5 — den jämförs mot.
      { id: 3, ...kills(16.5, 2.2, 1.65) },
    ];
    const rows = [kills(15.5, 1.8, 2), kills(16.5, 2.1, 1.7), kills(17.5, 2.5, 1.5)];
    const out = changedLines(rows, saved);
    expect(out.map((r) => r.line)).toEqual([16.5, 17.5]);
  });

  it("samma linje två gånger i bokens svar sparas en gång", () => {
    expect(changedLines([kills(15.5, 1.8, 2), kills(15.5, 1.8, 2)], [])).toHaveLength(1);
  });
});

describe("facit per linje", () => {
  const proj = (id: number, bookmaker: string | null, line: number, matchId = 1, lineId: number | null = id) => ({
    id,
    matchId,
    lineId,
    bookmaker,
    ...kills(line, null, null),
  });

  it("räknar den senaste versionen per linje och bok", () => {
    const out = latestPerLine([proj(1, "Unibet", 15.5), proj(5, "Unibet", 15.5), proj(3, "Unibet", 15.5)]);
    expect(out.map((r) => r.id)).toEqual([5]);
  });

  it("håller isär böcker, matcher och linjer", () => {
    const out = latestPerLine([proj(1, "Unibet", 15.5), proj(2, "Bet365", 15.5), proj(3, "Unibet", 16.5), proj(4, "Unibet", 15.5, 2)]);
    expect(out).toHaveLength(4);
  });

  it("bokens namn jämförs utan skiftläge och mellanslag", () => {
    expect(latestPerLine([proj(1, "Svenskaspel ", 15.5), proj(2, "svenskaspel", 15.5)])).toHaveLength(1);
  });

  it("projektioner utan linje räknas var för sig", () => {
    expect(latestPerLine([proj(1, null, 15.5, 1, null), proj(2, null, 15.5, 1, null)])).toHaveLength(2);
  });
});
