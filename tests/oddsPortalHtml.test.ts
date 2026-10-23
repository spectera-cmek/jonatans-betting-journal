import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  featuredMatch,
  formatLine,
  h2hKey,
  h2hPath,
  htmlToLines,
  meetingDate,
  parseH2hMeetings,
  teamSegmentsFromLinks,
  isBlockedHtml,
  parseBookmakerTable,
  parseLineSummary,
  parseSearchCandidates,
  tableToOddsRows,
} from "../lib/oddsPortal/parseHtml";
import { closingFromLines, leagueResultsPath, pickUpcoming, planMarket, searchVariants } from "../lib/oddsPortal/scraplingScrape";
import { pickSearchCandidate, type ScrapeBetInput } from "../lib/oddsPortal/scrape";

// Fångade via Scrapling från oddsportal.com i oktober 2026 (amerikansk IP,
// därav bet365.us/DraftKings). Arsenal–Everton, 24 okt 2026.
const FIX = path.join(__dirname, "fixtures", "oddsportal");
const lines = (f: string): string[] => JSON.parse(readFileSync(path.join(FIX, `${f}.lines.json`), "utf8"));
const URL = "https://www.oddsportal.com/football/h2h/arsenal-hA1Zm19f/everton-KluSTr9s/#G0XLh1up";

function input(over: Partial<ScrapeBetInput> = {}): ScrapeBetInput {
  return {
    sport: "Football",
    league: "Premier League",
    event: "Arsenal vs Everton",
    homeTeam: "Arsenal",
    awayTeam: "Everton",
    eventAt: new Date("2026-10-24T13:00:00Z"),
    market: "h2h",
    selection: "Arsenal",
    selectionSide: "home",
    line: null,
    bookmaker: "DraftKings",
    ...over,
  };
}

function plan(i: ScrapeBetInput) {
  const p = planMarket(i);
  if (!p.ok) throw new Error(p.detail);
  return p;
}

describe("htmlToLines", () => {
  it("en rad per textnod, utan script/style/svg, entiteter avkodade", () => {
    const html = `<div><span>Over/Under +2.5</span><script>var x = "1.50";</script><svg><text>9.99</text></svg>
      <p>Arsenal &amp; Everton</p><p>&nbsp;</p><!-- 3.33 --><b>1.85</b></div>`;
    expect(htmlToLines(html)).toEqual(["Over/Under +2.5", "Arsenal & Everton", "1.85"]);
  });
  it("känner igen Cloudflares mellansida", () => {
    expect(isBlockedHtml("<title>Just a moment...</title><p>cloudflare</p>")).toBe(true);
    expect(isBlockedHtml("<title>Arsenal - Everton Odds</title>")).toBe(false);
  });
});

describe("parseBookmakerTable", () => {
  it("1X2: bolag med tre odds, bonustexten hoppas över", () => {
    const t = parseBookmakerTable(lines("match-1x2"))!;
    expect(t.columns).toEqual(["1", "X", "2"]);
    expect(t.hasLine).toBe(false);
    expect(t.rows).toEqual([
      { bookmaker: "bet365.us", line: null, values: [1.36, 5, 8] },
      { bookmaker: "BetMGM.us", line: null, values: [1.43, 4.6, 7.25] },
      { bookmaker: "DraftKings", line: null, values: [1.45, 4.4, 7.5] },
      { bookmaker: "Fanduel", line: null, values: [1.38, 4.4, 8] },
    ]);
    expect(tableToOddsRows(t)[0]).toMatchObject({ bookmaker: "bet365.us", home: 1.36, draw: 5, away: 8 });
  });

  it("utfälld O/U-linje: linjen i första kolumnen, saknad payout avslutar raden", () => {
    const t = parseBookmakerTable(lines("match-ou-line"))!;
    expect(t.columns).toEqual(["Over", "Under"]);
    expect(t.hasLine).toBe(true);
    expect(t.rows.map((r) => [r.bookmaker, r.line, ...r.values])).toEqual([
      ["bet365.us", 2.5, 1.85, 2],
      ["BetMGM.us", 2.5, 1.77, 1.93],
      ["DraftKings", 2.5, 1.76, 2],
    ]);
    expect(tableToOddsRows(t)[2]).toMatchObject({ over: 1.76, under: 2 });
  });

  it("ingen tabell när ingen linje är utfälld", () => {
    expect(parseBookmakerTable(lines("match-ah"))).toBeNull();
  });

  it("ett saknat odds mitt i raden blir NaN, inte nästa bolags odds", () => {
    const t = parseBookmakerTable(["Bookmakers", "1", "X", "2", "Payout", "A", "1.50", "-", "6.00", "95%", "B", "1.55", "4.00", "6.10", "96%", "My coupon"])!;
    expect(t.rows[0].values[1]).toBeNaN();
    expect(t.rows[1]).toEqual({ bookmaker: "B", line: null, values: [1.55, 4, 6.1] });
    expect(tableToOddsRows(t)[0]).toMatchObject({ home: 1.5, draw: undefined, away: 6 });
  });
});

describe("parseLineSummary", () => {
  it("O/U: snittodds per linje, kortformen och antalet bolag hoppas över", () => {
    const s = parseLineSummary(lines("match-ou-line"), "Over/Under");
    expect(s.find((x) => x.line === 2.5)).toEqual({ line: 2.5, first: 1.85, second: 2 });
    expect(s.find((x) => x.line === 0.5)).toEqual({ line: 0.5, first: 1.04, second: 12 });
  });
  it("AH: negativa, noll och positiva linjer", () => {
    const s = parseLineSummary(lines("match-ah"), "Asian Handicap");
    expect(s[0]).toEqual({ line: -3.5, first: 8, second: 1.1 });
    expect(s.map((x) => x.line)).toContain(0);
    expect(s.map((x) => x.line)).toContain(0.5);
  });
  it("formatLine som på sidan", () => {
    expect(formatLine(2.5, true)).toBe("+2.5");
    expect(formatLine(-1.5, true)).toBe("-1.5");
    expect(formatLine(0, true)).toBe("0");
    expect(formatLine(2, false)).toBe("2");
  });
});

describe("sökträffar", () => {
  it("matchsidor inom sporten, med radens text", () => {
    const html = readFileSync(path.join(FIX, "search.html"), "utf8");
    const c = parseSearchCandidates(html, "football");
    expect(c).toHaveLength(6); // länken till /football/ och den externa räknas inte
    expect(c[2].href).toBe(URL);
    expect(c[2].title).toMatch(/Arsenal/);
    expect(c[2].title).toMatch(/Everton/);
    expect(parseSearchCandidates(html, "basketball")).toEqual([]);
  });
  it("samma urval som Playwright-vägen", () => {
    const html = readFileSync(path.join(FIX, "search.html"), "utf8");
    const r = pickSearchCandidate(parseSearchCandidates(html, "football"), input(), "Arsenal Everton", "football");
    expect(r).toMatchObject({ ok: true, url: URL });
  });
});

describe("planMarket", () => {
  it("1X2, O/U och AH", () => {
    expect(planMarket(input())).toMatchObject({ ok: true, kind: "1x2", column: "home" });
    expect(planMarket(input({ market: "totals", selectionSide: "over", line: 2.5, selection: "Över 2.5" }))).toMatchObject({
      ok: true,
      kind: "ou",
      lineLabel: "Over/Under +2.5",
      line: 2.5,
    });
    // Borta +1.5 är hemma -1.5 på OddsPortal.
    expect(planMarket(input({ market: "spreads", selectionSide: "away", line: 1.5, selection: "Everton +1.5" }))).toMatchObject({
      ok: true,
      kind: "ah",
      lineLabel: "Asian Handicap -1.5",
      line: -1.5,
      column: "away",
    });
  });
  it("props, hörnor och kort tas inte", () => {
    expect(planMarket(input({ market: "other", marketCategory: "Skott", selection: "Saka över 2.5 skott" }))).toMatchObject({ ok: false });
    expect(
      planMarket(input({ market: "totals", marketCategory: "Hörnor", selectionSide: "over", line: 9.5, selection: "Över 9.5 hörnor" }))
    ).toMatchObject({ ok: false, detail: /Hörnor/ });
    expect(
      planMarket(input({ market: "totals", marketScope: "team", selectionSide: "over", line: 1.5, selection: "Arsenal över 1.5" }))
    ).toMatchObject({ ok: false, detail: /Lagtotaler/ });
  });
});

describe("closingFromLines", () => {
  it("1X2: bettets bolag först", () => {
    const i = input({ eventAt: new Date("2020-01-01") });
    const r = closingFromLines(lines("match-1x2"), plan(i), i, URL);
    expect(r).toMatchObject({ ok: true, closingOdds: 1.45, bookmakerUsed: "DraftKings", provisional: false });
  });
  it("O/U: bolagets odds för just linjen", () => {
    const i = input({ market: "totals", selectionSide: "under", line: 2.5, selection: "Under 2.5", bookmaker: "BetMGM" });
    const r = closingFromLines(lines("match-ou-line"), plan(i), i, URL);
    expect(r).toMatchObject({ ok: true, closingOdds: 1.93, bookmakerUsed: "BetMGM.us" });
  });
  it("O/U utan utfälld linje: OddsPortals snitt, bara exakt linje", () => {
    const i = input({ market: "totals", selectionSide: "over", line: 1.5, selection: "Över 1.5" });
    const summaryOnly = lines("match-ou-line").filter((_, idx, all) => idx < all.indexOf("Bookmakers"));
    expect(closingFromLines(summaryOnly, plan(i), i, URL)).toMatchObject({ ok: true, closingOdds: 1.29, bookmakerUsed: "OddsPortal avg" });
    const odd = input({ market: "totals", selectionSide: "over", line: 2.4, selection: "Över 2.4" });
    expect(closingFromLines(summaryOnly, plan(odd), odd, URL)).toMatchObject({ ok: false, code: "odds_not_found" });
  });
  it("AH utan bolagstabell: inget utfall hellre än fel linje", () => {
    const i = input({ market: "spreads", selectionSide: "home", line: -1.5, selection: "Arsenal -1.5" });
    expect(closingFromLines(lines("match-ah"), plan(i), i, URL)).toMatchObject({ ok: false, code: "odds_not_found" });
  });
});

describe("spelade matcher via h2h-sidan", () => {
  const html = (f: string) => readFileSync(path.join(FIX, f), "utf8");

  it("lagens id-delar ur sökträffarna, vanligast först", () => {
    const segs = teamSegmentsFromLinks(html("search-arsenal-links.html"), "football");
    const arsenal = segs.filter((s) => s.name === "arsenal");
    // Herrlaget står i fyra länkar, damlaget i en.
    expect(arsenal.map((s) => [s.segment, s.count])).toEqual([
      ["arsenal-hA1Zm19f", 4],
      ["arsenal-8CKOoQdn", 1],
    ]);
    expect(segs.find((s) => s.segment === "fleetwood-town-tCZ3D68d")?.name).toBe("fleetwood town");
    expect(teamSegmentsFromLinks(html("search-arsenal-links.html"), "basketball")).toEqual([]);
  });

  it("h2h-sökvägen sorterar lagen som OddsPortal", () => {
    expect(h2hPath("football", "leeds-tUxUbLR2", "arsenal-hA1Zm19f")).toBe("/football/h2h/arsenal-hA1Zm19f/leeds-tUxUbLR2/");
  });

  it("mötena på h2h-sidan, ett per eventId, utan språklänkar", () => {
    const m = parseH2hMeetings(html("h2h-arsenal-leeds.html"), "/football/h2h/arsenal-hA1Zm19f/leeds-tUxUbLR2/");
    expect(m.map((x) => [x.eventId, x.dateText])).toEqual([
      ["xtmHKGT0", "10/Oct"],
      ["Sp1AidqQ", "31/Jan"],
      ["zFCHVyGF", "23/Aug"],
    ]);
  });

  it("möteslänkar matchas på lagens id, inte namnet eller språkprefixet", () => {
    const page = `
      <a href="/football/h2h/manchester-utd-ppjDR086/tottenham-UDg08Ohm/#hQ2NzTJb">23/May/2027Manchester Utd-Tottenham</a>
      <a href="/pl/football/h2h/manchester-utd-ppjDR086/tottenham-UDg08Ohm/#aB3dE5gH">05/Jan/2027Manchester Utd-Tottenham</a>
      <a href="/football/h2h/coventry-GOvB22xg/tottenham-UDg08Ohm/#0zSjbNHM">01/Feb/2027Coventry-Tottenham</a>`;
    const m = parseH2hMeetings(page, h2hPath("football", "manchester-united-ppjDR086", "tottenham-UDg08Ohm"));
    expect(m.map((x) => x.eventId)).toEqual(["hQ2NzTJb", "aB3dE5gH"]);
    expect(h2hKey("/pl/football/h2h/b-12345678/a-ABCDEFGH/")).toBe("football/12345678/ABCDEFGH");
  });

  it("matchen överst på h2h-sidan: id ur adressen, datum ur rubriken", () => {
    const f = featuredMatch(["Premier League", "23 May 2027,", "16:00"], "https://www.oddsportal.com/football/h2h/a/b/#O43pe4no:1X2;2");
    expect(f?.eventId).toBe("O43pe4no");
    expect(f?.date.toISOString().slice(0, 10)).toBe("2027-05-23");
    expect(featuredMatch(["23 May 2027,"], "https://www.oddsportal.com/football/h2h/a/b/")).toBeNull();
  });

  it("datum utan år: året närmast bettet", () => {
    expect(meetingDate("10/Oct", new Date("2026-10-11T00:00:00Z"))?.toISOString().slice(0, 10)).toBe("2026-10-10");
    // Bet i januari, möte i december: förra året, inte samma.
    expect(meetingDate("30/Dec", new Date("2027-01-02T00:00:00Z"))?.toISOString().slice(0, 10)).toBe("2026-12-30");
    expect(meetingDate("31/Jan/2025", new Date("2026-10-11T00:00:00Z"))?.toISOString().slice(0, 10)).toBe("2025-01-31");
    expect(meetingDate("Today", new Date())).toBeNull();
  });

  it("kommande match kräver båda lagen — en träff på bara ena laget väljs inte", () => {
    const c = [
      { href: "https://www.oddsportal.com/football/h2h/arsenal-hA1Zm19f/everton-KluSTr9s/#G0XLh1up", title: "24/OctArsenal-Everton", dateText: "24/Oct Arsenal - Everton" },
    ];
    const i = (o: Partial<ScrapeBetInput>) => input({ homeTeam: "Arsenal", awayTeam: "Leeds", eventAt: new Date("2026-10-24T13:00:00Z"), ...o });
    expect(pickUpcoming(c, i({}))).toBeNull();
    expect(pickUpcoming(c, i({ awayTeam: "Everton" }))).toBe(c[0].href);
    // Rätt lag men fel datum (en annan omgång) väljs inte heller.
    expect(pickUpcoming(c, i({ awayTeam: "Everton", eventAt: new Date("2026-12-01T13:00:00Z") }))).toBeNull();
  });
});

describe("vägar till en spelad match", () => {
  it("ligans resultatsida ur bettets liga", () => {
    expect(leagueResultsPath("Premier League")).toBe("/football/england/premier-league/results/");
    expect(leagueResultsPath("Spain - LaLiga")).toBe("/football/spain/laliga/results/");
    expect(leagueResultsPath("UFC")).toBeNull();
    expect(leagueResultsPath(null)).toBeNull();
  });

  it("sökvarianter för kortare namn, längst först", () => {
    expect(searchVariants("Ipswich Town")).toEqual(["Ipswich Town", "Ipswich"]);
    expect(searchVariants("West Bromwich Albion")[0]).toBe("West Bromwich Albion");
    expect(searchVariants("West Bromwich Albion")).toContain("West Brom");
    // Varianter under fyra tecken söks inte — de träffar för brett.
    expect(searchVariants("Man Utd").every((v) => v.length >= 4)).toBe(true);
  });
});
