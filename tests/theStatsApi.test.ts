import { describe, it, expect } from "vitest";
import {
  parseOddsValue,
  pickBookmakerOdds,
  isStatsApiMatchRef,
  statsApiSportKey,
  statsApiBookmakerName,
  bookmakerSlug,
  extractShotLines,
  extractMarketPrices,
  fullMatchStat,
  matchTeamTotals,
  type MatchOddsResponse,
  type MatchStats,
} from "../lib/theStatsApi";

describe("isStatsApiMatchRef", () => {
  it("detects mt_ prefix", () => {
    expect(isStatsApiMatchRef("mt_838955483")).toBe(true);
    expect(isStatsApiMatchRef("ev-abc")).toBe(false);
    expect(isStatsApiMatchRef(null)).toBe(false);
  });
});

describe("statsApiSportKey", () => {
  it("prefixes competition id", () => {
    expect(statsApiSportKey("comp_3039")).toBe("tsa:comp_3039");
  });
});

describe("parseOddsValue", () => {
  it("parses last_seen closing odds", () => {
    expect(parseOddsValue({ opening: "1.50", last_seen: "1.72" })).toBe(1.72);
  });
  it("returns null for invalid values", () => {
    expect(parseOddsValue(undefined)).toBeNull();
    expect(parseOddsValue({ opening: null, last_seen: "0.95" })).toBeNull();
  });
});

describe("statsApiBookmakerName", () => {
  it("maps common bookmakers", () => {
    expect(statsApiBookmakerName("Bet365")).toBe("Bet365");
    expect(statsApiBookmakerName("Pinnacle")).toBe("Pinnacle");
    expect(statsApiBookmakerName("Betsson")).toBe("Kambi");
  });
});

describe("pickBookmakerOdds", () => {
  const bookmakers = [
    {
      bookmaker: "Bet365",
      markets: {
        match_odds: {
          home: { opening: "2.00", last_seen: "1.90" },
        },
      },
    },
    {
      bookmaker: "Pinnacle",
      markets: {
        match_odds: {
          home: { opening: "2.10", last_seen: "1.85" },
        },
      },
    },
  ];

  it("prefers bet bookmaker", () => {
    expect(pickBookmakerOdds(bookmakers, "Bet365")?.bookmaker).toBe("Bet365");
  });
  it("falls back to Pinnacle then Bet365", () => {
    expect(pickBookmakerOdds(bookmakers, "Unibet")?.bookmaker).toBe("Pinnacle");
  });
});

describe("bookmakerSlug", () => {
  it("maps response display names back to query slugs", () => {
    expect(bookmakerSlug("Bet365")).toBe("bet365");
    expect(bookmakerSlug("Betfair Exchange")).toBe("betfair-exchange");
    expect(bookmakerSlug("BetMGM UK")).toBe("betmgm-uk");
    expect(bookmakerSlug("Paddy Power")).toBe("paddy-power");
  });

  it("is null for bookmakers this API does not carry", () => {
    expect(bookmakerSlug("Unibet")).toBeNull();
  });
});

describe("extractShotLines", () => {
  const res: MatchOddsResponse = {
    match_id: "mt_1",
    bookmakers: [
      {
        bookmaker: "Pinnacle",
        markets: {
          match_shots: {
            "24.5": {
              over: { opening: "1.95", last_seen: "1.90" },
              under: { opening: "1.85", last_seen: "1.92" },
            },
          },
          match_corners: {
            "9.5": { over: { opening: "2.05", last_seen: "2.00" } },
          },
          team_shots: {
            home: { "12.5": { over: { opening: null, last_seen: "1.80" }, under: { opening: null, last_seen: "2.00" } } },
            away: { "9.5": { over: { opening: null, last_seen: "1.70" } } },
          },
          // Marknad appen inte modellerar — ska ignoreras.
          total_goals: { "2.5": { over: { opening: "1.90", last_seen: "1.88" } } },
        },
      },
      // Bokmakare utanför API:ets uppsättning hoppas över helt.
      { bookmaker: "Some Local Book", markets: { match_shots: { "20.5": { over: { opening: "2.0", last_seen: "2.0" } } } } },
    ],
  };

  const lines = extractShotLines(res);

  it("only emits shot and corner markets", () => {
    expect(lines.every((l) => ["shots", "sot", "corners"].includes(l.metric))).toBe(true);
    expect(lines.some((l) => l.line === 2.5)).toBe(false); // total_goals ignorerad
  });

  it("skips bookmakers outside the API's set", () => {
    expect(lines.every((l) => l.bookmaker === "pinnacle")).toBe(true);
  });

  it("emits both an opening and a closing row when both prices exist", () => {
    const matchShots = lines.filter((l) => l.metric === "shots" && l.side === "match");
    expect(matchShots).toHaveLength(2);
    const opening = matchShots.find((l) => !l.isClosing)!;
    const closing = matchShots.find((l) => l.isClosing)!;
    expect(opening.overOdds).toBe(1.95);
    expect(opening.underOdds).toBe(1.85);
    expect(closing.overOdds).toBe(1.9);
    expect(closing.underOdds).toBe(1.92);
    expect(closing.line).toBe(24.5);
  });

  it("emits closing only when no opening price was recorded", () => {
    const homeShots = lines.filter((l) => l.metric === "shots" && l.side === "home");
    expect(homeShots).toHaveLength(1);
    expect(homeShots[0].isClosing).toBe(true);
    expect(homeShots[0].line).toBe(12.5);
    expect(homeShots[0].overOdds).toBe(1.8);
    expect(homeShots[0].underOdds).toBe(2);
  });

  it("keeps one-sided markets with a null opposite price", () => {
    const corners = lines.filter((l) => l.metric === "corners");
    expect(corners.every((l) => l.underOdds === null)).toBe(true);
    expect(corners.some((l) => l.overOdds === 2.05 && !l.isClosing)).toBe(true);
  });

  it("splits team lines into home and away sides", () => {
    const away = lines.filter((l) => l.side === "away");
    expect(away).toHaveLength(1);
    expect(away[0].line).toBe(9.5);
    expect(away[0].metric).toBe("shots");
  });

  it("returns nothing for an empty response", () => {
    expect(extractShotLines({ match_id: "mt_2", bookmakers: [] })).toEqual([]);
  });
});

describe("extractMarketPrices", () => {
  // Formen är tagen ur ett verkligt svar för Arsenal–Coventry.
  const res: MatchOddsResponse = {
    match_id: "mt_1",
    bookmakers: [
      {
        bookmaker: "Bet365",
        markets: {
          match_odds: {
            home: { opening: null, last_seen: "1.167" },
            draw: { opening: null, last_seen: "7.500" },
            away: { opening: null, last_seen: "15.000" },
          },
          total_goals: {
            "1.5": { over: { opening: null, last_seen: "1.167" }, under: { opening: null, last_seen: "5.000" } },
          },
          asian_handicap: {
            home: { "-3.5": { opening: null, last_seen: "4.250" } },
            away: { "3.5": { opening: null, last_seen: "1.220" } },
          },
        },
      },
      {
        bookmaker: "Betfair Exchange",
        markets: {
          match_odds: {
            home: {
              opening: null,
              last_seen: "1.200",
              available_to_back: [{ price: 1.2, size: 40003 }],
              available_to_lay: [{ price: 1.21, size: 42641 }],
            },
          },
        },
      },
      // Bok utanför API:ets uppsättning — ska hoppas över helt.
      { bookmaker: "Some Local Book", markets: { match_odds: { home: { opening: null, last_seen: "1.2" } } } },
    ],
  };

  const rows = extractMarketPrices(res);

  it("flattens all three markets", () => {
    expect(new Set(rows.map((r) => r.market))).toEqual(new Set(["1x2", "totals", "ah"]));
  });

  it("skips bookmakers outside the API's set", () => {
    expect(rows.every((r) => ["bet365", "betfair-exchange"].includes(r.bookmaker))).toBe(true);
  });

  it("gives 1X2 a null line and all three outcomes", () => {
    const x2 = rows.filter((r) => r.market === "1x2" && r.bookmaker === "bet365");
    expect(x2.map((r) => r.outcome).sort()).toEqual(["away", "draw", "home"]);
    expect(x2.every((r) => r.line === null)).toBe(true);
  });

  it("carries the exchange order book, and null for fixed-odds books", () => {
    const exch = rows.find((r) => r.bookmaker === "betfair-exchange" && r.outcome === "home")!;
    expect(exch.odds).toBe(1.2);
    expect(exch.layOdds).toBe(1.21);
    expect(exch.backSize).toBe(40003);
    expect(exch.laySize).toBe(42641);

    const soft = rows.find((r) => r.bookmaker === "bet365" && r.market === "1x2" && r.outcome === "home")!;
    expect(soft.odds).toBe(1.167);
    expect(soft.layOdds).toBeNull();
    expect(soft.backSize).toBeNull();
  });

  it("keeps totals lines as numbers with both sides", () => {
    const t = rows.filter((r) => r.market === "totals");
    expect(t).toHaveLength(2);
    expect(t.every((r) => r.line === 1.5)).toBe(true);
    expect(t.map((r) => r.outcome).sort()).toEqual(["over", "under"]);
  });

  it("stores handicap lines exactly as the API gave them", () => {
    const ah = rows.filter((r) => r.market === "ah");
    expect(ah.find((r) => r.outcome === "home")!.line).toBe(-3.5);
    expect(ah.find((r) => r.outcome === "away")!.line).toBe(3.5);
  });

  it("returns nothing for an empty response", () => {
    expect(extractMarketPrices({ match_id: "mt_2", bookmakers: [] })).toEqual([]);
  });
});

describe("matchTeamTotals", () => {
  const stats: MatchStats = {
    match_id: "mt_1",
    overview: {
      corner_kicks: { all: { home: 7, away: 4 }, first_half: { home: 3, away: 2 }, second_half: null },
      expected_goals: { all: { home: 1.8, away: 0.6 }, first_half: null, second_half: null },
      ball_possession: { all: { home: 58, away: 42 }, first_half: null, second_half: null },
      total_shots: { all: { home: 99, away: 99 }, first_half: null, second_half: null },
    },
    shots: {
      total_shots: { all: { home: 18, away: 9 }, first_half: null, second_half: null },
      shots_on_target: { all: { home: 6, away: 2 }, first_half: null, second_half: null },
    },
  };

  it("prefers the detailed shots block over overview", () => {
    expect(matchTeamTotals(stats).shots).toEqual({ home: 18, away: 9 });
  });

  it("pulls corners, xG and possession from overview", () => {
    const t = matchTeamTotals(stats);
    expect(t.corners).toEqual({ home: 7, away: 4 });
    expect(t.xg).toEqual({ home: 1.8, away: 0.6 });
    expect(t.possession).toEqual({ home: 58, away: 42 });
    expect(t.sot).toEqual({ home: 6, away: 2 });
  });

  it("falls back to overview when the shots block is missing", () => {
    const { shots, ...rest } = stats;
    expect(matchTeamTotals(rest).shots).toEqual({ home: 99, away: 99 });
  });

  it("is null for stats the match never carried", () => {
    expect(matchTeamTotals({ match_id: "mt_3" }).corners).toBeNull();
  });
});

describe("fullMatchStat", () => {
  it("takes the full-match period", () => {
    expect(fullMatchStat({ all: { home: 5, away: 3 }, first_half: null, second_half: null })).toEqual({
      home: 5,
      away: 3,
    });
  });

  it("is null when the period was never ingested — not a fabricated 0", () => {
    expect(fullMatchStat({ all: null, first_half: { home: 1, away: 1 }, second_half: null })).toBeNull();
    expect(fullMatchStat(null)).toBeNull();
    expect(fullMatchStat(undefined)).toBeNull();
  });
});
