import { describe, it, expect } from "vitest";
import { mapsWon, summarizeHeadToHead } from "../lib/cs2/h2h";

const row = (o: {
  id: number;
  day: number;
  t1: number;
  t2: number;
  winnerId?: number | null;
  maps: Array<[string, number, number]>;
  format?: string;
}) => ({
  id: o.id,
  startAt: new Date(Date.UTC(2026, 9, o.day)),
  eventName: "Event",
  format: o.format ?? "bo3",
  team1Id: o.t1,
  team2Id: o.t2,
  team1Name: `lag${o.t1}`,
  team2Name: `lag${o.t2}`,
  winnerId: o.winnerId ?? null,
  maps: o.maps.map(([mapName, a, b], i) => ({ mapNumber: i + 1, mapName, team1Id: o.t1, team1Rounds: a, team2Rounds: b })),
});

describe("h2h", () => {
  it("kartor vunna räknas ur lagets perspektiv", () => {
    const m = row({ id: 1, day: 1, t1: 5, t2: 6, maps: [["inferno", 13, 9], ["nuke", 7, 13], ["mirage", 13, 11]] });
    expect(mapsWon(m, 5)).toEqual({ won: 2, lost: 1 });
    expect(mapsWon(m, 6)).toEqual({ won: 1, lost: 2 });
  });

  it("vänder möten där lagen stod i omvänd ordning, och räknar kartfacit", () => {
    const v = summarizeHeadToHead(
      1,
      2,
      [
        row({ id: 10, day: 3, t1: 2, t2: 1, winnerId: 2, maps: [["inferno", 13, 5], ["nuke", 13, 10]] }),
        row({ id: 11, day: 1, t1: 1, t2: 2, winnerId: 1, format: "bo1", maps: [["inferno", 16, 14]] }),
      ],
      [],
      [],
      new Map()
    );
    expect(v.meetings[0]).toMatchObject({ matchId: 10, s1: 0, s2: 2, winner: 2 });
    expect(v.meetings[0].maps[0]).toMatchObject({ mapName: "inferno", r1: 5, r2: 13, winner: 2 });
    expect(v.meetings[1]).toMatchObject({ s1: 1, s2: 0, winner: 1, format: "bo1" });
    expect(v.mapRecord).toEqual([
      { mapName: "inferno", label: "Inferno", w1: 1, w2: 1 },
      { mapName: "nuke", label: "Nuke", w1: 0, w2: 1 },
    ]);
  });

  it("formen: motståndare, rank och resultat per serie", () => {
    const v = summarizeHeadToHead(
      1,
      2,
      [],
      [row({ id: 20, day: 5, t1: 9, t2: 1, winnerId: 1, maps: [["ancient", 10, 13], ["anubis", 11, 13]] })],
      [row({ id: 21, day: 5, t1: 2, t2: 8, winnerId: null, maps: [["dust2", 13, 3]] })],
      new Map([[9, 4]])
    );
    expect(v.form.team1[0]).toMatchObject({ oppId: 9, oppName: "lag9", oppRank: 4, won: 2, lost: 0, result: "win" });
    // Utan winnerId avgör kartorna.
    expect(v.form.team2[0]).toMatchObject({ oppId: 8, oppRank: null, won: 1, lost: 0, result: "win" });
  });
});
