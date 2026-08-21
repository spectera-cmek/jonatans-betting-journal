import { describe, it, expect } from "vitest";
import {
  exchangeMid,
  isLiquid,
  exchangeReference,
  pinnacleReference,
  marketReference,
  normalizeHandicap,
  verifyHandicapSigns,
  priceMarket,
  isShoppable,
  EXCHANGE_BOOK,
  PINNACLE_BOOK,
  type BookMarket,
  type OddsOutcome,
} from "../lib/marketOdds";

const X2 = ["home", "draw", "away"] as OddsOutcome[];
const OU = ["over", "under"] as OddsOutcome[];

/** Börspris med back/lay och djup. */
const ex = (outcome: OddsOutcome, back: number, lay: number, size = 5000) => ({
  outcome,
  odds: back,
  layOdds: lay,
  backSize: size,
  laySize: size,
});
/** Fastodds-pris. */
const fx = (outcome: OddsOutcome, odds: number) => ({ outcome, odds });
/** Börspris utan djup — så The Odds API levererar det. */
const nd = (outcome: OddsOutcome, back: number, lay: number) => ({
  outcome,
  odds: back,
  layOdds: lay,
  backSize: null,
  laySize: null,
});

describe("exchangeMid", () => {
  it("averages in probability space, not odds space", () => {
    // back 6.00, lay 6.97 — bred spread gör skillnaden mätbar.
    const mid = exchangeMid(ex("home", 6, 6.97))!;
    const probSpace = (1 / 6 + 1 / 6.97) / 2;
    const oddsSpace = 1 / ((6 + 6.97) / 2);
    expect(mid.prob).toBeCloseTo(probSpace, 10);
    expect(mid.prob).not.toBeCloseTo(oddsSpace, 5);
    // Odds-mitten underskattar sannolikheten här — därav skevheten.
    expect(mid.prob).toBeGreaterThan(oddsSpace);
  });

  it("matches the real Arsenal quote", () => {
    const mid = exchangeMid(ex("home", 1.2, 1.21, 40003))!;
    expect(mid.prob).toBeCloseTo((1 / 1.2 + 1 / 1.21) / 2, 10);
    expect(mid.spreadPct).toBeCloseTo(0.8333, 3);
    expect(mid.size).toBe(40003);
  });

  it("needs both sides — a lone back price is not a market", () => {
    expect(exchangeMid({ outcome: "home", odds: 2, layOdds: null })).toBeNull();
    expect(exchangeMid(fx("home", 2))).toBeNull();
  });

  it("rejects a crossed book", () => {
    expect(exchangeMid(ex("home", 2.1, 2.0))).toBeNull();
  });
});

describe("isLiquid", () => {
  it("passes the deep 1X2 quote", () => {
    expect(isLiquid(exchangeMid(ex("home", 1.2, 1.21, 40003))!)).toBe(true);
  });

  it("rejects the thin asian-handicap quote that would fake a 20 % edge", () => {
    // Uppmätt: back 9.33 @ 3, lay 11.00 @ 24 — 18 % spread, inget djup.
    const mid = exchangeMid({
      outcome: "home",
      odds: 9.33,
      layOdds: 11,
      backSize: 3,
      laySize: 24,
    })!;
    expect(mid.spreadPct).toBeGreaterThan(15);
    expect(isLiquid(mid)).toBe(false);
  });

  it("rejects on size alone and on spread alone", () => {
    expect(isLiquid(exchangeMid(ex("home", 2, 2.02, 10))!)).toBe(false);
    expect(isLiquid(exchangeMid(ex("home", 2, 2.4, 50000))!)).toBe(false);
  });
});

// The Odds API lämnar inget orderdjup. Då bär spreaden ensam, med en snävare
// gräns (3 %) än när djupet går att kontrollera (5 %).
describe("isLiquid utan djup", () => {
  it("markerar djupet som okänt, inte noll", () => {
    const mid = exchangeMid(nd("home", 2, 2.02))!;
    expect(mid.size).toBeNull();
  });

  it("släpper igenom en snäv spread utan djup", () => {
    // 2,00 / 2,04 = 2 % spread, väl under 3 %.
    expect(isLiquid(exchangeMid(nd("home", 2, 2.04))!)).toBe(true);
  });

  it("underkänner en spread som djupvägen ändå hade släppt", () => {
    // 2,00 / 2,08 = 4 % spread: under 5 %-gränsen med djup, över 3 % utan.
    const mid = exchangeMid(nd("home", 2, 2.08))!;
    expect(mid.spreadPct).toBeCloseTo(4, 5);
    expect(isLiquid(mid)).toBe(false);
    // Med känt djup hade samma spread godkänts.
    expect(isLiquid(exchangeMid(ex("home", 2, 2.08, 50000))!)).toBe(true);
  });

  it("minSize är null när djupet är okänt, men referensen räknas ändå", () => {
    const book: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [nd("home", 1.9, 1.92), nd("draw", 4, 4.08), nd("away", 4, 4.08)],
    };
    const ref = exchangeReference(book, X2)!;
    expect(ref).not.toBeNull();
    expect(ref.source).toBe("exchange");
    expect(ref.minSize).toBeNull();
    // Sannolikheterna summerar fortfarande till 1.
    const sum = [...ref.probs.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("faller på bred spread även utan djup", () => {
    const book: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [nd("home", 1.9, 2.1), nd("draw", 4, 4.4), nd("away", 4, 4.4)],
    };
    expect(exchangeReference(book, X2)).toBeNull();
  });
});

describe("exchangeReference", () => {
  const book: BookMarket = {
    bookmaker: EXCHANGE_BOOK,
    outcomes: [ex("home", 1.9, 1.9), ex("draw", 4, 4), ex("away", 4, 4)],
  };

  it("normalises the three midpoints to sum exactly 1", () => {
    const ref = exchangeReference(book, X2)!;
    const sum = [...ref.probs.values()].reduce((s, p) => s + p, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("reports the overround it removed", () => {
    // 1/1.9 + 1/4 + 1/4 = 1.026316
    const ref = exchangeReference(book, X2)!;
    expect(ref.overround).toBeCloseTo(1 / 1.9 + 0.25 + 0.25 - 1, 10);
    expect(ref.probs.get("home")!).toBeCloseTo(1 / 1.9 / (1 / 1.9 + 0.5), 10);
  });

  it("is null when any single outcome is illiquid", () => {
    const thin: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [ex("home", 1.9, 1.9), ex("draw", 4, 4), ex("away", 4, 4, 5)],
    };
    expect(exchangeReference(thin, X2)).toBeNull();
  });

  it("is null when an outcome is missing entirely", () => {
    const partial: BookMarket = { bookmaker: EXCHANGE_BOOK, outcomes: [ex("home", 1.9, 1.9)] };
    expect(exchangeReference(partial, X2)).toBeNull();
  });
});

describe("pinnacleReference", () => {
  it("de-vigs to probabilities summing to 1", () => {
    const book: BookMarket = {
      bookmaker: PINNACLE_BOOK,
      outcomes: [fx("home", 1.9), fx("draw", 4), fx("away", 4)],
    };
    const ref = pinnacleReference(book, X2)!;
    const sum = [...ref.probs.values()].reduce((s, p) => s + p, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(ref.probs.get("home")!).toBeCloseTo(1 / 1.9 / (1 / 1.9 + 0.5), 10);
  });

  it("agrees with the exchange when both quote the same prices", () => {
    const prices: [OddsOutcome, number][] = [["home", 1.9], ["draw", 4], ["away", 4]];
    const pin = pinnacleReference(
      { bookmaker: PINNACLE_BOOK, outcomes: prices.map(([o, p]) => fx(o, p)) },
      X2
    )!;
    const exch = exchangeReference(
      { bookmaker: EXCHANGE_BOOK, outcomes: prices.map(([o, p]) => ex(o, p, p)) },
      X2
    )!;
    for (const o of X2) expect(pin.probs.get(o)!).toBeCloseTo(exch.probs.get(o)!, 10);
  });

  it("works on a two-outcome market too", () => {
    const ref = pinnacleReference(
      { bookmaker: PINNACLE_BOOK, outcomes: [fx("over", 1.95), fx("under", 1.95)] },
      OU
    )!;
    expect(ref.probs.get("over")!).toBeCloseTo(0.5, 10);
  });
});

describe("marketReference", () => {
  const soft: BookMarket = {
    bookmaker: "bet365",
    outcomes: [fx("home", 2), fx("draw", 3.6), fx("away", 4)],
  };
  const pin: BookMarket = {
    bookmaker: PINNACLE_BOOK,
    outcomes: [fx("home", 2.05), fx("draw", 3.7), fx("away", 4.1)],
  };

  it("prefers the exchange when it is liquid", () => {
    const exch: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [ex("home", 2.1, 2.12), ex("draw", 3.75, 3.8), ex("away", 4.2, 4.3)],
    };
    const ref = marketReference([soft, pin, exch], X2)!;
    expect(ref.source).toBe("exchange");
    expect(ref.minSize).toBe(5000);
  });

  it("falls back to Pinnacle when the exchange is too thin", () => {
    const thin: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [ex("home", 2.1, 2.6, 4), ex("draw", 3.75, 4.5, 4), ex("away", 4.2, 5.5, 4)],
    };
    const ref = marketReference([soft, pin, thin], X2)!;
    expect(ref.source).toBe("pinnacle");
  });

  it("is null when neither sharp book is present", () => {
    expect(marketReference([soft], X2)).toBeNull();
  });

  // Regression: den djuplösa börsen (The Odds API) får inte tysta oense-spärren.
  // Elche–Barcelona 2026-08-18: börsen sa Elche fair ~10,5, Pinnacle ~8,2. Den
  // lösa börsreferensen måste beräknas ändå, trots att longshot-benet har bred
  // spread, annars blir disagreement null och en falsk +22 % slinker igenom.
  it("still computes disagreement against a depthless exchange with a wide longshot leg", () => {
    const exch: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      // home 10 % spread, draw 6,7 %, away 0,7 % — inget djup.
      outcomes: [nd("home", 10, 11), nd("draw", 6, 6.4), nd("away", 1.35, 1.36)],
    };
    const pinDisagree: BookMarket = {
      bookmaker: PINNACLE_BOOK,
      outcomes: [fx("home", 7.86), fx("draw", 6.17), fx("away", 1.33)],
    };
    const ref = marketReference([exch, pinDisagree], X2)!;
    // Börsen faller på 3 %-gränsen (longshot-benet), så Pinnacle blir referens.
    expect(ref.source).toBe("pinnacle");
    // …men den lösa börsen ska ändå ge en andra åsikt att jämföra mot.
    expect(ref.disagreement).not.toBeNull();
    expect(ref.disagreement!).toBeGreaterThan(0.08);
  });
});

describe("isShoppable", () => {
  it("utesluter alla börser, inte bara Betfair", () => {
    expect(isShoppable("betfair-exchange")).toBe(false);
    expect(isShoppable("matchbook")).toBe(false);
  });

  it("släpper igenom fastodds-böcker, även Betfair Sportsbook", () => {
    expect(isShoppable("betfair-sportsbook")).toBe(true);
    expect(isShoppable("svenskaspel")).toBe(true);
    expect(isShoppable("pinnacle")).toBe(true);
  });

  // Regression: matchbook är en börs och dess back-pris är inget spelbart pris.
  // Elche 10,00 hos matchbook blev "bästa pris" och en påhittad +22 % innan
  // matchbook uteslöts ur prisjakten.
  it("gör aldrig matchbook till bästa bok", () => {
    const exch: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [ex("home", 2, 2.02), ex("draw", 3.6, 3.65), ex("away", 4, 4.1)],
    };
    const matchbook: BookMarket = {
      bookmaker: "matchbook",
      outcomes: [ex("home", 9, 9.5), ex("draw", 9, 9.5), ex("away", 9, 9.5)],
    };
    const svenskaspel: BookMarket = {
      bookmaker: "svenskaspel",
      outcomes: [fx("home", 2.02), fx("draw", 3.65), fx("away", 4.05)],
    };
    const priced = priceMarket([exch, matchbook, svenskaspel], X2)!;
    for (const o of priced.outcomes) expect(o.bestBook).not.toBe("matchbook");
  });
});

describe("normalizeHandicap", () => {
  it("keeps bet365, Paddy, BetMGM and Betfair as they are stored", () => {
    for (const b of ["bet365", "paddy-power", "betmgm-uk", "betfair-exchange"]) {
      expect(normalizeHandicap(b, -3.5)).toBeCloseTo(-3.5, 10);
    }
  });

  it("inverts Pinnacle — its stored sign is the opposite", () => {
    // Uppmätt: Pinnacle lagrade Arsenal (1,167-favorit) som home +1.75 @ 1.729.
    expect(normalizeHandicap(PINNACLE_BOOK, 1.75)).toBeCloseTo(-1.75, 10);
  });

  it("is null for an unknown bookmaker rather than guessing", () => {
    expect(normalizeHandicap("betsson", -1)).toBeNull();
  });
});

describe("verifyHandicapSigns", () => {
  it("accepts the real quotes once Pinnacle is inverted", () => {
    const bad = verifyHandicapSigns([
      { bookmaker: "bet365", line: -3.5, odds: 4.25, isFavourite: true },
      { bookmaker: "betfair-exchange", line: -4, odds: 9.33, isFavourite: true },
      { bookmaker: PINNACLE_BOOK, line: 1.75, odds: 1.729, isFavourite: true },
    ]);
    expect(bad).toEqual([]);
  });

  it("flags a book whose favourite is priced long while receiving a head start", () => {
    const bad = verifyHandicapSigns([
      { bookmaker: "bet365", line: 2, odds: 3.0, isFavourite: true },
    ]);
    expect(bad).toEqual(["bet365"]);
  });

  it("flags a book whose favourite gives goals away at odds-on", () => {
    const bad = verifyHandicapSigns([
      { bookmaker: "paddy-power", line: -3, odds: 1.1, isFavourite: true },
    ]);
    expect(bad).toEqual(["paddy-power"]);
  });
});

describe("priceMarket", () => {
  const exch: BookMarket = {
    bookmaker: EXCHANGE_BOOK,
    outcomes: [ex("home", 2, 2), ex("draw", 4, 4), ex("away", 4, 4)],
  };

  it("prices fair odds off the reference and edge off the best soft price", () => {
    // Börsen ger exakt 0.5 / 0.25 / 0.25. bet365 bjuder 2.20 på hemma.
    const soft: BookMarket = {
      bookmaker: "bet365",
      outcomes: [fx("home", 2.2), fx("draw", 3.5), fx("away", 3.5)],
    };
    const priced = priceMarket([exch, soft], X2)!;
    const home = priced.outcomes.find((o) => o.outcome === "home")!;
    expect(priced.reference.source).toBe("exchange");
    expect(home.fairProb).toBeCloseTo(0.5, 10);
    expect(home.fairOdds).toBeCloseTo(2, 10);
    expect(home.bestBook).toBe("bet365");
    expect(home.edge).toBeCloseTo(2.2 * 0.5 - 1, 10); // +10 %
    expect(priced.best!.outcome).toBe("home");
  });

  it("never presents the exchange as a book to bet at", () => {
    // Uppmätt fälla: börsens back-pris på 10.50 med några kronor bakom såg ut
    // som +31 % mot Pinnacle. Börsen är referens, aldrig destination.
    const thinExchange: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [ex("home", 10.5, 14, 4), ex("draw", 6, 8, 4), ex("away", 1.2, 1.25, 4)],
    };
    const pin: BookMarket = {
      bookmaker: PINNACLE_BOOK,
      outcomes: [fx("home", 8), fx("draw", 5.5), fx("away", 1.3)],
    };
    const soft: BookMarket = {
      bookmaker: "bet365",
      outcomes: [fx("home", 7.5), fx("draw", 5.2), fx("away", 1.28)],
    };
    const priced = priceMarket([thinExchange, pin, soft], X2)!;
    expect(priced.reference.source).toBe("pinnacle"); // börsen för tunn
    for (const o of priced.outcomes) {
      expect(o.bestBook).not.toBe(EXCHANGE_BOOK);
    }
    expect(priced.outcomes.find((o) => o.outcome === "home")!.bestBook).toBe("bet365");
  });

  it("excludes the exchange from shopping even when it is liquid", () => {
    const deep: BookMarket = {
      bookmaker: EXCHANGE_BOOK,
      outcomes: [ex("home", 2.5, 2.52, 50000), ex("draw", 3.5, 3.55, 50000), ex("away", 3.4, 3.45, 50000)],
    };
    const soft: BookMarket = {
      bookmaker: "bet365",
      outcomes: [fx("home", 2.4), fx("draw", 3.4), fx("away", 3.3)],
    };
    const priced = priceMarket([deep, soft], X2)!;
    expect(priced.reference.source).toBe("exchange");
    expect(priced.outcomes.every((o) => o.bestBook !== EXCHANGE_BOOK)).toBe(true);
  });

  it("never shops the reference book against itself", () => {
    // Pinnacle är referens OCH har högst pris. Edgen ska inte mätas mot den.
    const pin: BookMarket = {
      bookmaker: PINNACLE_BOOK,
      outcomes: [fx("home", 2.6), fx("draw", 4), fx("away", 4)],
    };
    const soft: BookMarket = {
      bookmaker: "bet365",
      outcomes: [fx("home", 2.1), fx("draw", 3.5), fx("away", 3.5)],
    };
    const priced = priceMarket([pin, soft], X2)!;
    expect(priced.reference.source).toBe("pinnacle");
    const home = priced.outcomes.find((o) => o.outcome === "home")!;
    expect(home.bestBook).toBe("bet365");
    expect(home.bestOdds).toBe(2.1);
  });

  it("reports a negative edge when every book is under fair", () => {
    const soft: BookMarket = {
      bookmaker: "bet365",
      outcomes: [fx("home", 1.9), fx("draw", 3.5), fx("away", 3.5)],
    };
    const priced = priceMarket([exch, soft], X2)!;
    const home = priced.outcomes.find((o) => o.outcome === "home")!;
    expect(home.edge).toBeCloseTo(1.9 * 0.5 - 1, 10); // −5 %
    expect(priced.best!.edge).toBeLessThan(0);
  });

  it("leaves edge at zero when no book prices the outcome", () => {
    const priced = priceMarket([exch], X2)!;
    for (const o of priced.outcomes) {
      expect(o.bestOdds).toBeNull();
      expect(o.edge).toBe(0);
    }
    expect(priced.best).toBeNull();
  });

  it("is null without a sharp reference", () => {
    const soft: BookMarket = {
      bookmaker: "bet365",
      outcomes: [fx("home", 2), fx("draw", 3.5), fx("away", 3.5)],
    };
    expect(priceMarket([soft], X2)).toBeNull();
  });
});
