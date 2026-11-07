import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { buildUrl, normalizeList, type OpFixtureOdds, type OpHistoricalOdds, type OpMarket } from "../lib/oddspapi";
import { buildMarketMap, classifyBasketballMarket, closingFromHistory, extractLines, orientRows, pickMainLines } from "../lib/oddspapi/markets";
import { nickname } from "../lib/nba/oddspapiCapture";

const fx = JSON.parse(fs.readFileSync("tests/fixtures/oddspapi-nba.json", "utf8")) as {
  markets: OpMarket[];
  odds: OpFixtureOdds[];
  history: OpHistoricalOdds;
};

describe("OddsPapi-klienten", () => {
  it("lägger nyckeln som apiKey i URL:en", () => {
    const u = new URL(buildUrl("/odds-by-tournaments", { tournamentIds: "132", bookmaker: "pinnacle", x: undefined }, "SECRET"));
    expect(u.pathname).toBe("/v4/odds-by-tournaments");
    expect(u.searchParams.get("apiKey")).toBe("SECRET");
    expect(u.searchParams.has("x")).toBe(false);
  });

  it("tar emot lista, enskilt objekt eller map", () => {
    const one = fx.odds[0];
    expect(normalizeList([one])).toHaveLength(1);
    expect(normalizeList(one)).toHaveLength(1);
    expect(normalizeList({ a: one })).toHaveLength(1);
    expect(normalizeList(null)).toHaveLength(0);
  });
});

describe("marknadskatalogen", () => {
  const map = buildMarketMap(fx.markets);

  it("klassar moneyline, spread och total för hela matchen", () => {
    expect(map["111"]?.kind).toBe("ml");
    expect(map["1170"]).toMatchObject({ kind: "spread", line: -5.5 });
    expect(map["1180"]).toMatchObject({ kind: "total", line: 224.5 });
    expect(map["1180"].sides).toEqual({ "1180": 1, "1181": 2 });
  });

  it("sorterar bort perioder, lagtotaler, props och fotboll", () => {
    expect(map["2001"]).toBeUndefined(); // 1st half
    expect(map["2002"]).toBeUndefined(); // team total
    expect(map["2003"]).toBeUndefined(); // player prop
    expect(map["101"]).toBeUndefined(); // fotboll 1X2
    expect(classifyBasketballMarket({ ...fx.markets[0], outcomes: fx.markets[0].outcomes.slice(0, 1) })).toBeNull();
  });
});

describe("OddsPapis riktiga basketkatalog (oddspapi:discover 2026-11-02)", () => {
  const real = (marketId: number, marketName: string, marketType: string, period: string, handicap: number, outs: Array<[number, string]>): OpMarket => ({
    marketId,
    marketName,
    marketType,
    period,
    handicap,
    playerProp: false,
    sportId: 11,
    outcomes: outs.map(([outcomeId, outcomeName]) => ({ outcomeId, outcomeName })),
  });

  it("111 Winner (incl. overtime) är moneyline, inte spread — även med utfallen i ordningen 2/1", () => {
    const spec = classifyBasketballMarket(real(111, "Winner (incl. overtime)", "moneyline", "result", 0, [[112, "2"], [111, "1"]]));
    expect(spec).toMatchObject({ kind: "ml", line: null });
    expect(spec!.sides).toEqual({ "111": 1, "112": 2 });
  });

  it("Handicap och Over Under (incl. overtime), men inte Regular Time Result", () => {
    expect(classifyBasketballMarket(real(11358, "Handicap (incl. overtime)", "handicap", "result", -24.5, [[11358, "1"], [11359, "2"]]))).toMatchObject({ kind: "spread", line: -24.5 });
    expect(classifyBasketballMarket(real(116, "Over Under (incl. overtime)", "totals", "result", 100.5, [[117, "Under"], [116, "Over"]]))).toMatchObject({
      kind: "total",
      line: 100.5,
      sides: { "116": 1, "117": 2 },
    });
    expect(classifyBasketballMarket(real(113, "Regular Time Result", "1x2", "fulltime", 0, [[113, "X"], [114, "1"], [115, "2"]]))).toBeNull();
  });
});

describe("odds-svar", () => {
  const map = buildMarketMap(fx.markets);

  it("plockar ut linjer och huvudlinjen per marknad", () => {
    const rows = extractLines(fx.odds[0], "pinnacle", map);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const main = pickMainLines(rows);
    expect(main.map((r) => r.kind).sort()).toEqual(["ml", "spread", "total"]);
    const spread = main.find((r) => r.kind === "spread")!;
    expect(spread.line).toBe(-5.5);
    expect(spread.price1).toBe(1.952);
  });

  it("ingen huvudlinje när hela stegen har lika jämna priser", () => {
    const row = (line: number) => ({ kind: "spread" as const, line, price1: 1.9, price2: 1.9, mainLine: false });
    const ml = { kind: "ml" as const, line: null, price1: 1.5, price2: 2.6, mainLine: false };
    const out = pickMainLines([row(-7.5), row(-3.5), row(12), ml] as Parameters<typeof pickMainLines>[0]);
    expect(out.map((r) => r.kind)).toEqual(["ml"]);
  });

  it("vänder till hemmalagets perspektiv när participant1 är bortalaget", () => {
    const main = pickMainLines(extractLines(fx.odds[0], "pinnacle", map));
    const flipped = orientRows(main, false);
    const ml = main.find((r) => r.kind === "ml")!;
    const mlF = flipped.find((r) => r.kind === "ml")!;
    expect([mlF.price1, mlF.price2]).toEqual([ml.price2, ml.price1]);
    expect(flipped.find((r) => r.kind === "spread")!.line).toBe(5.5);
    expect(flipped.find((r) => r.kind === "total")).toEqual(main.find((r) => r.kind === "total"));
  });

  it("lagtotaler med samma namn som matchens total (113,5) väljs aldrig", () => {
    const markets = {
      ...map,
      "1238": { kind: "total" as const, line: 113.5, sides: { "1238": 1 as const, "1239": 2 as const } },
    };
    const fx2 = JSON.parse(JSON.stringify(fx.odds[0]));
    // Pinnacles lagtotal, markerad som huvudlinje och jämnare än matchens total.
    fx2.bookmakerOdds.pinnacle.markets["1238"] = {
      outcomes: {
        "1238": { players: { "0": { price: 1.95, mainLine: true } } },
        "1239": { players: { "0": { price: 1.95, mainLine: true } } },
      },
    };
    const total = pickMainLines(extractLines(fx2, "pinnacle", markets)).find((r) => r.kind === "total")!;
    expect(total.line).toBe(224.5);
  });

  it("stängning ur historiken = senaste priset före start", () => {
    const rows = closingFromHistory(fx.history, "pinnacle", map, new Date("2026-03-01T00:30:00Z"));
    const ml = rows.find((r) => r.kind === "ml")!;
    expect(ml.price1).toBe(1.55); // 1.60 kom efter start och räknas inte
    expect(ml.price2).toBe(2.55);
  });

  it("lagnamn matchas på smeknamn", () => {
    expect(nickname("Portland Trail Blazers")).toBe("blazers");
    expect(nickname("LA Clippers")).toBe(nickname("Los Angeles Clippers"));
  });
});

describe("OddsPapi-fel", () => {
  it("skriver ut fel-objekt läsbart i stället för [object Object]", async () => {
    const { oddspapiGet, OddspapiError } = await import("../lib/oddspapi");
    const prevKey = process.env.ODDSPAPI_KEY;
    const prevFetch = globalThis.fetch;
    process.env.ODDSPAPI_KEY = "test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "COOLDOWN", message: "Wait 1000ms between requests" } }), { status: 429 })) as typeof fetch;
    try {
      await expect(oddspapiGet("/tournaments", { sportId: 10 })).rejects.toSatisfy((e: unknown) => {
        if (!(e instanceof OddspapiError)) return false;
        return e.code === "COOLDOWN" && e.statusCode === 429 && e.message.includes("Wait 1000ms") && !e.message.includes("[object Object]");
      });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.ODDSPAPI_KEY;
      else process.env.ODDSPAPI_KEY = prevKey;
    }
  });
});
