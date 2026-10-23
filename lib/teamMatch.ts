// Lagnamnsmatchning: avgör om två källor menar samma lag och samma match.
//
// Rent räknande: inga Prisma-anrop, ingen fetch. Matchkopplingen är den del
// som tyst kan bli fel — en tyst felkoppling sätter fel lags statistik på ett
// bet — så trösklarna nedan är uppmätta, inte gissade. Används av
// props-rättningen (lib/propsGrading.ts) för att hitta ESPN-, NHL- och
// Sofascore-matcher.

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

/**
 * Förkortade ord i lagnamn. OddsPortal skriver "Atl. Madrid" och
 * "Manchester Utd", spelbolagen ofta "Man Utd".
 */
const TOKEN_ALIASES: Record<string, string> = {
  atl: "atletico",
  utd: "united",
  man: "manchester",
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
  const tokens = normalizeTeam(name)
    .split(" ")
    .filter(Boolean)
    .map((t) => TOKEN_ALIASES[t] ?? t);
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
 * Kopplar en match (lag + avsparkstid) till rätt fixture bland kandidaterna.
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
