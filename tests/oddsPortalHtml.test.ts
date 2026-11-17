import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  featuredMatch,
  formatLine,
  h2hKey,
  h2hPath,
  kickoffFromLines,
  matchTeamsFromLines,
  htmlToLines,
  meetingDate,
  parseH2hMeetings,
  teamSegmentsFromLinks,
  isBlockedHtml,
  parseBookmakerTable,
  parseLineSummary,
  parseSearchCandidates,
  tableToOddsRows,
  parseResultsRows,
} from "../lib/oddsPortal/parseHtml";
import {
  closingFromLines,
  leagueResultsPath,
  isSwapped,
  lineFromSelection,
  ouLineFromSelection,
  seasonResultsPath,
  liveBetDetail,
  swapSides,
  pickMeeting,
  pickUpcoming,
  planMarket,
  sameGame,
  searchVariants,
  type ScrapeBetInput,
} from "../lib/oddsPortal/scrape";

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
    expect(leagueResultsPath("WNBA")).toBe("/basketball/usa/wnba/results/");
    expect(leagueResultsPath("NBA")).toBe("/basketball/usa/nba/results/");
    expect(leagueResultsPath("VM 2026")).toBe("/football/world/world-championship-2026/results/");
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

describe("live-spel", () => {
  // Raderna som de står på matchsidan (Man Utd–Tottenham, okt 2026).
  const page = ["Tottenham", "1", "Saturday,", "10 Oct 2026,", "18:30", "Final result", "1:1"];

  it("avsparken ur matchsidan, i lokal tid", () => {
    const k = kickoffFromLines(page)!;
    expect([k.getFullYear(), k.getMonth(), k.getDate(), k.getHours(), k.getMinutes()]).toEqual([2026, 9, 10, 18, 30]);
    expect(kickoffFromLines(["10 Oct 2026,", "Final result"])).toBeNull();
  });

  it("lagt efter avspark är live, före (eller utan tider) är det inte", () => {
    const kickoff = kickoffFromLines(page)!;
    const at = (min: number) => new Date(kickoff.getTime() + min * 60_000);
    expect(liveBetDetail(at(35), kickoff)).toMatch(/^Live-spel \(lagt 19:05, avspark 18:30\)/);
    expect(liveBetDetail(at(-90), kickoff)).toBeNull();
    expect(liveBetDetail(at(1), kickoff)).toBeNull(); // inom marginalen
    expect(liveBetDetail(null, kickoff)).toBeNull();
    expect(liveBetDetail(at(35), null)).toBeNull();
  });
});

describe("lag i omvänd ordning", () => {
  // Raderna före datumet på matchsidan, Leeds–Arsenal 31 jan 2026.
  const page = ["Premier League 2025/2026", ">", "Leeds - Arsenal", "Leeds", "0", "-", "Arsenal", "4", "Saturday,", "31 Jan 2026,", "17:00"];

  it("hemma- och bortalag ur matchsidans rubrik", () => {
    expect(matchTeamsFromLines(page)).toEqual({ home: "Leeds", away: "Arsenal" });
    expect(matchTeamsFromLines(["Arsenal", "1"])).toBeNull();
  });

  it("vänder bara när lagen tydligt står omvänt", () => {
    const teams = matchTeamsFromLines(page);
    expect(isSwapped(input({ homeTeam: "Arsenal", awayTeam: "Leeds United" }), teams)).toBe(true);
    expect(isSwapped(input({ homeTeam: "Leeds", awayTeam: "Arsenal" }), teams)).toBe(false);
    expect(isSwapped(input({ homeTeam: "Arsenal", awayTeam: "Everton" }), teams)).toBe(false);
    expect(isSwapped(input({ homeTeam: "Arsenal", awayTeam: "Leeds" }), null)).toBe(false);
  });

  it("det vända betet gäller samma lag och samma handikapp", () => {
    const bet = input({ homeTeam: "Arsenal", awayTeam: "Leeds", market: "spreads", selection: "Arsenal -1.0", selectionSide: "home", line: -1 });
    const turned = swapSides(bet);
    expect(turned).toMatchObject({ homeTeam: "Leeds", awayTeam: "Arsenal", selectionSide: "away", line: -1 });
    // Arsenal −1 borta = Leeds +1 sett från hemmalaget, som OddsPortal anger det.
    expect(planMarket(turned)).toMatchObject({ ok: true, kind: "ah", column: "away", lineLabel: "Asian Handicap +1" });
    expect(swapSides(input({ selectionSide: "over" })).selectionSide).toBe("over");
  });
});

describe("esport", () => {
  const es = (o: Partial<ScrapeBetInput>) => input({ sport: "Esports", league: "CS2", homeTeam: "Vitality", awayTeam: "NaVi", ...o });

  it("bara matchvinnare — kart-handikapp och totaler finns inte på OddsPortal", () => {
    expect(planMarket(es({ market: "h2h", selection: "Vitality", selectionSide: "home" }))).toMatchObject({ ok: true, kind: "1x2", tabs: expect.arrayContaining(["Home/Away"]) });
    expect(planMarket(es({ market: "spreads", selection: "NaVi +1.5", selectionSide: "away", line: 1.5 }))).toMatchObject({ ok: false });
    expect(planMarket(es({ market: "totals", selection: "Over 2.5 maps", selectionSide: "over", line: 2.5 }))).toMatchObject({ ok: false });
  });

  it("lagpar bara inom samma spel", () => {
    expect(sameGame("team-vitality-counter-strike-tMJZDVwo", "natus-vincere-counter-strike-AH1VkXGn")).toBe(true);
    expect(sameGame("team-vitality-league-of-legends-aaaaaaaa", "natus-vincere-counter-strike-AH1VkXGn")).toBe(false);
    expect(sameGame("arsenal-hA1Zm19f", "leeds-tUxUbLR2")).toBe(true);
  });

  it("förkortningen söks med OddsPortals namn", () => {
    expect(searchVariants("NaVi")[0]).toBe("natus vincere");
    expect(searchVariants("Ipswich Town")[0]).toBe("Ipswich Town");
  });
});

describe("BTTS och handikapp utan linje", () => {
  it("BTTS: Ja = första kolumnen, Nej = andra, på fliken Both Teams to Score", () => {
    const btts = (selection: string) => planMarket(input({ market: "other", marketCategory: "BTTS", selection }));
    expect(btts("Ja")).toMatchObject({ ok: true, kind: "1x2", column: "home", tabs: expect.arrayContaining(["Both Teams to Score"]) });
    expect(btts("Nej")).toMatchObject({ ok: true, column: "away" });
  });

  it("linjen ur valet när fältet saknar den", () => {
    expect(lineFromSelection("Arsenal -1.5")).toBe(-1.5);
    expect(lineFromSelection("Leeds +0,25")).toBe(0.25);
    expect(lineFromSelection("Arsenal")).toBeNull();
    expect(lineFromSelection("Barcelona (-1)")).toBe(-1);
    expect(lineFromSelection("Over 2.5")).toBeNull();
    expect(planMarket(input({ market: "spreads", selection: "Everton +1.5", selectionSide: "away", line: null }))).toMatchObject({ ok: true, kind: "ah", lineLabel: "Asian Handicap -1.5" });
  });
});

describe("vilket möte bettet gäller", () => {
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const meetings = [
    { eventId: "aug", d: day("2025-08-23") },
    { eventId: "jun15", d: day("2026-06-15") },
    { eventId: "jul", d: day("2026-07-20") },
  ];
  const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h);

  it("närmast bettets datum, inom två dygn", () => {
    expect(pickMeeting(meetings, local(2026, 6, 14, 21), null)).toBe("jun15");
  });
  it("bara datum (läggningsdagen): första mötet efter läggningen, inom tre veckor", () => {
    expect(pickMeeting(meetings, local(2026, 5, 30), local(2026, 5, 30, 14))).toBe("jun15");
    expect(pickMeeting(meetings, local(2026, 5, 1), local(2026, 5, 1, 14))).toBeNull();
  });
  it("med klockslag gissas inget: fel datum ska synas, inte ge en annan match", () => {
    expect(pickMeeting(meetings, local(2026, 5, 30, 20), local(2026, 5, 30, 14))).toBeNull();
  });
});

describe("över/under utan sparad linje", () => {
  it("linjen ur valet", () => {
    expect(ouLineFromSelection("Över 2.5")).toBe(2.5);
    expect(ouLineFromSelection("Under 3,5 mål")).toBe(3.5);
    expect(ouLineFromSelection("Antal mål: Över 2.5")).toBe(2.5);
    expect(ouLineFromSelection("Arsenal")).toBeNull();
  });
  it("utan linje alls tas ingen rad — sidans första linje vore fel", () => {
    expect(planMarket(input({ market: "totals", selection: "Över", selectionSide: "over", line: null }))).toMatchObject({ ok: false });
    expect(planMarket(input({ market: "totals", selection: "Över 2.5", selectionSide: "over", line: null }))).toMatchObject({ ok: true, line: 2.5, lineLabel: "Over/Under +2.5" });
  });
});

describe("ligans resultatarkiv", () => {
  it("rader med datumrubriken de står under, en per match", () => {
    const html = `
      <div class="x">Today, 25 Oct</div>
      <div class="h"><div>19 Oct 2026</div></div>
      <a href="/football/h2h/degerfors-zNSwBuue/kalmar-rkrUu5ae/#4l9GpcXN">Degerfors</a>
      <a href="/football/h2h/degerfors-zNSwBuue/kalmar-rkrUu5ae/#4l9GpcXN">igen</a>
      <div class="h"><div>18 Oct 2026</div></div>
      <a href="/football/h2h/aik-lzqk4S68/malmo-ff-tYNTdpar/#AbCdEf12">AIK</a>
      <a href="/hockey/h2h/a-12345678/b-12345678/#ZZZZZZZZ">annan sport</a>`;
    const rows = parseResultsRows(html, "football", new Date("2026-10-25T10:00:00Z"));
    expect(rows.map((r) => [r.eventId, r.date.toISOString().slice(0, 10)])).toEqual([
      ["4l9GpcXN", "2026-10-19"],
      ["AbCdEf12", "2026-10-18"],
    ]);
    expect(rows[1].segments).toEqual(["aik-lzqk4S68", "malmo-ff-tYNTdpar"]);
  });

  it("säsongens sida: innevarande utan år, tidigare med", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect(seasonResultsPath("/football/sweden/allsvenskan/", new Date("2026-04-27T12:00:00Z"), now)).toBe("/football/sweden/allsvenskan/results/");
    expect(seasonResultsPath("/football/sweden/allsvenskan/", new Date("2025-09-01T12:00:00Z"), now)).toBe("/football/sweden/allsvenskan-2025/results/");
    expect(seasonResultsPath("/football/england/premier-league/", new Date("2026-03-11T12:00:00Z"), now)).toBe("/football/england/premier-league-2025-2026/results/");
    expect(seasonResultsPath("/football/england/premier-league/", new Date("2026-08-22T12:00:00Z"), now)).toBe("/football/england/premier-league/results/");
    expect(seasonResultsPath("/basketball/usa/nba/", new Date("2026-06-06T12:00:00Z"), now)).toBe("/basketball/usa/nba-2025-2026/results/");
    expect(seasonResultsPath("/football/world/world-championship-2026/", new Date("2026-06-21T12:00:00Z"), now)).toBe("/football/world/world-championship-2026/results/");
  });
});
