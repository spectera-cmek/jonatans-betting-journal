import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { findKambiEvent, isCs2, isPlayerOffer, kambiScope, mapBetOffers, marketOf, scopeOf, type KambiBetOffer, type KambiEvent } from "../lib/cs2/kambi";

// Nedbantat svar från Kambis betoffer/event/{id}.json (Unibet, Aurora – Spirit,
// oktober 2026): en betoffer per marknad, två spelare per spelarmarknad.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/cs2/kambi-betoffers.json"), "utf8")) as {
  event: KambiEvent;
  betOffers: KambiBetOffer[];
};

describe("Kambis etiketter", () => {
  it("scope ur etiketten", () => {
    expect(scopeOf("Map 1 - Total Kills by the Player")).toBe("map1");
    expect(scopeOf("Map 3 - Total Rounds")).toBe("map3");
    expect(scopeOf("Map 2")).toBe("map2");
    expect(scopeOf("Maps 1-2 - Total Kills by the Player")).toBe("maps12");
    // Utan kartnummer säger etiketten ingenting — kambiScope avgör.
    expect(scopeOf("Map Handicap")).toBeNull();
    expect(scopeOf("Total Maps")).toBeNull();
    expect(scopeOf("Total Kills by the Player")).toBeNull();
  });

  // Kambi sätter inget kartnummer på marknaderna för kartan som spelas
  // härnäst. Beläggen från PGL Major Singapore 2026, 23 november 2026, en Bo3:
  // "Total Rounds" låg på 14,5–23,5, "Total Kills by the Player" på 8,5–17,5
  // och "Round 13" och "First to 12 Rounds" finns bara inom en MR12-karta.
  it("omärkt marknad hör till kartan, inte serien", () => {
    expect(kambiScope("Total Kills by the Player")).toBe("map1");
    expect(kambiScope("Total Rounds")).toBe("map1");
    expect(kambiScope("Round Handicap")).toBe("map1");
    expect(kambiScope("Round 1")).toBe("map1");
    // Serienivån gäller fortfarande hela matchen.
    expect(kambiScope("Match Odds")).toBe("match");
    expect(kambiScope("Map Handicap")).toBe("match");
    expect(kambiScope("Total Maps")).toBe("match");
    // Ett uttalat kartnummer vinner alltid.
    expect(kambiScope("Map 2 - Total Rounds")).toBe("map2");
    expect(kambiScope("Maps 1-2 - Total Kills by the Player")).toBe("maps12");
  });

  it("marknad ur etiketten", () => {
    expect(marketOf("Map 1 - Total Kills by the Player", true)).toBe("kills");
    expect(marketOf("Map 2 - Total Headshots by the Player", true)).toBe("headshots");
    expect(marketOf("Map 1 - Round Handicap", false)).toBe("map_handicap");
    expect(marketOf("Map Handicap", false)).toBe("match_handicap");
    expect(marketOf("Map 1 - Total Rounds", false)).toBe("rounds");
    expect(marketOf("Total Maps", false)).toBe("total_maps");
    expect(marketOf("Map 1 - Round 1", false)).toBe("pistol");
    expect(marketOf("Map 1", false)).toBe("map_winner");
    expect(marketOf("Match Odds", false)).toBe("match_winner");
  });

  it("omärkta marknader prissätts som kartans", () => {
    expect(marketOf("Total Kills by the Player", true)).toBe("kills");
    expect(marketOf("Total Headshots by the Player", true)).toBe("headshots");
    expect(marketOf("Total Rounds", false)).toBe("rounds");
    expect(marketOf("Round Handicap", false)).toBe("map_handicap");
    expect(marketOf("Rundhandikapp", false)).toBe("map_handicap");
    expect(marketOf("Round 1", false)).toBe("pistol");
  });

  it("marknader utanför modellen blir other", () => {
    for (const l of [
      "Map 1  - To go into overtime",
      "To go into overtime",
      "Total Maps (Odd/Even)",
      "Correct Map Score",
      "Map 1 - Total Kills",
      "Map 1 - Total Kills by Team Spirit",
      "Map 1 - Total Kills (Odd/Even)",
      "Map 1 - First to 9 Rounds",
      "Map 1 - Round 13",
      // Omärkta syskonmarknader som liknar modellens men räknar annat.
      "Total Kills",
      "Total Kills by 100 Thieves",
      "Total Kills (Odd/Even)",
      "Round 13",
      "First to 12 Rounds",
      "Total Rounds Won by Bomb Explosion",
      "Total Rounds Won by Counter-Terrorists Eliminated",
      "Total Rounds Won by Time Running Out",
      // Halvlekar: modellen räknar hela kartor.
      "1st Half Round Handicap",
      "1st Half (3-Way)",
    ]) {
      expect(marketOf(l, false), l).toBe("other");
    }
  });

  it("spelarmarknader utanför modellen blir other", () => {
    // AWP-kills ligger kring 4,5–6,5 där kills-linjen ligger kring 15: läses de
    // som kills blir varje linje en påhittad edge.
    expect(marketOf("Total AWP Kills by the Player", true)).toBe("other");
    expect(marketOf("Map 1 - Total AWP Kills by the Player", true)).toBe("other");
    expect(marketOf("Total Deaths by the Player", true)).toBe("other");
    expect(marketOf("1st Half - Total Kills by the Player", true)).toBe("other");
  });

  it("rundhandikapp är kartans, karthandikapp är seriens", () => {
    const offer: KambiBetOffer = {
      criterion: { englishLabel: "Round Handicap" },
      betOfferType: { englishName: "Handicap" },
      outcomes: [
        { type: "OT_ONE", line: -4500, odds: 2180, participant: "HEROIC" },
        { type: "OT_TWO", line: 4500, odds: 1620, participant: "Imperial" },
      ],
    };
    const ev = { homeName: "HEROIC", awayName: "Imperial" };
    const rows = mapBetOffers([offer], ev);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ market: "map_handicap", scope: "map1", line: -4.5, overOdds: 2.18, underOdds: 1.62 });
    expect(marketOf("Map Handicap", false)).toBe("match_handicap");
    expect(kambiScope("Map Handicap")).toBe("match");
  });

  it("omärkta spelarprops blir karta 1 hela vägen genom mapBetOffers", () => {
    const offer: KambiBetOffer = {
      criterion: { englishLabel: "Total Kills by the Player" },
      betOfferType: { englishName: "Player Occurrence Line" },
      outcomes: [
        { type: "OT_OVER", line: 15500, odds: 2000, participant: "dev1ce" },
        { type: "OT_UNDER", line: 15500, odds: 1720, participant: "dev1ce" },
      ],
    };
    const rows = mapBetOffers([offer], { homeName: "100 Thieves", awayName: "Chinggis Warriors" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ market: "kills", scope: "map1", player: "dev1ce", line: 15.5, overOdds: 2, underOdds: 1.72 });
  });

  it("spelarmarknad avgörs av typen, inte av participant", () => {
    const byLabel = (l: string) => fixture.betOffers.find((b) => b.criterion?.englishLabel === l)!;
    expect(isPlayerOffer(byLabel("Map 1 - Total Kills by the Player"))).toBe(true);
    // Lagens utfall har också participant (lagnamnet).
    expect(byLabel("Match Odds").outcomes?.[0].participant).toBeTruthy();
    expect(isPlayerOffer(byLabel("Match Odds"))).toBe(false);
  });

  it("känner igen CS-matcher", () => {
    expect(isCs2(fixture.event)).toBe(true);
    expect(isCs2({ id: 1, path: [{ termKey: "esports" }, { termKey: "cs2" }] })).toBe(true);
    expect(isCs2({ id: 2, sport: "DOTA_2" })).toBe(false);
  });
});

describe("Kambis marknader → linjer", () => {
  const rows = mapBetOffers(fixture.betOffers, fixture.event);
  const pick = (market: string, scope: string, who?: string) => rows.filter((r) => r.market === market && r.scope === scope && (who == null || (r.player ?? r.team) === who));

  it("spelarkills per spelare och linje, i decimalodds", () => {
    expect(pick("kills", "map1", "XANTARES")).toEqual([
      { market: "kills", scope: "map1", player: "XANTARES", team: null, line: 13.5, overOdds: 1.9, underOdds: 1.8, includesOt: null, player2: null },
      { market: "kills", scope: "map1", player: "XANTARES", team: null, line: 14.5, overOdds: 2.15, underOdds: 1.62, includesOt: null, player2: null },
    ]);
    expect(pick("headshots", "map1", "donk")[0]).toMatchObject({ line: 13.5, overOdds: 2.38, underOdds: 1.52 });
  });

  it("lagmarknader från lag 1:s sida", () => {
    expect(pick("match_winner", "match")).toEqual([
      { market: "match_winner", scope: "match", player: null, team: "Aurora Gaming", line: null, overOdds: 2.9, underOdds: 1.38, includesOt: null, player2: null },
    ]);
    expect(pick("map_handicap", "map1")[0]).toMatchObject({ team: "Aurora Gaming", line: -3.5, overOdds: 4.6, underOdds: 1.17 });
    expect(pick("match_handicap", "match")[0]).toMatchObject({ team: "Aurora Gaming", line: 1.5, overOdds: 1.64, underOdds: 2.14 });
    expect(pick("pistol", "map1")[0]).toMatchObject({ team: "Aurora Gaming", overOdds: 2, underOdds: 1.72 });
  });

  it("totaler", () => {
    expect(pick("rounds", "map1")[0]).toMatchObject({ line: 16.5, overOdds: 1.07, underOdds: 7 });
    expect(pick("total_maps", "match")[0]).toMatchObject({ line: 2.5, overOdds: 2, underOdds: 1.73 });
  });

  it("stängda utfall hoppas över", () => {
    const offers: KambiBetOffer[] = [
      {
        criterion: { englishLabel: "Map 1 - Total Kills by the Player" },
        betOfferType: { englishName: "Player Occurrence Line" },
        outcomes: [
          { type: "OT_OVER", participant: "ropz", line: 15500, odds: 1800, status: "OPEN" },
          { type: "OT_UNDER", participant: "ropz", line: 15500, odds: 1950, status: "SUSPENDED" },
          { type: "OT_OVER", participant: "frozen", line: 15500, odds: 1800, status: "CLOSED" },
        ],
      },
    ];
    expect(mapBetOffers(offers, fixture.event)).toEqual([
      { market: "kills", scope: "map1", player: "ropz", team: null, line: 15.5, overOdds: 1.8, underOdds: null, includesOt: null, player2: null },
    ]);
  });
});

describe("hitta matchen hos Kambi", () => {
  // Kambis namn ("Aurora Gaming", "Team Spirit") mot HLTV:s.
  const teams = [
    { id: 11861, name: "Aurora" },
    { id: 7020, name: "Spirit" },
  ];
  const startAt = new Date("2026-10-11T11:30:00Z");

  it("båda lagen och närmast i tid", () => {
    const events: KambiEvent[] = [
      { id: 1, homeName: "Aurora Gaming", awayName: "Team Vitality", start: "2026-10-11T11:30:00Z" },
      { id: 2, homeName: "Aurora Gaming", awayName: "Team Spirit", start: "2026-10-12T09:00:00Z" },
      fixture.event,
    ];
    expect(findKambiEvent({ startAt, teams }, events)?.id).toBe(fixture.event.id);
  });

  it("ingen träff utan båda lagen eller för långt bort i tid", () => {
    expect(findKambiEvent({ startAt, teams }, [{ id: 1, homeName: "Aurora Gaming", awayName: "MOUZ", start: "2026-10-11T11:30:00Z" }])).toBeNull();
    expect(findKambiEvent({ startAt, teams }, [{ ...fixture.event, start: "2026-10-14T11:30:00Z" }])).toBeNull();
    expect(findKambiEvent({ startAt, teams: teams.slice(0, 1) }, [fixture.event])).toBeNull();
  });
});
