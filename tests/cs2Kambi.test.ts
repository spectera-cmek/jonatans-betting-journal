import { describe, it, expect } from "vitest";
import { findKambiEvent, isCs2, mapBetOffers, marketOf, scopeOf, type KambiBetOffer } from "../lib/cs2/kambi";

// Handskrivna exempel i Kambis struktur (tusendelar för odds och linjer) —
// inte inspelade svar. Byt mot en riktig fixture när en finns.

describe("Kambis etiketter", () => {
  it("scope ur etiketten", () => {
    expect(scopeOf("Player Kills - Map 1")).toBe("map1");
    expect(scopeOf("Total Rounds - Map 3")).toBe("map3");
    expect(scopeOf("Map 2 Winner")).toBe("map2");
    expect(scopeOf("Player Kills - Maps 1-2")).toBe("maps12");
    expect(scopeOf("Spelarens kills - Karta 1 och 2")).toBe("maps12");
    expect(scopeOf("Match Odds")).toBe("match");
  });

  it("marknad ur etiketten", () => {
    expect(marketOf("Player Kills - Map 1", true)).toBe("kills");
    expect(marketOf("Player Headshots - Map 1", true)).toBe("headshots");
    expect(marketOf("Kills - Map 1", false)).toBe("other");
    expect(marketOf("First Kill - Map 1", false)).toBe("first_kill");
    expect(marketOf("Player to get First Kill - Map 1", true)).toBe("player_first_kill");
    expect(marketOf("Pistol Round 1 - Map 1", false)).toBe("pistol");
    expect(marketOf("Round Handicap - Map 1", false)).toBe("map_handicap");
    expect(marketOf("Map Handicap", false)).toBe("match_handicap");
    expect(marketOf("Total Rounds - Map 2", false)).toBe("rounds");
    expect(marketOf("Total Maps", false)).toBe("total_maps");
    expect(marketOf("Match Odds", false)).toBe("match_winner");
    expect(marketOf("Map 1 Winner", false)).toBe("map_winner");
    expect(marketOf("Correct Score", false)).toBe("other");
  });

  it("känner igen CS-matcher på sökvägen", () => {
    expect(isCs2({ id: 1, path: [{ termKey: "esports" }, { termKey: "counter-strike" }] })).toBe(true);
    expect(isCs2({ id: 2, path: [{ termKey: "esports" }, { englishName: "Dota 2" }] })).toBe(false);
  });
});

describe("Kambis marknader → linjer", () => {
  const event = { homeName: "Natus Vincere", awayName: "FaZe" };

  it("spelarkills grupperas per spelare och linje", () => {
    const offers: KambiBetOffer[] = [
      {
        criterion: { englishLabel: "Player Kills - Map 1" },
        outcomes: [
          { type: "OT_OVER", participant: "s1mple", line: 18500, odds: 1850, status: "OPEN" },
          { type: "OT_UNDER", participant: "s1mple", line: 18500, odds: 1900, status: "OPEN" },
          { type: "OT_OVER", participant: "ropz", line: 15500, odds: 1800, status: "OPEN" },
          { type: "OT_UNDER", participant: "ropz", line: 15500, odds: 1950, status: "SUSPENDED" },
        ],
      },
    ];
    expect(mapBetOffers(offers, event)).toEqual([
      { market: "kills", scope: "map1", player: "s1mple", team: null, line: 18.5, overOdds: 1.85, underOdds: 1.9, includesOt: null },
      { market: "kills", scope: "map1", player: "ropz", team: null, line: 15.5, overOdds: 1.8, underOdds: null, includesOt: null },
    ]);
  });

  it("lagmarknader från hemmalagets sida, handikapp ihop per linje", () => {
    const offers: KambiBetOffer[] = [
      { criterion: { englishLabel: "Match Odds" }, outcomes: [{ type: "OT_ONE", odds: 1500 }, { type: "OT_TWO", odds: 2600 }] },
      {
        criterion: { englishLabel: "Map Handicap" },
        outcomes: [
          { type: "OT_ONE", line: -1500, odds: 2400 },
          { type: "OT_TWO", line: 1500, odds: 1550 },
        ],
      },
      { criterion: { englishLabel: "Total Rounds - Map 1" }, outcomes: [{ type: "OT_OVER", line: 21500, odds: 1870 }, { type: "OT_UNDER", line: 21500, odds: 1870 }] },
    ];
    expect(mapBetOffers(offers, event)).toEqual([
      { market: "match_winner", scope: "match", player: null, team: "Natus Vincere", line: null, overOdds: 1.5, underOdds: 2.6, includesOt: null },
      { market: "match_handicap", scope: "match", player: null, team: "Natus Vincere", line: -1.5, overOdds: 2.4, underOdds: 1.55, includesOt: null },
      { market: "rounds", scope: "map1", player: null, team: null, line: 21.5, overOdds: 1.87, underOdds: 1.87, includesOt: null },
    ]);
  });
});

describe("hitta matchen hos Kambi", () => {
  const teams = [
    { id: 4608, name: "Natus Vincere" },
    { id: 6667, name: "FaZe" },
  ];
  const startAt = new Date("2026-10-12T16:00:00Z");

  it("båda lagen och närmast i tid", () => {
    const events = [
      { id: 1, homeName: "NAVI", awayName: "Astralis", start: "2026-10-12T16:00:00Z" },
      { id: 2, homeName: "FaZe Clan", awayName: "NAVI", start: "2026-10-14T16:00:00Z" },
      { id: 3, homeName: "FaZe Clan", awayName: "NAVI", start: "2026-10-12T16:30:00Z" },
    ];
    expect(findKambiEvent({ startAt, teams }, events)?.id).toBe(3);
  });

  it("ingen träff utan båda lagen", () => {
    expect(findKambiEvent({ startAt, teams }, [{ id: 1, homeName: "NAVI", awayName: "Spirit", start: "2026-10-12T16:00:00Z" }])).toBeNull();
    expect(findKambiEvent({ startAt, teams: teams.slice(0, 1) }, [])).toBeNull();
  });
});
