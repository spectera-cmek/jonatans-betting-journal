// Översättning mellan The Odds API och projektets egna begrepp.
//
// Rent räknande: inga Prisma-anrop, ingen fetch. Allt här går att testa utan
// nyckel, vilket är hela poängen — matchkopplingen är den del som tyst kan bli
// fel, och en tyst felkoppling sätter Arsenals pris på Aston Villas rad.
//
// The Odds API är sedan 2026-08-18 ENDA källan till /ev. TheStatsAPI är
// utkopplad: bet365 var enda skälet att behålla den, och den boken går inte
// att spela hos längre. Börsen kommer nu också härifrån, utan orderdjup — se
// ODDS_API_HAS_NO_DEPTH och den djuplösa likviditetsgrinden i lib/marketOdds.ts.

import type { OddsMarket, OddsOutcome } from "./marketOdds";

// ---------------------------------------------------------------------------
// Ligor
// ---------------------------------------------------------------------------

/**
 * Appens liganyckel → The Odds API:s sport_key.
 *
 * **Europa League saknas hos The Odds API** — kontrollerat mot deras
 * /sports-lista 2026-08-18, som är gratis. Varken `soccer_uefa_europa_league`
 * eller någon annan EL-nyckel finns, aktiv eller vilande; av europacuperna
 * fanns bara `soccer_uefa_champs_league_qualification` och
 * `soccer_uefa_nations_league`. Nu när The Odds API är enda källan får
 * EL-matcher därför inga priser alls — de faller helt ur EV-skärmen.
 *
 * Ligan står medvetet INTE med i registret. En nyckel som inte finns kostar en
 * kredit att få veta det, varje körning. Dyker EL upp när gruppspelet drar
 * igång lägger man till raden — `npm run odds:probe -- --sports` visar listan
 * gratis.
 */
export interface EvLeague {
  /** Nyckel i CLI, URL:er och ShotMatch.leagueKey. */
  key: string;
  label: string;
  /** The Odds API:s sport_key. */
  sportKey: string;
}

/**
 * Ligorna oddsjämförelsen bevakar.
 *
 * Registret ligger HÄR och inte i `SHOT_LEAGUES`. Det gjorde det förr, från
 * tiden då TheStatsAPI var källan — men skottmodellens register bär söktermer
 * och competition_id för ett API som inte längre är inkopplat, och det tvingade
 * varje ny liga att först finnas i skottmodellen. Nu räcker en rad här.
 *
 * Varje sport_key är kontrollerad mot deras /sports-lista, som är gratis:
 * `npm run odds:probe -- --sports` skriver ut om någon saknas.
 */
export const EV_LEAGUE_REGISTRY: EvLeague[] = [
  { key: "premier-league", label: "Premier League", sportKey: "soccer_epl" },
  { key: "laliga", label: "LaLiga", sportKey: "soccer_spain_la_liga" },
  { key: "serie-a", label: "Serie A", sportKey: "soccer_italy_serie_a" },
  { key: "bundesliga", label: "Bundesliga", sportKey: "soccer_germany_bundesliga" },
];

/** Liganyckel → sport_key. Härledd, så registret ovan är enda stället att ändra. */
export const ODDS_API_SPORT_KEY: Record<string, string> = Object.fromEntries(
  EV_LEAGUE_REGISTRY.map((l) => [l.key, l.sportKey])
);

export function sportKeyFor(leagueKey: string): string | null {
  return ODDS_API_SPORT_KEY[leagueKey] ?? null;
}

// ---------------------------------------------------------------------------
// Bokmakare
// ---------------------------------------------------------------------------

/**
 * The Odds API:s bookmaker-nyckel → projektets slug.
 *
 * Nycklarna är hämtade ur deras bokmakarlista 2026-08-18 och stavas EXAKT som
 * där. Flera skiljer sig från vad man skulle gissa: `expekt_se` (inte
 * "nyaexpekt_se"), `sport888_se` (inte "888sport_se"), `betclic_fr` (inte
 * "betclic").
 *
 * Medvetet en allowlist och inte en slugifiering. En härledd slug skulle tyst
 * släppa in vilken bok som helst i MarketPrice och göra `bestBook` till en bok
 * Jonatan inte har konto hos. Okända nycklar RAPPORTERAS av ingest-skriptet i
 * stället för att slinka igenom — det är så listan ska växa.
 *
 * En bok per land, aldrig flera nycklar till samma slug. `unibet_se` och
 * `unibet_uk` är olika böcker med olika priser; att mappa båda till "unibet"
 * hade låtit dem skriva över varandra beroende på svarsordningen.
 */
export const ODDS_API_BOOKMAKER_SLUG: Record<string, string> = {
  // Skarpa referenser
  pinnacle: "pinnacle",
  betfair_ex_eu: "betfair-exchange",
  betfair_ex_uk: "betfair-exchange",
  matchbook: "matchbook",

  // Svenska böcker — skälet till att API:et är värt att koppla in.
  // Alla verifierade i ett verkligt svar för regions=eu,se 2026-08-18.
  betsson: "betsson",
  nordicbet: "nordicbet",
  coolbet: "coolbet",
  betinia_se: "betinia",
  unibet_se: "unibet",
  leovegas_se: "leovegas",
  expekt_se: "expekt",
  sport888_se: "888sport",
  betmgm_se: "betmgm-se",
  // Dök upp i svaret utan att stå i dokumentationens lista.
  svenskaspel_se: "svenskaspel",
  atg_se: "atg",
  hajper_se: "hajper",
  campobet_se: "campobet",
  mrgreen_se: "mrgreen",

  // Övriga EU/UK-böcker
  betclic_fr: "betclic",
  betfair_sb_uk: "betfair-sportsbook",
  paddypower: "paddy-power",
  williamhill: "william-hill",
};

/**
 * Böcker som bara är referens, aldrig destination.
 *
 * Läses in som alla andra men får aldrig vara `bestBook` — se `isShoppable` i
 * lib/marketOdds.ts. Börsen sätter fair line, och att shoppa mot sin egen
 * referens är cirkulärt; matchbook är en börs på samma sätt.
 */
export const ODDS_API_REFERENCE_ONLY = new Set(["betfair-exchange", "matchbook"]);

export function bookmakerSlugFor(oddsApiKey: string): string | null {
  return ODDS_API_BOOKMAKER_SLUG[oddsApiKey.trim().toLowerCase()] ?? null;
}

/**
 * Alla slugs The Odds API skriver till MarketPrice.
 *
 * The Odds API är enda källan, så den äger varje kartlagd bok — även börsen
 * och Pinnacle, som TheStatsAPI förr stod för. Härledd ur kartan så att en ny
 * rad i ODDS_API_BOOKMAKER_SLUG räcker för att boken ska börja läsas in.
 *
 * Referensböckerna (börsen, matchbook) står MED här: de läses in för att kunna
 * sätta fair line. Att de inte går att spela hos hanteras separat av
 * `isShoppable` i lib/marketOdds.ts, inte genom att utelämna dem ur inläsningen.
 */
export const ODDS_API_INGESTED_SLUGS: string[] = [
  ...new Set(Object.values(ODDS_API_BOOKMAKER_SLUG)),
];

/**
 * The Odds API levererar INTE orderdjup för börsen — bara back- och lay-pris.
 *
 * Verifierat mot både dokumentationen och ett verkligt svar 2026-08-18.
 * Konsekvensen är konkret: börsens `backSize`/`laySize` blir null, och
 * `exchangeMid` markerar då djupet som OKÄNT. Likviditetsgrinden i
 * lib/marketOdds.ts faller tillbaka på en snävare spreadgräns
 * (DEFAULT_MAX_SPREAD_PCT_NO_DEPTH) i stället för att kräva ett djup som inte
 * finns att mäta. Uppmätt att spread ≤ 3 % ger samma renhet som den gamla
 * djupgrinden.
 */
export const ODDS_API_HAS_NO_DEPTH = true;

// ---------------------------------------------------------------------------
// Marknader
// ---------------------------------------------------------------------------

/** The Odds API:s market_key → projektets marknad. */
export const ODDS_API_MARKET: Record<string, OddsMarket> = {
  h2h: "1x2",
  h2h_lay: "1x2",
  totals: "totals",
  alternate_totals: "totals",
  spreads: "ah",
};

/**
 * Marknad som bara finns på event-endpointen, och som bara REFERENSBÖCKERNA
 * läses in från.
 *
 * Bulk-endpointen ger varje bok dess egen huvudlinje. Uppmätt på
 * Espanyol–Real Madrid: åtta böcker på 2,5 men Pinnacle ensam på 2,75, vilket
 * gjorde alla åtta oanvändbara — `priceMarket` kräver en referens på samma
 * linje. Med alternativa linjer får Pinnacle ett pris på 1,75 till 3,75 och kan
 * prissätta vilken linje böckerna än råkar ligga på.
 *
 * Bara referensböckerna läses in härifrån. Att spara alternativa linjer för
 * alla böcker hade mångdubblat radantalet och skapat mängder av linjegrupper
 * med en enda bok i — brus, inte jämförelser.
 */
export const ODDS_API_ALT_MARKET = "alternate_totals";

/**
 * Marknader att begära. Kostar en kredit per marknad OCH region.
 *
 * `h2h` och `totals` är de två som bär. Uppmätt 2026-08-18 mot bulk-endpointen:
 * totals ger 7 spelbara böcker (Unibet, LeoVegas, ATG, Coolbet, NordicBet,
 * Betsson, William Hill) plus Pinnacle och matchbook som referens — trots att
 * dokumentationen påstår att totals "mainly" finns för amerikanska sporter.
 *
 * `spreads` är MEDVETET utelämnad: bara Coolbet av de spelbara böckerna prissatte
 * den, och asiatiskt handikapp är dessutom avstängt i UI:t tills teckenkontrollen
 * är bättre (se verifyHandicapSigns). En kredit per region för en enda bok.
 */
export const ODDS_API_MARKET_KEYS = ["h2h", "totals", "spreads"] as const;
export const ODDS_API_DEFAULT_MARKETS = "h2h,totals";

/**
 * Regioner att begära.
 *
 * **`se` är giltig och nödvändig** — uppmätt mot ett verkligt svar 2026-08-18,
 * trots att dokumentationens regionlista bara nämner `us, us2, uk, au, eu`.
 * Utan `se` kommer inte en enda av de svenska böckerna med, och de är hela
 * skälet till kopplingen. `eu` behålls för Betclic, William Hill och börsen.
 *
 * Kostar en kredit per region OCH marknad, per liga: två ligor × h2h ×
 * två regioner = 4 krediter per full uppdatering. Kvoten är 20 000/månad, så
 * det är försumbart.
 */
export const ODDS_API_DEFAULT_REGIONS = "eu,se";

// ---------------------------------------------------------------------------
// Lagnamn
// ---------------------------------------------------------------------------

/**
 * Ord som bara är bolagsform eller klubbsuffix.
 *
 * "Real" och "Athletic" står MEDVETET inte här: de skiljer Real Madrid från
 * Real Betis och Athletic Club från Atlético. Listan får bara innehålla ord som
 * aldrig ensamma avgör vilket lag som avses.
 */
const NOISE_TOKENS = new Set([
  "fc", "fk", "sk", "sc", "cf", "ac", "as", "ss", "cd", "ud", "us", "if", "bk",
  "aif", "afc", "rsc", "vv", "tc", "kf", "cs", "sv", "vfl", "vfb", "bsc",
  "club", "clube", "calcio", "futbol", "football", "fotball", "sad", "bv",
  "nv", "ff", "de",
]);

/**
 * Namn som inte går att brygga med normalisering — källorna använder olika
 * klubbnamn, inte olika stavning.
 *
 * Håll listan kort och belagd. Varje rad ska vara ett fall någon faktiskt sett
 * i data, inte en gissning på förhand.
 */
export const TEAM_ALIASES: Record<string, string> = {
  "crvena zvezda": "red star belgrade",
  "fk crvena zvezda": "red star belgrade",
  "sint truidense": "sint truiden",
  internazionale: "inter milan",
  "sporting cp": "sporting lisbon",
};

const DIACRITICS = /[̀-ͯ]/g;

/**
 * Fäller ihop ett lagnamn till en jämförbar sträng.
 *
 * Diakritiker viks bort (Beşiktaş → besiktas), "&" blir "and", skiljetecken
 * försvinner. Alias slås upp EFTER foldningen, så tabellen ovan kan skrivas i
 * ren ASCII.
 */
export function normalizeTeam(name: string): string {
  const folded = name
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/đ/g, "d")
    .replace(/ł/g, "l")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return TEAM_ALIASES[folded] ?? folded;
}

export function teamTokens(name: string): string[] {
  const tokens = normalizeTeam(name).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !NOISE_TOKENS.has(t));
  // Rensa aldrig bort allt: "FC Thun" ska bli ["thun"], men ett lag vars hela
  // namn består av brusord måste behålla något att jämföra på.
  const base = kept.length > 0 ? kept : tokens;

  // Alias slås upp igen utan brusorden. "Sint-Truidense VV" folder till
  // "sint truidense vv", vilket inte står i tabellen — men "sint truidense"
  // gör det. Utan det här steget hade varje alias behövt en rad per suffix.
  const alias = TEAM_ALIASES[base.join(" ")];
  return alias ? alias.split(" ").filter(Boolean) : base;
}

/**
 * Matchar två tokens. Prefix räknas från fyra tecken, vilket brygger
 * "ferencvaros"/"ferencvarosi" och "truiden"/"truidense" utan att slå ihop
 * korta ord som "real" och "reading".
 */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Likhet mellan två lagnamn, 0–1.
 *
 * Delas med det KORTASTE namnets längd, inte med unionen. Källorna förkortar
 * olika mycket — "Alaves" mot "Deportivo Alavés" är samma lag, och ett
 * Jaccard-mått skulle straffa det till 0,5 medan en delmängdsträff ger 1.
 */
export function teamSimilarity(a: string, b: string): number {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const used = new Set<number>();
  let matched = 0;
  for (const x of ta) {
    for (let i = 0; i < tb.length; i++) {
      if (used.has(i) || !tokenMatch(x, tb[i])) continue;
      used.add(i);
      matched += 1;
      break;
    }
  }
  return matched / Math.min(ta.length, tb.length);
}

// ---------------------------------------------------------------------------
// Matchkoppling
// ---------------------------------------------------------------------------

export interface FixtureCandidate {
  id: string;
  kickoffAt: Date;
  homeTeamName: string;
  awayTeamName: string;
}

export interface FixtureMatch {
  fixture: FixtureCandidate;
  /** Snitt av hemma- och bortalikheten. */
  score: number;
  /** Avstånd till näst bästa kandidat. Litet avstånd = tvetydigt. */
  margin: number;
  hoursApart: number;
}

/**
 * Båda lagen måste likna, inte bara ett.
 *
 * Två tredjedelar och inte hälften, av ett uppmätt skäl: "Real Madrid" mot
 * "Real Betis" delar en av två tokens och landar på exakt 0,5. Samma sak för
 * Manchester City/United och Atlético/Real Madrid. Saknas den rätta fixturen i
 * databasen finns ingen tvåa som marginalkontrollen kan förkasta träffen mot,
 * och 0,5 hade räckt för att skriva Real Madrids priser på Real Betis rad.
 *
 * 0,67 släpper igenom förkortningar ("Alaves" mot "Deportivo Alavés" ger 1,0)
 * men aldrig två lag som bara delar ortnamn.
 */
export const MIN_TEAM_SIMILARITY = 0.67;
/** Vinnaren måste vara tydligt bättre än tvåan. */
export const MIN_MATCH_MARGIN = 0.15;
/** Avsparkstiden får skilja så här mycket mellan källorna. */
export const MAX_KICKOFF_DRIFT_HOURS = 6;

/**
 * Kopplar en Odds API-match till en lagrad fixture.
 *
 * Tid + liga snävar in fältet till en handfull kandidater; namnlikheten avgör
 * mellan dem. Ordningen spelar roll — att söka på namn globalt skulle behöva
 * särskilja hundratals lag, att söka inom ett tidsfönster behöver särskilja tre.
 *
 * Returnerar null hellre än en osäker träff. En felkopplad match sätter fel
 * lags priser på raden, och det syns inte i UI:t — det ser bara ut som en edge.
 */
export function matchFixture(
  event: { home_team: string; away_team: string; commence_time: string },
  candidates: FixtureCandidate[],
  opts: { maxDriftHours?: number; minSimilarity?: number; minMargin?: number } = {}
): FixtureMatch | null {
  const maxDrift = opts.maxDriftHours ?? MAX_KICKOFF_DRIFT_HOURS;
  const minSim = opts.minSimilarity ?? MIN_TEAM_SIMILARITY;
  const minMargin = opts.minMargin ?? MIN_MATCH_MARGIN;

  const kickoff = new Date(event.commence_time).getTime();
  if (!Number.isFinite(kickoff)) return null;

  const scored: Array<{ fixture: FixtureCandidate; score: number; hoursApart: number }> = [];
  for (const c of candidates) {
    const hoursApart = Math.abs(c.kickoffAt.getTime() - kickoff) / 3600_000;
    if (hoursApart > maxDrift) continue;
    const home = teamSimilarity(event.home_team, c.homeTeamName);
    const away = teamSimilarity(event.away_team, c.awayTeamName);
    if (home < minSim || away < minSim) continue;
    scored.push({ fixture: c, score: (home + away) / 2, hoursApart });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.hoursApart - b.hoursApart);

  const best = scored[0];
  const runnerUp = scored[1];
  const margin = runnerUp ? best.score - runnerUp.score : 1;
  // Lika bra träff på två fixturer betyder att namnen inte räcker för att
  // skilja dem åt. Då är rätt svar inget svar.
  if (runnerUp && margin < minMargin) return null;

  return { fixture: best.fixture, score: best.score, margin, hoursApart: best.hoursApart };
}

// ---------------------------------------------------------------------------
// Prisrader
// ---------------------------------------------------------------------------

export interface OddsApiPriceRow {
  bookmaker: string;
  market: OddsMarket;
  outcome: OddsOutcome;
  line: number | null;
  odds: number;
  layOdds: number | null;
  backSize: number | null;
  laySize: number | null;
}

interface RawOutcome {
  name: string;
  price: number;
  point?: number;
}
interface RawMarket {
  key: string;
  outcomes?: RawOutcome[];
}
interface RawBookmaker {
  key: string;
  title?: string;
  markets?: RawMarket[];
}
export interface RawOddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: RawBookmaker[];
}

const validOdds = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 1;

/**
 * Vilket utfall ett namn syftar på.
 *
 * The Odds API namnger 1X2- och handikapputfall med LAGNAMNET, inte med
 * "home"/"away". Namnen är dessutom API:ets egna, så jämförelsen måste gå via
 * samma likhetsmått som matchkopplingen — annars tappas Beşiktaş.
 *
 * Kravet på full likhet (1) och strikt bättre än motståndaren är avsiktligt:
 * hellre en tappad rad än en rad på fel lag.
 */
function outcomeFor(
  market: OddsMarket,
  name: string,
  event: RawOddsEvent
): OddsOutcome | null {
  const n = normalizeTeam(name);
  // Tar projektets marknad, INTE API:ets nyckel. Med rånyckeln missade
  // `alternate_totals` över/under-grenen och varje alternativ linje föll
  // igenom till lagnamnsmatchningen och kastades tyst.
  if (market === "totals") {
    if (n.startsWith("over")) return "over";
    if (n.startsWith("under")) return "under";
    return null;
  }
  if (n === "draw" || n === "tie") return "draw";
  const home = teamSimilarity(name, event.home_team);
  const away = teamSimilarity(name, event.away_team);
  if (home >= 1 && home > away) return "home";
  if (away >= 1 && away > home) return "away";
  return null;
}

/**
 * Plattar ut ett Odds API-event till prisrader.
 *
 * Börsens back och lay kommer som två separata marknader (`h2h` och
 * `h2h_lay`). De slås ihop till en rad, eftersom `exchangeMid` behöver båda
 * sidorna samtidigt för att räkna en mittpunkt. Djup finns inte att hämta —
 * `backSize`/`laySize` blir null, och det är signalen som gör att
 * likviditetsgrinden låter börsen falla igenom i stället för att lita på den.
 */
export function extractOddsApiPrices(event: RawOddsEvent): {
  rows: OddsApiPriceRow[];
  unknownBookmakers: string[];
} {
  const byKey = new Map<string, OddsApiPriceRow>();
  const unknown = new Set<string>();

  for (const book of event.bookmakers ?? []) {
    const slug = bookmakerSlugFor(book.key);
    if (!slug) {
      unknown.add(book.key);
      continue;
    }

    for (const market of book.markets ?? []) {
      const mapped = ODDS_API_MARKET[market.key];
      if (!mapped) continue;
      const isLay = market.key === "h2h_lay";

      for (const o of market.outcomes ?? []) {
        if (!validOdds(o.price)) continue;
        const outcome = outcomeFor(mapped, o.name, event);
        if (!outcome) continue;

        const line = mapped === "1x2" ? null : typeof o.point === "number" ? o.point : null;
        if (mapped !== "1x2" && line == null) continue;

        const key = `${slug}|${mapped}|${outcome}|${line ?? "-"}`;
        const existing = byKey.get(key);
        if (isLay) {
          if (existing) existing.layOdds = o.price;
          else
            byKey.set(key, {
              bookmaker: slug, market: mapped, outcome, line,
              odds: 0, layOdds: o.price, backSize: null, laySize: null,
            });
        } else if (existing) {
          existing.odds = o.price;
        } else {
          byKey.set(key, {
            bookmaker: slug, market: mapped, outcome, line,
            odds: o.price, layOdds: null, backSize: null, laySize: null,
          });
        }
      }
    }
  }

  // En rad som bara har lay-sida är inget spelbart pris. Den skulle lagras med
  // odds 0 och sedan förkastas tyst längre fram — bättre att den aldrig skrivs.
  const rows = [...byKey.values()].filter((r) => validOdds(r.odds));
  return { rows, unknownBookmakers: [...unknown] };
}
