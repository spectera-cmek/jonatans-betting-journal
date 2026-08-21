import { describe, expect, it } from "vitest";
import {
  bookmakerSlugFor,
  extractOddsApiPrices,
  matchFixture,
  MIN_TEAM_SIMILARITY,
  normalizeTeam,
  sportKeyFor,
  teamSimilarity,
  teamTokens,
  type FixtureCandidate,
  type RawOddsEvent,
} from "../lib/oddsApiMap";

// Lagnamnen nedan är de som faktiskt ligger i ShotMatch (hämtade 2026-08-18),
// inte påhittade exempel. Motparten är hur The Odds API brukar stava dem.

describe("normalizeTeam", () => {
  it("viker bort diakritiker källorna stavar olika", () => {
    expect(normalizeTeam("Beşiktaş")).toBe("besiktas");
    expect(normalizeTeam("Atlético Madrid")).toBe("atletico madrid");
    expect(normalizeTeam("Viktoria Plzeň")).toBe("viktoria plzen");
    expect(normalizeTeam("Lech Poznań")).toBe("lech poznan");
    expect(normalizeTeam("Jagiellonia Białystok")).toBe("jagiellonia bialystok");
    expect(normalizeTeam("Lillestrøm SK")).toBe("lillestrom sk");
    expect(normalizeTeam("Mjällby AIF")).toBe("mjallby aif");
    expect(normalizeTeam("Deportivo La Coruña")).toBe("deportivo la coruna");
  });

  it("gör & till and", () => {
    expect(normalizeTeam("Brighton & Hove Albion")).toBe("brighton and hove albion");
  });

  it("rensar klubbsuffix men aldrig särskiljande ord", () => {
    expect(teamTokens("FC Thun")).toEqual(["thun"]);
    expect(teamTokens("RSC Anderlecht")).toEqual(["anderlecht"]);
    expect(teamTokens("Ferencváros TC")).toEqual(["ferencvaros"]);
    // "Real" och "Athletic" skiljer lag åt och får aldrig rensas bort.
    expect(teamTokens("Real Betis")).toEqual(["real", "betis"]);
    expect(teamTokens("Athletic Club")).toEqual(["athletic"]);
  });

  it("slår upp alias även när ett klubbsuffix står i vägen", () => {
    expect(teamTokens("FK Crvena zvezda")).toEqual(["red", "star", "belgrade"]);
    expect(teamTokens("Sint-Truidense VV")).toEqual(["sint", "truiden"]);
  });
});

describe("teamSimilarity", () => {
  const samePairs: Array<[string, string]> = [
    ["Atletico Madrid", "Atlético Madrid"],
    ["Besiktas", "Beşiktaş"],
    ["Anderlecht", "RSC Anderlecht"],
    ["Ferencvaros", "Ferencváros TC"],
    ["Kauno Zalgiris", "FK Kauno Žalgiris"],
    ["Lillestrom", "Lillestrøm SK"],
    ["Mjallby AIF", "Mjällby AIF"],
    ["Egnatia", "KF Egnatia"],
    ["Ararat-Armenia", "FC Ararat-Armenia"],
    ["Iberia 1999", "FC Iberia 1999"],
    ["Sint-Truiden", "Sint-Truidense VV"],
    ["Red Star Belgrade", "FK Crvena zvezda"],
    ["Viktoria Plzen", "Viktoria Plzeň"],
    ["Alaves", "Deportivo Alavés"],
    ["Levante", "Levante UD"],
    ["Celta de Vigo", "Celta Vigo"],
    ["Brighton and Hove Albion", "Brighton & Hove Albion"],
    ["Nott'm Forest", "Nottingham Forest"],
    ["Tottenham", "Tottenham Hotspur"],
    ["Malaga", "Málaga"],
  ];

  it.each(samePairs)("kopplar ihop %s och %s", (a, b) => {
    expect(teamSimilarity(a, b)).toBeGreaterThanOrEqual(MIN_TEAM_SIMILARITY);
  });

  // Lag som delar ortnamn men inte är samma klubb. Faller de här igenom hamnar
  // ett lags priser på ett annat lags rad, och det syns inte i UI:t.
  const differentPairs: Array<[string, string]> = [
    ["Real Madrid", "Real Betis"],
    ["Real Madrid", "Real Sociedad"],
    ["Real Sociedad", "Real Betis"],
    ["Manchester City", "Manchester United"],
    ["Atletico Madrid", "Real Madrid"],
    ["Athletic Club", "Atlético Madrid"],
    ["Deportivo La Coruña", "Deportivo Alavés"],
    ["Elche", "Espanyol"],
    ["Getafe", "Girona"],
    ["Racing de Santander", "Rayo Vallecano"],
  ];

  it.each(differentPairs)("håller isär %s och %s", (a, b) => {
    expect(teamSimilarity(a, b)).toBeLessThan(MIN_TEAM_SIMILARITY);
  });

  it("inget par av verkliga lag i samma liga korsar tröskeln", () => {
    const leagues: Record<string, string[]> = {
      pl: [
        "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton & Hove Albion",
        "Chelsea", "Coventry City", "Crystal Palace", "Everton", "Fulham", "Hull City",
        "Ipswich Town", "Leeds United", "Liverpool", "Manchester City", "Manchester United",
        "Newcastle United", "Nottingham Forest", "Sunderland", "Tottenham Hotspur",
      ],
      laliga: [
        "Athletic Club", "Atlético Madrid", "Barcelona", "Celta Vigo", "Deportivo Alavés",
        "Deportivo La Coruña", "Elche", "Espanyol", "Getafe", "Levante UD", "Málaga",
        "Osasuna", "Racing de Santander", "Rayo Vallecano", "Real Betis", "Real Madrid",
        "Real Sociedad", "Sevilla", "Valencia", "Villarreal",
      ],
      el: [
        "AGF", "Benfica", "Beşiktaş", "CSKA Sofia", "FC Ararat-Armenia", "FC Iberia 1999",
        "FC Thun", "FK Crvena zvezda", "FK Kauno Žalgiris", "Ferencváros TC",
        "Jagiellonia Białystok", "KF Egnatia", "Kairat Almaty", "Lech Poznań",
        "Lillestrøm SK", "Mjällby AIF", "OFI Crete", "Omonia Nicosia", "RSC Anderlecht",
        "Red Bull Salzburg", "Sint-Truidense VV", "Trabzonspor", "Universitatea Craiova",
        "Viktoria Plzeň",
      ],
    };

    const collisions: string[] = [];
    for (const [league, teams] of Object.entries(leagues)) {
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const s = teamSimilarity(teams[i], teams[j]);
          if (s >= MIN_TEAM_SIMILARITY) collisions.push(`${league}: ${teams[i]} ~ ${teams[j]} (${s})`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});

describe("matchFixture", () => {
  const at = (iso: string) => new Date(iso);
  const fixtures: FixtureCandidate[] = [
    { id: "mt_1", kickoffAt: at("2026-08-20T17:00:00Z"), homeTeamName: "Beşiktaş", awayTeamName: "FK Kauno Žalgiris" },
    { id: "mt_2", kickoffAt: at("2026-08-20T17:00:00Z"), homeTeamName: "Lech Poznań", awayTeamName: "FC Thun" },
    { id: "mt_3", kickoffAt: at("2026-08-20T17:00:00Z"), homeTeamName: "Trabzonspor", awayTeamName: "Ferencváros TC" },
    { id: "mt_4", kickoffAt: at("2026-08-19T19:00:00Z"), homeTeamName: "Atlético Madrid", awayTeamName: "Málaga" },
  ];

  it("hittar rätt match bland samtidiga kandidater", () => {
    const hit = matchFixture(
      { home_team: "Besiktas", away_team: "Kauno Zalgiris", commence_time: "2026-08-20T17:00:00Z" },
      fixtures
    );
    expect(hit?.fixture.id).toBe("mt_1");
    expect(hit?.score).toBe(1);
  });

  it("tål att källorna stavar och förkortar olika", () => {
    const hit = matchFixture(
      { home_team: "Trabzonspor", away_team: "Ferencvarosi TC", commence_time: "2026-08-20T17:00:00Z" },
      fixtures
    );
    expect(hit?.fixture.id).toBe("mt_3");
  });

  it("tål en timmes drift i avsparkstid", () => {
    const hit = matchFixture(
      { home_team: "Lech Poznan", away_team: "Thun", commence_time: "2026-08-20T18:00:00Z" },
      fixtures
    );
    expect(hit?.fixture.id).toBe("mt_2");
    expect(hit?.hoursApart).toBe(1);
  });

  it("returnerar null när matchen ligger utanför tidsfönstret", () => {
    expect(
      matchFixture(
        { home_team: "Besiktas", away_team: "Kauno Zalgiris", commence_time: "2026-08-22T17:00:00Z" },
        fixtures
      )
    ).toBeNull();
  });

  it("returnerar null i stället för att gissa när laget inte finns", () => {
    expect(
      matchFixture(
        { home_team: "Real Madrid", away_team: "Sevilla", commence_time: "2026-08-19T19:00:00Z" },
        fixtures
      )
    ).toBeNull();
  });

  it("returnerar null när två fixturer är lika bra träffar", () => {
    const ambiguous: FixtureCandidate[] = [
      { id: "a", kickoffAt: at("2026-08-20T17:00:00Z"), homeTeamName: "Deportivo", awayTeamName: "Elche" },
      { id: "b", kickoffAt: at("2026-08-20T17:00:00Z"), homeTeamName: "Deportivo La Coruña", awayTeamName: "Elche" },
    ];
    expect(
      matchFixture(
        { home_team: "Deportivo", away_team: "Elche", commence_time: "2026-08-20T17:00:00Z" },
        ambiguous
      )
    ).toBeNull();
  });
});

describe("bookmakerSlugFor", () => {
  // Nycklarna stavas som i deras bokmakarlista, inte som man skulle gissa.
  it("mappar de svenska böckerna med API:ets egen stavning", () => {
    expect(bookmakerSlugFor("betsson")).toBe("betsson");
    expect(bookmakerSlugFor("nordicbet")).toBe("nordicbet");
    expect(bookmakerSlugFor("coolbet")).toBe("coolbet");
    expect(bookmakerSlugFor("betinia_se")).toBe("betinia");
    expect(bookmakerSlugFor("unibet_se")).toBe("unibet");
    expect(bookmakerSlugFor("leovegas_se")).toBe("leovegas");
    expect(bookmakerSlugFor("expekt_se")).toBe("expekt");
    expect(bookmakerSlugFor("sport888_se")).toBe("888sport");
    expect(bookmakerSlugFor("betclic_fr")).toBe("betclic");
  });

  it("mappar inte gissade stavningar som inte finns i API:et", () => {
    expect(bookmakerSlugFor("nyaexpekt_se")).toBeNull();
    expect(bookmakerSlugFor("888sport_se")).toBeNull();
    expect(bookmakerSlugFor("betclic")).toBeNull();
  });

  it("mappar aldrig två landsvarianter till samma slug", () => {
    // unibet_se och unibet_uk är olika böcker med olika priser. Delade de slug
    // skulle de skriva över varandra beroende på svarsordningen.
    expect(bookmakerSlugFor("unibet_uk")).toBeNull();
    expect(bookmakerSlugFor("leovegas")).toBeNull();
  });

  it("mappar börsen och Pinnacle till samma slugs som TheStatsAPI", () => {
    expect(bookmakerSlugFor("betfair_ex_eu")).toBe("betfair-exchange");
    expect(bookmakerSlugFor("pinnacle")).toBe("pinnacle");
  });

  it("returnerar null för okända böcker i stället för att hitta på en slug", () => {
    expect(bookmakerSlugFor("comeon")).toBeNull();
    expect(bookmakerSlugFor("")).toBeNull();
  });
});

describe("sportKeyFor", () => {
  it("täcker de ligor The Odds API faktiskt har", () => {
    expect(sportKeyFor("premier-league")).toBe("soccer_epl");
    expect(sportKeyFor("laliga")).toBe("soccer_spain_la_liga");
  });

  // Kontrollerat mot deras gratis /sports-lista 2026-08-18: ingen EL-nyckel
  // finns. Att ha kvar den hade kostat en kredit per körning för att få reda
  // på samma sak igen.
  it("har inte Europa League — den finns inte hos The Odds API", () => {
    expect(sportKeyFor("europa-league")).toBeNull();
    expect(sportKeyFor("allsvenskan")).toBeNull();
  });
});

describe("extractOddsApiPrices", () => {
  const event = (bookmakers: RawOddsEvent["bookmakers"]): RawOddsEvent => ({
    id: "evt",
    commence_time: "2026-08-20T17:00:00Z",
    home_team: "Trabzonspor",
    away_team: "Ferencvarosi TC",
    bookmakers,
  });

  it("översätter 1X2 med lagnamn till home/draw/away", () => {
    const { rows } = extractOddsApiPrices(
      event([
        {
          key: "betsson",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Trabzonspor", price: 1.95 },
                { name: "Ferencvarosi TC", price: 4.2 },
                { name: "Draw", price: 3.6 },
              ],
            },
          ],
        },
      ])
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.outcome === "home")).toMatchObject({
      bookmaker: "betsson", market: "1x2", odds: 1.95, line: null,
    });
    expect(rows.find((r) => r.outcome === "draw")?.odds).toBe(3.6);
    expect(rows.find((r) => r.outcome === "away")?.odds).toBe(4.2);
  });

  it("slår ihop börsens back och lay till en rad, utan djup", () => {
    const { rows } = extractOddsApiPrices(
      event([
        {
          key: "betfair_ex_eu",
          markets: [
            { key: "h2h", outcomes: [{ name: "Trabzonspor", price: 2.0 }] },
            { key: "h2h_lay", outcomes: [{ name: "Trabzonspor", price: 2.04 }] },
          ],
        },
      ])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bookmaker: "betfair-exchange", outcome: "home", odds: 2.0, layOdds: 2.04,
      backSize: null, laySize: null,
    });
  });

  it("kastar en rad som bara har lay-sida — den går inte att spela", () => {
    const { rows } = extractOddsApiPrices(
      event([
        {
          key: "betfair_ex_eu",
          markets: [{ key: "h2h_lay", outcomes: [{ name: "Trabzonspor", price: 2.04 }] }],
        },
      ])
    );
    expect(rows).toEqual([]);
  });

  it("behåller handikappets tecken som boken angav det", () => {
    const { rows } = extractOddsApiPrices(
      event([
        {
          key: "betsson",
          markets: [
            {
              key: "spreads",
              outcomes: [
                { name: "Trabzonspor", price: 1.9, point: -0.5 },
                { name: "Ferencvarosi TC", price: 1.95, point: 0.5 },
              ],
            },
          ],
        },
      ])
    );
    expect(rows.find((r) => r.outcome === "home")).toMatchObject({ market: "ah", line: -0.5 });
    expect(rows.find((r) => r.outcome === "away")).toMatchObject({ market: "ah", line: 0.5 });
  });

  it("läser över/under med linje", () => {
    const { rows } = extractOddsApiPrices(
      event([
        {
          key: "unibet_se",
          markets: [
            {
              key: "totals",
              outcomes: [
                { name: "Over", price: 1.85, point: 2.5 },
                { name: "Under", price: 1.95, point: 2.5 },
              ],
            },
          ],
        },
      ])
    );
    expect(rows).toEqual([
      expect.objectContaining({ bookmaker: "unibet", market: "totals", outcome: "over", line: 2.5, odds: 1.85 }),
      expect.objectContaining({ market: "totals", outcome: "under", line: 2.5, odds: 1.95 }),
    ]);
  });

  // Regression: alternate_totals är en egen API-nyckel men samma marknad.
  // outcomeFor jämförde mot rånyckeln, så varje alternativ linje föll igenom
  // till lagnamnsmatchningen och kastades tyst — referensen fick inga linjer.
  it("läser alternate_totals som över/under, inte som lagnamn", () => {
    const { rows } = extractOddsApiPrices(
      event([
        {
          key: "pinnacle",
          markets: [
            {
              key: "alternate_totals",
              outcomes: [
                { name: "Over", price: 2.1, point: 2.5 },
                { name: "Under", price: 1.8, point: 2.5 },
                { name: "Over", price: 2.5, point: 3 },
                { name: "Under", price: 1.6, point: 3 },
              ],
            },
          ],
        },
      ])
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.market === "totals")).toBe(true);
    expect(rows.map((r) => r.line).sort()).toEqual([2.5, 2.5, 3, 3]);
    expect(rows.filter((r) => r.outcome === "over")).toHaveLength(2);
  });

  it("rapporterar okända böcker i stället för att tyst släppa dem", () => {
    const { rows, unknownBookmakers } = extractOddsApiPrices(
      event([
        { key: "somenewbook", markets: [{ key: "h2h", outcomes: [{ name: "Trabzonspor", price: 2 }] }] },
      ])
    );
    expect(rows).toEqual([]);
    expect(unknownBookmakers).toEqual(["somenewbook"]);
  });

  it("kastar priser som inte är spelbara odds", () => {
    const { rows } = extractOddsApiPrices(
      event([
        {
          key: "betsson",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Trabzonspor", price: 1 },
                { name: "Draw", price: 0 },
                { name: "Ferencvarosi TC", price: 4.2 },
              ],
            },
          ],
        },
      ])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("away");
  });
});
