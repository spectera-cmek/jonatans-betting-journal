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

  it("vänder till hemmalagets perspektiv när participant1 är bortalaget", () => {
    const main = pickMainLines(extractLines(fx.odds[0], "pinnacle", map));
    const flipped = orientRows(main, false);
    const ml = main.find((r) => r.kind === "ml")!;
    const mlF = flipped.find((r) => r.kind === "ml")!;
    expect([mlF.price1, mlF.price2]).toEqual([ml.price2, ml.price1]);
    expect(flipped.find((r) => r.kind === "spread")!.line).toBe(5.5);
    expect(flipped.find((r) => r.kind === "total")).toEqual(main.find((r) => r.kind === "total"));
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
