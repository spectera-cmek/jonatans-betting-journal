import { describe, expect, it } from "vitest";
import {
  findBlocker,
  oddsApiClvEligibility,
  type EligibilityBet,
} from "../lib/clvEligibility";
import { eventListSnapshot, isDateOnly, snapshotFor } from "../lib/clvHistorical";

/** Ett spel som passerar allt — testerna bryter en sak i taget. */
function bet(overrides: Partial<EligibilityBet> = {}): EligibilityBet {
  return {
    betType: "single",
    eventKind: "match",
    market: "h2h",
    marketCategory: "Matchvinnare",
    marketScope: "match",
    selection: "Arsenal",
    line: null,
    sport: "Football",
    league: "Premier League",
    sportKey: "soccer_epl",
    eventAt: new Date("2026-08-20T19:00:00Z"),
    notes: null,
    boosted: false,
    ...overrides,
  };
}

describe("oddsApiClvEligibility — släpper igenom riktiga featured-marknader", () => {
  it("matchvinnare", () => {
    const v = oddsApiClvEligibility(bet());
    expect(v).toEqual({ ok: true, market: "h2h", sportKey: "soccer_epl" });
  });

  it("måltotal", () => {
    const v = oddsApiClvEligibility(
      bet({ market: "totals", marketCategory: "Totalt", selection: "Över 2.5", line: 2.5 })
    );
    expect(v.ok).toBe(true);
  });

  it("asiatiskt handikapp, även när scope råkat bli team", () => {
    const v = oddsApiClvEligibility(
      bet({
        market: "spreads",
        marketCategory: "Handikapp",
        marketScope: "team",
        selection: "Schweiz +1.0 (Asian handicap)",
        line: 1,
      })
    );
    expect(v.ok).toBe(true);
  });

  it("härleder sportKey när raden saknar en", () => {
    const v = oddsApiClvEligibility(bet({ sportKey: null, sport: "Basketball", league: "NBA" }));
    expect(v).toMatchObject({ ok: true, sportKey: "basketball_nba" });
  });

  it("ignorerar TheStatsAPI-nycklar och härleder om", () => {
    const v = oddsApiClvEligibility(bet({ sportKey: "tsa:comp_1002" }));
    expect(v).toMatchObject({ ok: true, sportKey: "soccer_epl" });
  });
});

describe("oddsApiClvEligibility — stoppar spel som skulle få fel closing", () => {
  // Kärnan i buggen: `market` är avräkningstyp, så hörnor och kort ligger som
  // "totals" och hade fått målpriset.
  it.each([
    ["hörnor", { marketCategory: "Hörnor", selection: "Över 9.5 hörnor", line: 9.5 }],
    ["kort", { marketCategory: "Kort & fouls", selection: "Över 4.5 kort", line: 4.5 }],
    ["skott", { marketCategory: "Skott", selection: "Botafogo Under 10.5 skott", line: 10.5 }],
    ["offside", { marketCategory: "Offside", selection: "Över 3.5 offside", line: 3.5 }],
    ["kills", { marketCategory: "Kills", selection: "Över 22.5 kills", line: 22.5 }],
  ])("%s hämtas inte som måltotal", (_label, overrides) => {
    const v = oddsApiClvEligibility(bet({ market: "totals", ...overrides }));
    expect(v.ok).toBe(false);
  });

  it("halvlekshandikapp är inte matchhandikapp", () => {
    const v = oddsApiClvEligibility(
      bet({
        market: "spreads",
        marketCategory: "Handikapp",
        selection: "Schweiz +0.5 (1:a halvlek Asian handicap)",
        line: 0.5,
      })
    );
    expect(v.ok).toBe(false);
  });

  it("kombinerad total över flera matcher", () => {
    const v = oddsApiClvEligibility(
      bet({
        market: "totals",
        marketCategory: "Totalt",
        selection: "Över 5.5 mål tillsammans (GamblingCabin)",
        line: 5.5,
      })
    );
    expect(v.ok).toBe(false);
  });

  it("korrekt resultat mappas inte till h2h", () => {
    const v = oddsApiClvEligibility(
      bet({ sport: "Tennis", league: "ATP", sportKey: "tennis_atp", selection: "Sinner 3-0" })
    );
    expect(v.ok).toBe(false);
  });

  it("total utanför sportens rimliga intervall", () => {
    const v = oddsApiClvEligibility(
      bet({ market: "totals", marketCategory: null, selection: "Over 22.5", line: 22.5 })
    );
    expect(v).toMatchObject({ ok: false });
  });

  // Samma kategori och samma linje som en matchtotal, men ett annat pris.
  it("lagtotal hämtas inte som matchtotal", () => {
    const scoped = oddsApiClvEligibility(
      bet({
        market: "totals",
        marketCategory: "Totalt",
        marketScope: "team",
        selection: "Över 3.5",
        line: 3.5,
      })
    );
    expect(scoped).toMatchObject({ ok: false });

    const named = oddsApiClvEligibility(
      bet({
        market: "totals",
        marketCategory: "Totalt",
        marketScope: "match",
        selection: "Antal mål för England: Över 3.5",
        line: 3.5,
      })
    );
    expect(named.ok).toBe(false);
  });

  // Slutspelsserier ligger som "Matchvinnare" men gäller inte matchen.
  it("serievinnare hämtas inte som matchvinnare", () => {
    const v = oddsApiClvEligibility(
      bet({
        sport: "Ice Hockey",
        league: "NHL",
        sportKey: "icehockey_nhl",
        selection: "CAR Hurricanes (vinnare av serien) - 2.55",
      })
    );
    expect(v.ok).toBe(false);
  });

  it("spelarmarknad", () => {
    const v = oddsApiClvEligibility(bet({ marketScope: "player" }));
    expect(v.ok).toBe(false);
  });

  it("kupong", () => {
    expect(oddsApiClvEligibility(bet({ betType: "accumulator" })).ok).toBe(false);
  });

  it("boostat pris är inget marknadspris", () => {
    expect(oddsApiClvEligibility(bet({ boosted: true })).ok).toBe(false);
  });

  it("[clv:skip] i noteringen", () => {
    expect(oddsApiClvEligibility(bet({ notes: "MANUELL · klubblag\n[clv:skip]" })).ok).toBe(false);
  });

  it("esport täcks inte", () => {
    const v = oddsApiClvEligibility(
      bet({ sport: "Esports", league: "CS2", sportKey: null, selection: "NAVI" })
    );
    expect(v.ok).toBe(false);
  });

  it("tennis har h2h men inte totals", () => {
    const games = oddsApiClvEligibility(
      bet({
        sport: "Tennis",
        league: "ATP",
        sportKey: "tennis_atp",
        market: "totals",
        marketCategory: "Totalt",
        selection: "Över 22.5",
        line: 22.5,
      })
    );
    expect(games.ok).toBe(false);
  });

  it("saknad avsparkstid — ingen ögonblicksbild att fråga efter", () => {
    expect(oddsApiClvEligibility(bet({ eventAt: null })).ok).toBe(false);
  });
});

describe("findBlocker — lagnamn får inte fastna i ordlistan", () => {
  it.each([
    "kortrijk",
    "somerset",
    "vancouver whitecaps",
    "gameiro",
    "manchester city",
    "bayer leverkusen",
  ])("släpper igenom %s", (name) => {
    expect(findBlocker(name)).toBeNull();
  });

  it.each([
    ["över 9.5 hörnor", "hörn"],
    ["antal kort", "kort"],
    ["1:a halvlek", "halvlek"],
    ["map-handicap", "map"],
  ])("stoppar %s", (text, expected) => {
    expect(findBlocker(text)).toBe(expected);
  });
});

describe("ögonblicksbilder", () => {
  const kickoff = new Date("2026-08-27T19:00:00.000Z");

  it("frågar två minuter före avspark, utan millisekunder", () => {
    expect(snapshotFor(kickoff)).toBe("2026-08-27T18:58:00Z");
  });

  it("matchlistan delas av alla avspark i samma femminutersruta", () => {
    const a = eventListSnapshot(kickoff);
    const b = eventListSnapshot(new Date("2026-08-27T19:01:00.000Z"));
    expect(a).toBe("2026-08-27T18:55:00Z");
    expect(b).toBe(a);
  });

  // Rader som bara har ett datum får en vidare matchningsgräns, eftersom
  // midnatt inte säger något om när matchen faktiskt spelades.
  it("skiljer datum-utan-klockslag från riktiga avsparkstider", () => {
    expect(isDateOnly(new Date("2026-08-27T00:00:00.000Z"))).toBe(true);
    expect(isDateOnly(kickoff)).toBe(false);
    expect(isDateOnly(new Date("2026-08-27T00:00:01.000Z"))).toBe(false);
  });
});
