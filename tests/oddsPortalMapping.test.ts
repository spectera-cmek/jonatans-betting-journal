import { describe, it, expect } from "vitest";
import {
  bookmakerMatchScore,
  bookmakerPriority,
  buildSearchQuery,
  dateWithinWindow,
  matchTitleLooksLike,
  oddsPortalSportSlug,
  pickBookmakerOdds,
  resolveMarketTarget,
  resolveSelectionColumn,
  stripTeamPrefix,
} from "../lib/oddsPortal/mapping";

describe("oddsPortalSportSlug", () => {
  it("maps football leagues", () => {
    expect(oddsPortalSportSlug("Football", "Premier League")).toBe("football");
    expect(oddsPortalSportSlug(null, "Allsvenskan")).toBe("football");
    expect(oddsPortalSportSlug("Fotboll", null)).toBe("football");
  });
  it("maps other sports", () => {
    expect(oddsPortalSportSlug("Tennis", "ATP")).toBe("tennis");
    expect(oddsPortalSportSlug("Basketball", "NBA")).toBe("basketball");
    expect(oddsPortalSportSlug("Ice Hockey", "NHL")).toBe("hockey");
    expect(oddsPortalSportSlug("Baseball", "MLB")).toBe("baseball");
    expect(oddsPortalSportSlug("American Football", "NFL")).toBe("american-football");
    expect(oddsPortalSportSlug("MMA", "UFC")).toBe("mma");
  });
});

describe("resolveSelectionColumn / resolveMarketTarget", () => {
  it("resolves 1X2 home", () => {
    expect(
      resolveSelectionColumn({
        market: "h2h",
        selectionSide: "home",
        selection: "Arsenal",
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
      })
    ).toBe("home");
  });

  it("resolves totals under", () => {
    const target = resolveMarketTarget({
      market: "totals",
      selectionSide: "under",
      selection: "Under 2.5",
      line: 2.5,
      sport: "Football",
    });
    expect(target.column).toBe("under");
    expect(target.line).toBe(2.5);
    expect(target.tabLabels[0]).toMatch(/Over\/Under/i);
    expect(target.isProp).toBe(false);
  });

  it("marks player props", () => {
    const target = resolveMarketTarget({
      market: "other",
      marketScope: "player",
      marketCategory: "Skott",
      selection: "Salah Över 1.5 skott",
      selectionSide: "over",
      line: 1.5,
      sport: "Football",
    });
    expect(target.isProp).toBe(true);
    expect(target.propHints.length).toBeGreaterThan(0);
  });

  it("uses home/away for tennis h2h", () => {
    const target = resolveMarketTarget({
      market: "h2h",
      selectionSide: "away",
      selection: "Djokovic",
      sport: "Tennis",
    });
    expect(target.hashHints.some((h) => h.includes("home-away") || h.includes("money"))).toBe(true);
    expect(target.column).toBe("away");
  });
});

describe("bookmakerPriority / pickBookmakerOdds", () => {
  it("puts bet bookmaker first", () => {
    const p = bookmakerPriority("Betsson");
    expect(p[0].toLowerCase()).toContain("betsson");
    expect(p.some((x) => /pinnacle/i.test(x))).toBe(true);
    expect(p.some((x) => /bet365/i.test(x))).toBe(true);
  });

  it("matches preferred bookmaker on page rows", () => {
    const picked = pickBookmakerOdds(
      [
        { bookmaker: "Pinnacle", odds: 1.9 },
        { bookmaker: "Betsson", odds: 2.05 },
        { bookmaker: "bet365", odds: 2.0 },
      ],
      "Betsson"
    );
    expect(picked?.row.odds).toBe(2.05);
    expect(picked?.matchedAs).toBe("Betsson");
  });

  it("falls back to Pinnacle then bet365", () => {
    const picked = pickBookmakerOdds(
      [
        { bookmaker: "Pinnacle", odds: 1.91 },
        { bookmaker: "bet365", odds: 2.0 },
      ],
      "UnknownBook"
    );
    expect(picked?.row.bookmaker).toBe("Pinnacle");
  });

  it("scores alias matches", () => {
    expect(bookmakerMatchScore("bet365", "Bet365")).toBeGreaterThanOrEqual(80);
    expect(bookmakerMatchScore("NordicBet", "Nordic Bet")).toBeGreaterThanOrEqual(70);
  });
});

describe("search helpers", () => {
  it("strips team prefixes", () => {
    expect(stripTeamPrefix("PHI Phillies")).toBe("Phillies");
  });

  it("builds search query", () => {
    expect(buildSearchQuery({ homeTeam: "Arsenal", awayTeam: "Chelsea" })).toBe("Arsenal Chelsea");
  });

  it("matches titles loosely", () => {
    expect(matchTitleLooksLike("Arsenal - Chelsea", "Arsenal", "Chelsea")).toBe(true);
    expect(matchTitleLooksLike("Liverpool - Everton", "Arsenal", "Chelsea")).toBe(false);
    expect(
      matchTitleLooksLike("TodayLevski Sofia (Bul) –Univ. Craiova (Rou)", "Levski Sofia", "CSU Craiova")
    ).toBe(true);
  });

  it("parses OU summary text", async () => {
    const { parseOuSummaryText } = await import("../lib/oddsPortal/scrape");
    const text = `
Handicap Over Under Payout
Over/Under +2.5 8 2.25 1.70 96.8%
Over/Under +3 2 3.30 1.33 94.8%
`;
    const lines = parseOuSummaryText(text);
    expect(lines.find((l) => l.line === 2.5)).toEqual({ line: 2.5, over: 2.25, under: 1.7 });
  });

  it("checks date window", () => {
    const eventAt = new Date("2026-07-20T15:00:00Z");
    expect(dateWithinWindow("2026-07-20T12:00:00Z", eventAt)).toBe(true);
    expect(dateWithinWindow("2026-07-28T12:00:00Z", eventAt)).toBe(false);
  });
});

describe("isMatchHref", () => {
  it("accepts modern h2h urls", async () => {
    const { isMatchHref } = await import("../lib/oddsPortal/scrape");
    expect(
      isMatchHref(
        "https://www.oddsportal.com/football/h2h/levski-sofia-E5OOzgs4/univ-craiova-bsd9fGaK/#MgQOEmS8",
        "football"
      )
    ).toBe(true);
    expect(
      isMatchHref("https://www.oddsportal.com/football/england/premier-league/arsenal-chelsea-123456/", "football")
    ).toBe(true);
    expect(isMatchHref("https://www.oddsportal.com/football/", "football")).toBe(false);
  });
});
