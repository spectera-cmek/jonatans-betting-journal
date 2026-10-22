import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROP_STAT_CHECKS,
  classifyPropBet,
  dataNeeded,
  findEventForBet,
  findPlayer,
  gradeProp,
  teamsOf,
  type MatchData,
  type PropBet,
} from "../lib/propsGrading";
import { parseEvents, parseLineups, parseStatistics } from "../lib/sofascore/parse";

const FIX = path.join(__dirname, "fixtures", "sofascore");
const load = (f: string) => JSON.parse(readFileSync(path.join(FIX, f), "utf8"));

const events = parseEvents(load("football-events.json")).events;
const mffAik = events.find((e) => e.id === 13981234)!;
const footballData: MatchData = {
  event: mffAik,
  stats: parseStatistics(load("football-statistics.json")),
  lineups: parseLineups(load("football-lineups.json")),
};

function bet(over: Partial<PropBet> = {}): PropBet {
  return {
    id: "b1",
    sport: "Football",
    event: "Malmö FF vs AIK",
    homeTeam: "Malmö FF",
    awayTeam: "AIK",
    eventAt: new Date("2025-10-18T19:00:00Z"),
    market: "other",
    marketCategory: "Hörnor",
    marketScope: "match",
    selection: "Över 10.5 hörnor",
    selectionSide: "over",
    line: 10.5,
    betType: "single",
    eventKind: "match",
    ...over,
  };
}

function grade(b: PropBet, data: MatchData = footballData) {
  const c = classifyPropBet(b);
  if (!c.ok) return { classified: c.reason };
  return gradeProp(b, c.need, data);
}

describe("classifyPropBet", () => {
  it("hoppar över det som inte ska rättas automatiskt", () => {
    expect(classifyPropBet(bet({ betType: "betbuilder" }))).toMatchObject({ ok: false, reason: /kombination/ });
    expect(classifyPropBet(bet({ sport: "Tennis" }))).toMatchObject({ ok: false, reason: /hämtas inte/ });
    expect(classifyPropBet(bet({ market: "h2h" }))).toMatchObject({ ok: false, reason: /ESPN/ });
    expect(classifyPropBet(bet({ marketCategory: "Kort & fouls" }))).toMatchObject({ ok: false, reason: /kort/ });
    expect(classifyPropBet(bet({ selectionSide: null }))).toMatchObject({ ok: false, reason: /över\/under/ });
    expect(classifyPropBet(bet({ line: 2.25 }))).toMatchObject({ ok: false, reason: /kvartslinje/ });
    expect(classifyPropBet(bet({ marketCategory: "Dubbelchans" }))).toMatchObject({ ok: false, reason: /ingen mappning/ });
    expect(classifyPropBet(bet({ sport: "Ice Hockey", marketCategory: "Mål", marketScope: "match" }))).toMatchObject({
      ok: false,
      reason: /bara spelare/,
    });
  });

  it("vet vilken data som behövs", () => {
    const need = (b: PropBet) => {
      const c = classifyPropBet(b);
      if (!c.ok) throw new Error(c.reason);
      return dataNeeded(c.need);
    };
    expect(need(bet())).toEqual({ stats: true, lineups: false });
    expect(need(bet({ marketScope: "player", marketCategory: "Skott" }))).toEqual({ stats: false, lineups: true });
    expect(need(bet({ marketCategory: "BTTS", selection: "Ja", selectionSide: null, line: null }))).toEqual({ stats: false, lineups: false });
    expect(need(bet({ marketCategory: "Totalt" }))).toEqual({ stats: false, lineups: false });
  });

  it("varje spelarkategori har nycklar att kontrollera", () => {
    expect(PROP_STAT_CHECKS.length).toBeGreaterThan(10);
    expect(PROP_STAT_CHECKS.every((c) => c.keys.length > 0)).toBe(true);
  });
});

describe("findEventForBet", () => {
  it("matchar på lagnamn och tid", () => {
    expect(findEventForBet(bet(), events)?.id).toBe(13981234);
  });
  it("datum utan klockslag fungerar (bredare fönster)", () => {
    expect(findEventForBet(bet({ eventAt: new Date("2025-10-18T00:00:00+02:00") }), events)?.id).toBe(13981234);
  });
  it("lagnamn ur event-texten när home/away saknas", () => {
    expect(teamsOf({ event: "Malmö FF - AIK", homeTeam: null, awayTeam: null })).toEqual({ home: "Malmö FF", away: "AIK" });
    expect(findEventForBet(bet({ homeTeam: null, awayTeam: null }), events)?.id).toBe(13981234);
  });
  it("fel lag ger ingen träff", () => {
    expect(findEventForBet(bet({ homeTeam: "IFK Göteborg", awayTeam: "Häcken" }), events)).toBeNull();
  });
});

describe("gradeProp — fotboll", () => {
  it("matchtotal hörnor ur lagstatistiken", () => {
    // 7 + 4 = 11
    expect(grade(bet())).toMatchObject({ ok: true, outcome: "win", value: 11 });
    expect(grade(bet({ selectionSide: "under" }))).toMatchObject({ ok: true, outcome: "loss" });
    expect(grade(bet({ line: 11 }))).toMatchObject({ ok: true, outcome: "push" });
  });

  it("lagtotal: laget läses ur selection", () => {
    const r = grade(bet({ marketScope: "team", selection: "AIK över 4.5 hörnor", line: 4.5 }));
    expect(r).toMatchObject({ ok: true, outcome: "loss", value: 4 });
    expect((r as { reason: string }).reason).toMatch(/AIK 4/);
    expect(grade(bet({ marketScope: "team", selection: "Över 4.5 hörnor", line: 4.5 }))).toMatchObject({
      ok: false,
      reason: /vilket lag/,
    });
  });

  it("Sofascores totalShotsOnGoal är totala skott, shotsOnGoal skott på mål", () => {
    expect(grade(bet({ marketCategory: "Skott", line: 23.5 }))).toMatchObject({ outcome: "win", value: 24 });
    expect(grade(bet({ marketCategory: "Skott på mål", line: 9.5, selectionSide: "under" }))).toMatchObject({
      outcome: "win",
      value: 9,
    });
  });

  it("spelarprops", () => {
    const kt = bet({ marketScope: "player", marketCategory: "Skott", selection: "Isaac Kiese Thelin över 3.5 skott", line: 3.5 });
    expect(grade(kt)).toMatchObject({ ok: true, outcome: "win", value: 4 });
    // Bara efternamnet räcker när det är entydigt.
    expect(
      grade(bet({ marketScope: "player", marketCategory: "Skott på mål", selection: "Celina Over 0.5", line: 0.5 }))
    ).toMatchObject({ outcome: "win", value: 1 });
    // Saknad nyckel hos en spelare = 0 (Sofascore utelämnar nollor)…
    expect(
      grade(bet({ marketScope: "player", marketCategory: "Skott på mål", selection: "Hugo Bolin över 0.5", line: 0.5 }))
    ).toMatchObject({ outcome: "loss", value: 0 });
    expect(grade(bet({ marketScope: "player", marketCategory: "Assists", selection: "Hugo Bolin över 0.5", line: 0.5 }))).toMatchObject({
      outcome: "win",
    });
  });

  it("totala spelarskott räknas ihop när totalShots saknas i matchen", () => {
    const lineups = parseLineups(load("football-lineups.json"));
    for (const p of lineups.players) delete p.stats.totalShots;
    const r = grade(
      bet({ marketScope: "player", marketCategory: "Skott", selection: "Isaac Kiese Thelin över 3.5", line: 3.5 }),
      { ...footballData, lineups }
    );
    expect(r).toMatchObject({ outcome: "win", value: 4 }); // 2 + 1 + 1
  });

  it("spelare som inte spelade, eller inte finns, rättas inte", () => {
    expect(
      grade(bet({ marketScope: "player", marketCategory: "Skott", selection: "Otto Rosengren över 0.5", line: 0.5 }))
    ).toMatchObject({ ok: false, reason: /spelade inte/ });
    expect(grade(bet({ marketScope: "player", marketCategory: "Skott", selection: "Zlatan över 0.5", line: 0.5 }))).toMatchObject({
      ok: false,
      reason: /spelare/,
    });
  });

  it("BTTS och mål efter ordinarie tid", () => {
    const btts = (selection: string) => bet({ marketCategory: "BTTS", selection, selectionSide: null, line: null });
    expect(grade(btts("Båda lagen gör mål: Ja"))).toMatchObject({ ok: true, outcome: "win" });
    expect(grade(btts("BTTS - Nej"))).toMatchObject({ ok: true, outcome: "loss" });
    expect(grade(btts("BTTS"))).toMatchObject({ classified: /ja\/nej/ });

    // Cupmatchen: 2–2 efter 90, 3–2 efter förlängning. Totalt räknar 90 minuter.
    const cup = events.find((e) => e.id === 13981240)!;
    const total = bet({ marketCategory: "Totalt", line: 4.5, selectionSide: "under" });
    expect(grade(total, { event: cup, stats: null, lineups: null })).toMatchObject({ outcome: "win", value: 4 });
  });

  it("ej färdigspelad match rättas inte", () => {
    const upcoming = events.find((e) => e.status === "scheduled")!;
    expect(grade(bet(), { event: upcoming, stats: null, lineups: null })).toMatchObject({ ok: false, reason: /inte färdigspelad/ });
  });

  it("statistik som saknas ger inget utfall", () => {
    expect(grade(bet(), { ...footballData, stats: {} })).toMatchObject({ ok: false, reason: /saknas/ });
  });
});

describe("gradeProp — basket och hockey", () => {
  const ev = { ...mffAik, homeTeam: { id: 1, name: "Boston Celtics", shortName: null }, awayTeam: { id: 2, name: "New York Knicks", shortName: null } };
  const bb: MatchData = { event: ev, stats: null, lineups: parseLineups(load("basketball-lineups.json")) };
  const hk: MatchData = { event: ev, stats: null, lineups: parseLineups(load("hockey-lineups.json")) };
  const player = (sport: string, marketCategory: string, selection: string, line: number, side = "over") =>
    bet({ sport, marketCategory, marketScope: "player", selection, line, selectionSide: side });

  it("basket: poäng, returer, trepoängare, PRA", () => {
    expect(grade(player("Basketball", "Spelarpoäng", "Jayson Tatum över 29.5 poäng", 29.5), bb)).toMatchObject({ outcome: "win", value: 31 });
    expect(grade(player("Basketball", "Returer", "Tatum under 8.5", 8.5, "under"), bb)).toMatchObject({ outcome: "loss", value: 9 });
    expect(grade(player("Basketball", "Trepoängare", "Jalen Brunson över 2.5", 2.5), bb)).toMatchObject({ outcome: "win", value: 3 });
    expect(grade(player("Basketball", "PRA", "Jayson Tatum över 45.5", 45.5), bb)).toMatchObject({ outcome: "win", value: 46 });
    // "Brown" och "Brunson" är olika; Jaylen Brown har inga blocks-nollor att gissa på — han har 1.
    expect(grade(player("Basketball", "Blocks", "Jaylen Brown över 0.5", 0.5), bb)).toMatchObject({ outcome: "win", value: 1 });
    expect(grade(player("Basketball", "Spelarpoäng", "Neemias Queta över 2.5", 2.5), bb)).toMatchObject({ ok: false, reason: /spelade inte/ });
  });

  it("hockey: skott, poäng (reserv: mål + assists), räddningar", () => {
    expect(grade(player("Ice Hockey", "Skott", "Auston Matthews över 3.5 skott", 3.5), hk)).toMatchObject({ outcome: "win", value: 5 });
    expect(grade(player("Ice Hockey", "Spelarpoäng", "Nylander över 1.5", 1.5), hk)).toMatchObject({ outcome: "win", value: 2 });
    expect(grade(player("Ice Hockey", "Räddningar", "Anthony Stolarz över 27.5", 27.5), hk)).toMatchObject({ outcome: "win", value: 29 });
  });

  it("ett fält som ingen spelare i matchen har rättas inte (kan vara fel nyckelnamn)", () => {
    const lineups = parseLineups(load("hockey-lineups.json"));
    for (const p of lineups.players) delete p.stats.shotsOnGoal;
    expect(grade(player("Ice Hockey", "Skott", "Auston Matthews över 3.5", 3.5), { ...hk, lineups })).toMatchObject({
      ok: false,
      reason: /finns inte/,
    });
  });
});

describe("findPlayer", () => {
  it("två spelare med samma efternamn ger ingen träff", () => {
    const l = parseLineups(load("basketball-lineups.json"));
    // "Brown" bara en gång; men "J." matchar inget — bara efternamnet räknas.
    expect(findPlayer("Brown över 20.5", l)?.name).toBe("Jaylen Brown");
    l.players.push({ ...l.players[1], playerId: 999, name: "Bruce Brown" });
    expect(findPlayer("Brown över 20.5", l)).toBeNull();
    expect(findPlayer("Jaylen Brown över 20.5", l)?.name).toBe("Jaylen Brown");
  });
});
