// OddsPortal closing-odds via Scrapling (Python-workern i scrapers/worker.py).
//
// Flödet: hitta matchsidan, öppna rätt flik, klicka fram linjen och välj
// bolag. Scrapling hämtar sidan (och gör klicken); tolkningen sker på den
// sparade HTML:en (parseHtml.ts). Klickar man fram en linje syns oddsen PER
// BOLAG, så O/U-closing kan tas från bettets bolag/Pinnacle i stället för
// OddsPortals snitt.
//
// Spelade matcher nås via ligans resultatsida och lagparets h2h-sida,
// kommande via söket. Hanterar h2h/1X2, Over/Under och Asian Handicap. Props,
// hörnor och kort finns inte på OddsPortal på ett sätt som går att lita på —
// de svarar market_not_found.

import { ScraplingWorker } from "../scrapling";
import {
  buildSearchQuery,
  matchTitleLooksLike,
  oddsPortalSportSlug,
  pickBookmakerOdds,
  resolveMarketTarget,
  stripTeamPrefix,
  type SelectionColumn,
} from "./mapping";
import {
  formatLine,
  h2hPath,
  htmlToLines,
  isBlockedHtml,
  kickoffFromLines,
  matchTeamsFromLines,
  meetingDate,
  parseBookmakerTable,
  featuredMatch,
  parseH2hMeetings,
  parseLineSummary,
  parseResultsRows,
  type ResultsRow,
  parseSearchCandidates,
  tableToOddsRows,
  teamSegmentsFromLinks,
  type TeamSegment,
} from "./parseHtml";
import { MIN_TEAM_SIMILARITY, teamAlias, teamSimilarity } from "../teamMatch";

const BASE = "https://www.oddsportal.com";
/** Väntan efter ett klick innan sidan läses — OddsPortal laddar oddsen i efterhand. */
const SETTLE_MS = 2500;
const TABS = { wait: { waitSelector: "li.tab-item, li.odds-item", timeoutMs: 15_000 } } as const;

export interface ScrapeBetInput {
  sport?: string | null;
  league?: string | null;
  event?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  eventAt?: Date | null;
  /** När betet lades. Efter avspark = live-spel, som inte har något closing-pris. */
  placedAt?: Date | null;
  market: string;
  marketCategory?: string | null;
  marketScope?: string | null;
  selection: string;
  selectionSide?: string | null;
  line?: number | null;
  bookmaker?: string | null;
}

export interface ScrapeClosingResult {
  ok: boolean;
  closingOdds: number | null;
  bookmakerUsed: string | null;
  matchUrl: string | null;
  provisional: boolean;
  code?: string;
  detail: string;
}

export type OddsRow = {
  bookmaker: string;
  home?: number;
  draw?: number;
  away?: number;
  over?: number;
  under?: number;
  odds?: number;
};

export interface BatchScrapeItem {
  id: string;
  input: ScrapeBetInput;
}

export interface BatchScrapeResult {
  id: string;
  result: ScrapeClosingResult;
}

export interface SearchCandidate {
  href: string;
  title: string;
  dateText: string;
}

let scrapeChain: Promise<unknown> = Promise.resolve();

/** En hämtning i taget — aldrig två webbläsare parallellt. */
export function withScrapeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = scrapeChain.then(fn, fn);
  scrapeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function pickColumnOdds(row: OddsRow, column: SelectionColumn): number | null {
  if (column === "home") return row.home ?? row.odds ?? null;
  if (column === "draw") return row.draw ?? null;
  if (column === "away") return row.away ?? row.odds ?? null;
  if (column === "over") return row.over ?? row.home ?? row.odds ?? null;
  if (column === "under") return row.under ?? row.away ?? row.odds ?? null;
  return null;
}

export function pickOuLine(
  lines: { line: number; over: number; under: number }[],
  want: number | null
): { line: number; over: number; under: number } | null {
  if (!lines.length) return null;
  if (want == null) return lines[0];
  let best = lines[0];
  let bestDiff = Math.abs(best.line - want);
  for (let i = 1; i < lines.length; i++) {
    const d = Math.abs(lines[i].line - want);
    if (d < bestDiff) {
      best = lines[i];
      bestDiff = d;
    }
  }
  return bestDiff <= 0.01 ? best : bestDiff <= 0.26 ? best : null;
}

function fail(code: ScrapeClosingResult["code"], detail: string, matchUrl: string | null = null): ScrapeClosingResult {
  return { ok: false, closingOdds: null, bookmakerUsed: null, matchUrl, provisional: false, code, detail };
}

/** Rätt flik och linje för betet — eller varför det inte går att hämta. */
export function planMarket(input: ScrapeBetInput):
  | { ok: true; kind: "1x2" | "ou" | "ah"; tabs: string[]; lineLabel: string | null; line: number | null; column: ReturnType<typeof resolveMarketTarget>["column"] }
  | { ok: false; detail: string } {
  const target = resolveMarketTarget(input);
  if (target.isProp || input.marketScope === "player") {
    return { ok: false, detail: "Props hämtas inte från OddsPortal — ange closing manuellt." };
  }
  // resolveMarketTarget gör en "totals" om hörnor till mål-O/U; OddsPortals
  // Over/Under-flik är MÅL, så statistikmarknader och lagtotaler tas inte här.
  const what = `${input.marketCategory ?? ""} ${input.selection}`;
  if (target.tabLabels.some((t) => /corner|card|booking/i.test(t)) || /hörn|horn|corner|kort|card|skott|shot|offside|frispark|räddning|save/i.test(what)) {
    return { ok: false, detail: "Hörnor/kort/skott finns inte som egen marknad på OddsPortal — ange closing manuellt." };
  }
  // Esport har bara matchvinnare (Home/Away) på OddsPortal — inga kart-handikapp eller totaler.
  if (oddsPortalSportSlug(input.sport, input.league) === "esports" && target.tabLabels[0] !== "Home/Away") {
    return { ok: false, detail: "Esport har bara matchvinnare på OddsPortal — ange closing manuellt." };
  }
  if (input.marketScope === "team") {
    return { ok: false, detail: "Lagtotaler finns inte på OddsPortals Over/Under-flik — ange closing manuellt." };
  }
  if (target.column === "over" || target.column === "under") {
    // Utan linje går det inte att välja rad — sidans första linje (ofta 0,5) blir fel.
    const line = target.line ?? ouLineFromSelection(input.selection);
    if (line == null) return { ok: false, detail: "Över/under utan linje." };
    return { ok: true, kind: "ou", tabs: ["Over/Under", "Over Under", "Totals"], lineLabel: `Over/Under ${formatLine(line, true)}`, line, column: target.column };
  }
  if (target.tabLabels.includes("Asian Handicap")) {
    // Linjen saknas ibland i fältet men står i valet: "Arsenal -1.5".
    const line = target.line ?? lineFromSelection(input.selection);
    if (line == null) return { ok: false, detail: "Handikapp utan linje." };
    // OddsPortal anger linjen från hemmalagets håll.
    const homeLine = target.column === "away" ? -line : line;
    return {
      ok: true,
      kind: "ah",
      tabs: target.tabLabels,
      lineLabel: `Asian Handicap ${formatLine(homeLine, true)}`,
      line: homeLine,
      column: target.column,
    };
  }
  return { ok: true, kind: "1x2", tabs: target.tabLabels, lineLabel: null, line: null, column: target.column };
}

/**
 * Closing-oddset ur matchsidans text (efter att fliken och linjen klickats
 * fram). Ren funktion — testas mot fångade sidor i tests/fixtures/oddsportal.
 */
export function closingFromLines(
  lines: string[],
  plan: Extract<ReturnType<typeof planMarket>, { ok: true }>,
  input: ScrapeBetInput,
  matchUrl: string
): ScrapeClosingResult {
  const provisional = input.eventAt != null ? input.eventAt.getTime() > Date.now() : false;
  const table = parseBookmakerTable(lines);
  let rows = table ? tableToOddsRows(table) : [];
  // En linjemarknad: bara bolagens rader för just den linjen.
  if (plan.kind !== "1x2" && plan.line != null) rows = rows.filter((r) => r.line === plan.line);

  const flat = rows
    .map((r) => {
      const odds = pickColumnOdds(r, plan.column);
      return odds != null ? { bookmaker: r.bookmaker, odds } : null;
    })
    .filter((r): r is { bookmaker: string; odds: number } => r != null);
  const picked = pickBookmakerOdds(flat, input.bookmaker);
  if (picked) {
    const what = plan.kind === "1x2" ? "" : `${plan.kind === "ou" ? "OU" : "AH"} ${plan.line} ${plan.column} `;
    return {
      ok: true,
      closingOdds: picked.row.odds,
      bookmakerUsed: picked.matchedAs,
      matchUrl,
      provisional,
      detail: provisional
        ? `Live-odds ${what}${picked.row.odds.toFixed(2)} från ${picked.matchedAs} (match ej startad — ej slutgiltig closing).`
        : `Closing ${what}${picked.row.odds.toFixed(2)} från ${picked.matchedAs} via OddsPortal.`,
    };
  }

  // Ingen bolagsrad för linjen: OddsPortals snitt för linjen.
  if (plan.kind === "ou") {
    const summary = parseLineSummary(lines, "Over/Under").map((s) => ({ line: s.line, over: s.first, under: s.second }));
    const line = pickOuLine(summary, plan.line);
    if (line && (plan.line == null || line.line === plan.line)) {
      const odds = plan.column === "under" ? line.under : line.over;
      return {
        ok: true,
        closingOdds: odds,
        bookmakerUsed: "OddsPortal avg",
        matchUrl,
        provisional,
        detail: `${provisional ? "Live" : "Closing"} OU ${line.line} ${plan.column} ${odds.toFixed(2)} (OddsPortal-snitt).`,
      };
    }
    return fail("odds_not_found", plan.line != null ? `Hittade Over/Under men inte linjen ${plan.line}.` : "Ingen Over/Under-tabell.", matchUrl);
  }
  return fail("odds_not_found", "Inga bookmaker-odds i sidans tabell.", matchUrl);
}

/** Högst så här många lagpar provas på h2h-sidor (namnet kan träffa t.ex. damlaget också). */
const MAX_H2H_PAIRS = 4;
/** Ett möte räknas som bettets match om datumet ligger så här nära eventAt. */
const MEETING_WINDOW_MS = 2 * 86_400_000;

/**
 * Ligornas sidor på OddsPortal. Resultatsidan (…/results/) har h2h-länkar
 * till varje spelad match och därmed alla lagens id:n — bättre än söket,
 * som bara visar kommande matcher, saknar NHL och blandar in damlag.
 * Nycklarna är liganamn i gemener som de står på betten.
 */
const LEAGUE_PAGES: Record<string, string> = {
  "premier league": "/football/england/premier-league/",
  epl: "/football/england/premier-league/",
  championship: "/football/england/championship/",
  "fa cup": "/football/england/fa-cup/",
  "la liga": "/football/spain/laliga/",
  laliga: "/football/spain/laliga/",
  "serie a": "/football/italy/serie-a/",
  bundesliga: "/football/germany/bundesliga/",
  "ligue 1": "/football/france/ligue-1/",
  "champions league": "/football/europe/champions-league/",
  "europa league": "/football/europe/europa-league/",
  allsvenskan: "/football/sweden/allsvenskan/",
  superettan: "/football/sweden/superettan/",
  nhl: "/hockey/usa/nhl/",
  nba: "/basketball/usa/nba/",
  wnba: "/basketball/usa/wnba/",
  nfl: "/american-football/usa/nfl/",
  mlb: "/baseball/usa/mlb/",
  eredivisie: "/football/netherlands/eredivisie/",
  "liga portugal": "/football/portugal/liga-portugal/",
  "primeira liga": "/football/portugal/liga-portugal/",
  "jupiler": "/football/belgium/jupiler-pro-league/",
  "belgian pro league": "/football/belgium/jupiler-pro-league/",
  superligaen: "/football/denmark/superliga/",
  "danish superliga": "/football/denmark/superliga/",
  eliteserien: "/football/norway/eliteserien/",
  veikkausliiga: "/football/finland/veikkausliiga/",
  "scottish premiership": "/football/scotland/premiership/",
  mls: "/football/usa/mls/",
  "liga mx": "/football/mexico/liga-mx/",
  brasileirao: "/football/brazil/serie-a-betano/",
  "brasileirão": "/football/brazil/serie-a-betano/",
  "liga profesional": "/football/argentina/liga-profesional/",
  "2. bundesliga": "/football/germany/2-bundesliga/",
  "ligue 2": "/football/france/ligue-2/",
  "laliga 2": "/football/spain/laliga2/",
  "segunda division": "/football/spain/laliga2/",
  "serie b": "/football/italy/serie-b/",
  "conference league": "/football/europe/conference-league/",
  "nations league": "/football/europe/uefa-nations-league/",
  "swiss super league": "/football/switzerland/super-league/",
  "austrian bundesliga": "/football/austria/bundesliga/",
  "league one": "/football/england/league-one/",
  shl: "/hockey/sweden/shl/",
  hockeyallsvenskan: "/hockey/sweden/hockeyallsvenskan/",
  liiga: "/hockey/finland/liiga/",
  euroleague: "/basketball/europe/euroleague/",
  "vm 2026": "/football/world/world-championship-2026/",
  "world cup 2026": "/football/world/world-championship-2026/",
  "fifa world cup": "/football/world/world-championship-2026/",
};

/** Ligans resultatsida, eller null för ligor som inte står i listan. */
export function leagueResultsPath(league: string | null | undefined): string | null {
  const base = leagueBase(league);
  return base ? `${base}results/` : null;
}

function leagueBase(league: string | null | undefined): string | null {
  const l = (league ?? "").trim().toLowerCase();
  if (!l) return null;
  // Längsta träffen vinner: "WNBA" innehåller "nba".
  const key = Object.keys(LEAGUE_PAGES)
    .filter((k) => l === k || l.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? LEAGUE_PAGES[key] : null;
}

/** Ligor vars säsong är ett kalenderår ("allsvenskan-2025"); övriga går över årsskiftet ("premier-league-2025-2026"). */
const CALENDAR_SEASONS = [
  "/football/sweden/",
  "/football/norway/",
  "/football/finland/",
  "/football/usa/mls/",
  "/football/brazil/",
  "/football/argentina/",
  "/baseball/usa/mlb/",
];
/** Turneringar utan säsonger i adressen. */
const SINGLE_EDITION = ["/football/world/world-championship-2026/"];

/**
 * Resultatsidan för säsongen ett datum hör till. Innevarande säsong har
 * ingen säsong i adressen; tidigare säsonger har ("allsvenskan-2025/results/").
 */
export function seasonResultsPath(base: string, at: Date, now: Date = new Date()): string {
  if (SINGLE_EDITION.includes(base)) return `${base}results/`;
  const calendar = CALENDAR_SEASONS.some((p) => base.startsWith(p));
  // Säsong som går över årsskiftet börjar i juli: juni 2026 hör till 2025/26.
  const season = (d: Date) => (calendar ? d.getUTCFullYear() : d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
  const y = season(at);
  if (y >= season(now)) return `${base}results/`;
  const slug = base.replace(/\/$/, "");
  return calendar ? `${slug}-${y}/results/` : `${slug}-${y}-${y + 1}/results/`;
}

/** Sidor att leta lag på när varken ligan eller söket gav dem. */
const FALLBACK_PAGES: Record<string, string[]> = {
  football: ["/football/world/world-championship-2026/results/", "/football/world/friendly-international/results/"],
};

/** Klubbsuffix OddsPortal ofta stryker ("Ipswich Town" → "Ipswich"). */
const NAME_SUFFIXES = new Set(["town", "city", "albion", "united", "utd", "fc", "fk", "sk", "if", "bk", "ff", "cf", "afc", "sc"]);

/**
 * Sökvarianter för ett lag, längst först. OddsPortal skriver ofta kortare
 * namn än kvittona ("West Brom", "Atl. Madrid", "Vasteras SK"), och söket
 * hittar bara delar av deras namn — inte deras namn i ett längre.
 */
export function searchVariants(team: string): string[] {
  const base = buildSearchQuery({ homeTeam: team });
  const words = base.split(/\s+/).filter(Boolean);
  const stripped = words.filter((w) => !NAME_SUFFIXES.has(w.toLowerCase()));
  // Ett känt alias ("NaVi" → "natus vincere") söks först: OddsPortal har bara det långa namnet.
  const out = [
    teamAlias(team) ?? "",
    base,
    stripped.join(" "),
    words.length >= 2 && words[1].length > 4 ? `${words[0]} ${words[1].slice(0, 4)}` : "",
    stripped.length >= 2 ? stripped[stripped.length - 1] : "",
    stripped[0] ?? "",
  ];
  return [...new Set(out.map((v) => v.trim()).filter((v) => v.length >= 4))];
}

/**
 * En kommande match ur sökträffarna — men bara om BÅDA lagen står i titeln
 * och datumet (när det går att läsa) stämmer. Hellre ingen träff än fel
 * match: fel closing-odds syns inte, de ser bara ut som CLV.
 */
export function pickUpcoming(candidates: SearchCandidate[], input: ScrapeBetInput): string | null {
  const at = input.eventAt;
  const hits = candidates.filter((c) => {
    if (!matchTitleLooksLike(c.title, input.homeTeam, input.awayTeam)) return false;
    if (!at) return true;
    const d = meetingDate(c.dateText.match(/^(\d{1,2}\/[A-Za-z]{3})/)?.[1] ?? "", at);
    // "Today"/"Tomorr." saknar datum — godtas bara för matcher som inte spelats än.
    return d ? Math.abs(d.getTime() - at.getTime()) <= MEETING_WINDOW_MS : at.getTime() > Date.now() - 86_400_000;
  });
  return hits.length === 1 ? hits[0].href : null;
}

/** Lagets id-delar ur sökträffarna, de som liknar lagnamnet — vanligast först. */
/** Spelet i ett esportlags id-del: "team-vitality-counter-strike-tMJZDVwo" → "counter-strike". */
const ESPORTS_GAME = /-(counter-strike|league-of-legends|dota-2|valorant|rainbow-six|overwatch|rocket-league|call-of-duty|starcraft-2|king-of-glory|mobile-legends|honor-of-kings)-[A-Za-z0-9]{8}$/;

/**
 * Esportlag finns i flera spel under samma namn (Vitality i CS och LoL).
 * Två lag från olika spel har aldrig mötts — hoppa över det paret.
 */
export function sameGame(a: string, b: string): boolean {
  const ga = a.match(ESPORTS_GAME)?.[1];
  const gb = b.match(ESPORTS_GAME)?.[1];
  return !ga || !gb || ga === gb;
}

function segmentsFor(team: string, segments: TeamSegment[]): string[] {
  const match = (name: string) => {
    const counts = new Map<string, number>();
    for (const s of segments) {
      if (teamSimilarity(name, s.name) >= MIN_TEAM_SIMILARITY) counts.set(s.segment, (counts.get(s.segment) ?? 0) + s.count);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([segment]) => segment);
  };
  // Spelbolagens förkortning ("OKC Thunder", "BKN Nets") gör namnet för olikt
  // OddsPortals ("Oklahoma City Thunder") — utan förkortningen räcker "Thunder".
  const found = match(team);
  const stripped = stripTeamPrefix(team);
  return found.length || stripped === team ? found : match(stripped);
}

/**
 * Sidor som är desamma för många bets i en körning (ligans resultatsida,
 * lagsök, h2h-sidor), sparade tolkade per worker. En körning över ett helt
 * år hämtar då Premier Leagues resultatsida en gång, inte en gång per bet.
 * Bara tolkat innehåll sparas — inte HTML:en, som är flera hundra kB per sida.
 */
interface PageMemo {
  segments: Map<string, Promise<TeamSegment[]>>;
  h2h: Map<string, Promise<H2hPage | null>>;
  results: Map<string, Promise<ResultsRow[]>>;
}
interface H2hPage {
  blocked: boolean;
  meetings: { eventId: string; dateText: string }[];
  top: { eventId: string; date: Date } | null;
}
const memos = new WeakMap<ScraplingWorker, PageMemo>();
function memoFor(worker: ScraplingWorker): PageMemo {
  let m = memos.get(worker);
  if (!m) memos.set(worker, (m = { segments: new Map(), h2h: new Map(), results: new Map() }));
  return m;
}
/**
 * Kör `load` en gång per nyckel. Ett fel, eller ett svar `keep` inte godtar
 * (tom lista, Cloudflare-spärr), sparas inte — nästa bet provar igen.
 */
function remember<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>, keep: (v: T) => boolean): Promise<T> {
  const hit = map.get(key);
  if (hit) return hit;
  const p = load();
  map.set(key, p);
  p.then(
    (v) => {
      if (!keep(v)) map.delete(key);
    },
    () => map.delete(key)
  );
  return p;
}

function leagueSegments(worker: ScraplingWorker, leaguePath: string, sport: string): Promise<TeamSegment[]> {
  return remember(memoFor(worker).segments, `league:${leaguePath}`, async () => {
    const page = await worker.fetch({ mode: "browser", url: BASE + leaguePath, actions: [{ waitMs: 2500 }] }).catch(() => null);
    return page && page.status < 400 && !isBlockedHtml(page.body) ? teamSegmentsFromLinks(page.body, sport) : [];
  }, (segs) => segs.length > 0);
}

function h2hPage(worker: ScraplingWorker, path: string): Promise<H2hPage | null> {
  return remember(memoFor(worker).h2h, path, async () => {
    const page = await worker.fetch({ mode: "browser", url: BASE + path, actions: [{ waitMs: 2500 }] }).catch(() => null);
    // Ett lagpar som aldrig mötts har ingen sida.
    if (!page || page.status >= 400) return null;
    if (isBlockedHtml(page.body)) return { blocked: true, meetings: [], top: null };
    return { blocked: false, meetings: parseH2hMeetings(page.body, path), top: featuredMatch(htmlToLines(page.body), page.url) };
  }, (page) => !page?.blocked);
}

/** En sida ur ligans resultatarkiv (50 matcher). Tom lista när sidorna tagit slut. */
function resultsPage(worker: ScraplingWorker, path: string, page: number, sport: string): Promise<ResultsRow[]> {
  const url = page === 1 ? BASE + path : `${BASE}${path}#/page/${page}/`;
  return remember(memoFor(worker).results, url, async () => {
    const res = await worker.fetch({ mode: "browser", url, actions: [{ waitMs: 2500 }] }).catch(() => null);
    return res && res.status < 400 && !isBlockedHtml(res.body) ? parseResultsRows(res.body, sport) : [];
  }, (rows) => rows.length > 0);
}

/** Högst så många arkivsidor per säsong (50 matcher styck) — en hel säsong i de flesta ligor. */
const MAX_RESULTS_PAGES = 10;

/**
 * Matchen i ligans resultatarkiv: bläddrar bakåt från nyaste sidan tills
 * bettets datum är passerat. Lagen jämförs med raderna; datumet väljs som för
 * h2h-mötena (pickMeeting). Null när ligan är okänd eller matchen inte finns.
 */
async function findInResults(worker: ScraplingWorker, input: ScrapeBetInput, sport: string, at: Date): Promise<string | null> {
  const base = leagueBase(input.league);
  if (!base || !base.startsWith(`/${sport}/`) || !input.homeTeam || !input.awayTeam) return null;
  const path = seasonResultsPath(base, at);
  const candidates: { eventId: string; d: Date }[] = [];
  const urlFor = new Map<string, string>();
  let previousFirst = "";
  for (let page = 1; page <= MAX_RESULTS_PAGES; page++) {
    const rows = await resultsPage(worker, path, page, sport);
    // Tom sida, eller samma sida igen (OddsPortal visar sista sidan för höga nummer): slut.
    if (!rows.length || rows[0].eventId === previousFirst) break;
    previousFirst = rows[0].eventId;
    for (const r of rows) {
      const names = r.segments.map((seg) => ({ segment: seg, name: seg.replace(/-[A-Za-z0-9]{8}$/, "").replace(/-/g, " "), count: 1 }));
      if (segmentsFor(input.homeTeam, names).length && segmentsFor(input.awayTeam, names).length) {
        const [h] = segmentsFor(input.homeTeam, names);
        const [a] = segmentsFor(input.awayTeam, names);
        if (h === a) continue;
        candidates.push({ eventId: r.eventId, d: r.date });
        urlFor.set(r.eventId, `${BASE}${r.path}#${r.eventId}`);
      }
    }
    // Sidorna går bakåt i tiden: när sidans äldsta match är äldre än bettet finns inget mer att hämta.
    if (rows[rows.length - 1].date.getTime() < at.getTime() - MEETING_WINDOW_MS) break;
  }
  const best = pickMeeting(candidates, at, input.placedAt ?? null);
  return best ? urlFor.get(best) ?? null : null;
}

function searchTeam(worker: ScraplingWorker, team: string, sport: string): Promise<TeamSegment[]> {
  return remember(memoFor(worker).segments, `search:${sport}:${team.toLowerCase()}`, () => searchTeamUncached(worker, team, sport), (segs) => segs.length > 0);
}

/** Söker tills laget dyker upp i träffarnas länkar; ger dess id-delar. */
async function searchTeamUncached(worker: ScraplingWorker, team: string, sport: string): Promise<TeamSegment[]> {
  for (const q of searchVariants(team).slice(0, 3)) {
    const res = await worker.fetch({
      mode: "browser",
      url: `${BASE}/search/${encodeURIComponent(q)}/`,
      actions: [{ waitSelector: "a[href*='/h2h/']", timeoutMs: 10_000 }, { waitMs: 600 }],
    });
    if (isBlockedHtml(res.body)) return [];
    const segs = teamSegmentsFromLinks(res.body, sport);
    if (segmentsFor(team, segs).length) return segs;
  }
  return [];
}

/**
 * En spelad match via lagparets h2h-sida: mötet (eller sidans toppmatch)
 * närmast bettets datum, inom två dygn. Lagens id:n tas från ligans
 * resultatsida när ligan är känd, annars från söket.
 */
async function findPlayedMatch(worker: ScraplingWorker, input: ScrapeBetInput, sport: string): Promise<string | null> {
  const at = input.eventAt;
  if (!at || !input.homeTeam || !input.awayTeam) return null;
  // Ligans resultatarkiv har varje spelad match. h2h-sidan listar tidigare möten
  // bara när lagen har en kommande match — annars bara det senaste mötet.
  const archived = await findInResults(worker, input, sport, at);
  if (archived) return archived;
  const segments: TeamSegment[] = [];
  const leaguePath = leagueResultsPath(input.league);
  if (leaguePath && leaguePath.startsWith(`/${sport}/`)) segments.push(...(await leagueSegments(worker, leaguePath, sport)));
  for (const team of [input.homeTeam, input.awayTeam]) {
    if (!segmentsFor(team, segments).length) segments.push(...(await searchTeam(worker, team, sport)));
  }
  // Landslag utan kommande match syns inte i söket. VM-sidan har alla
  // VM-nationer, vänskapslandskamperna de som spelat nyligen.
  for (const page of FALLBACK_PAGES[sport] ?? []) {
    if (segmentsFor(input.homeTeam, segments).length && segmentsFor(input.awayTeam, segments).length) break;
    segments.push(...(await leagueSegments(worker, page, sport)));
  }
  const homes = segmentsFor(input.homeTeam, segments);
  const aways = segmentsFor(input.awayTeam, segments);
  const pairs = homes
    .flatMap((h) => aways.filter((a) => a !== h && sameGame(h, a)).map((a) => h2hPath(sport, h, a)))
    .slice(0, MAX_H2H_PAIRS);
  for (const path of [...new Set(pairs)]) {
    // Ett lagpar som aldrig mötts har ingen sida — prova nästa i stället för att ge upp.
    const page = await h2hPage(worker, path);
    if (!page) continue;
    if (page.blocked) return null;
    const candidates = page.meetings
      .map((m) => ({ eventId: m.eventId, d: meetingDate(m.dateText, at) }))
      .filter((x): x is { eventId: string; d: Date } => x.d !== null);
    if (page.top) candidates.push({ eventId: page.top.eventId, d: page.top.date });
    const best = pickMeeting(candidates, at, input.placedAt ?? null);
    if (best) return `${BASE}${path}#${best}`;
  }
  return null;
}

/** Hur långt efter läggningen matchen får ligga när betet bara har ett datum. */
const PLACED_AHEAD_MS = 21 * 86_400_000;

/**
 * Mötet bettet gäller. Först det närmast bettets datum, inom två dygn. Har
 * datumet ingen tid (00:00) är det ofta läggningsdagen från kvittot, inte
 * matchdagen — då det första mötet efter att betet lades, inom tre veckor.
 */
export function pickMeeting(candidates: { eventId: string; d: Date }[], at: Date, placedAt: Date | null): string | null {
  const near = candidates
    .filter((x) => Math.abs(x.d.getTime() - at.getTime()) <= MEETING_WINDOW_MS)
    .sort((a, b) => Math.abs(a.d.getTime() - at.getTime()) - Math.abs(b.d.getTime() - at.getTime()))[0];
  if (near) return near.eventId;
  if (at.getHours() !== 0 || at.getMinutes() !== 0) return null;
  // Mötesdatumen är hela dagar (kl. 12 UTC): räkna från läggningsdagens början.
  const from = (placedAt ?? at).getTime() - 86_400_000;
  const next = candidates
    .filter((x) => x.d.getTime() >= from && x.d.getTime() <= from + PLACED_AHEAD_MS)
    .sort((a, b) => a.d.getTime() - b.d.getTime())[0];
  return next?.eventId ?? null;
}

export async function scrapeClosingWith(worker: ScraplingWorker, input: ScrapeBetInput): Promise<ScrapeClosingResult> {
  const plan = planMarket(input);
  if (!plan.ok) return fail("market_not_found", plan.detail);

  const sport = oddsPortalSportSlug(input.sport, input.league);
  const home = buildSearchQuery({ homeTeam: input.homeTeam });
  const away = buildSearchQuery({ homeTeam: input.awayTeam });
  // "Brasilien v Marocko / Australien v Turkiet": ett spel på flera matcher.
  if (/\s\/\s/.test(input.event ?? "")) return fail("missing_fields", "Spelet gäller flera matcher — inget closing-pris för en enskild match.");
  if (home.length < 2 || away.length < 2) {
    return fail("missing_fields", "Saknar hemma- och bortalag (homeTeam/awayTeam eller \"Hemma - Borta\" i event).");
  }

  // OddsPortals sök (okt 2026) visar bara kommande matcher och svarar inte på
  // två lagnamn i samma fråga. Spelade matcher nås via lagparets h2h-sida
  // (findPlayedMatch); kommande väljs ur söket på vart lag för sig.
  let url: string | null = null;
  if (input.eventAt && input.eventAt.getTime() < Date.now()) {
    url = await findPlayedMatch(worker, input, sport);
  } else {
    for (const q of [home, away]) {
      const search = await worker.fetch({
        mode: "browser",
        url: `${BASE}/search/${encodeURIComponent(q)}/`,
        actions: [{ waitSelector: "a[href*='/h2h/'], .eventRow a[href]", timeoutMs: 12_000 }, { waitMs: 800 }],
      });
      if (isBlockedHtml(search.body)) return fail("blocked", "OddsPortal blockerade (Cloudflare).");
      url = pickUpcoming(parseSearchCandidates(search.body, sport), input);
      if (url) break;
    }
  }
  if (!url) {
    return fail("match_not_found", `Hittade ingen OddsPortal-match för ${home}–${away} (${sport}) nära ${input.eventAt?.toISOString().slice(0, 10) ?? "okänt datum"}.`);
  }
  const found = { url };

  const page = await worker.fetch({ mode: "browser", url: found.url, actions: marketActions(plan, input) });
  if (isBlockedHtml(page.body)) return fail("blocked", "OddsPortal blockerade (Cloudflare).", found.url);
  let lines = htmlToLines(page.body);
  const live = liveBetDetail(input.placedAt, kickoffFromLines(lines));
  if (live) return fail("live_bet", live, found.url);

  // Loggat i omvänd ordning ("Leeds - Arsenal" när Arsenal spelade hemma):
  // vänd betet så att "hemma" och handikappets tecken följer OddsPortal.
  if (isSwapped(input, matchTeamsFromLines(lines))) {
    const turned = swapSides(input);
    const turnedPlan = planMarket(turned);
    if (!turnedPlan.ok) return fail("market_not_found", turnedPlan.detail, found.url);
    if (turnedPlan.lineLabel !== plan.lineLabel) {
      const again = await worker.fetch({ mode: "browser", url: found.url, actions: marketActions(turnedPlan, turned) });
      if (isBlockedHtml(again.body)) return fail("blocked", "OddsPortal blockerade (Cloudflare).", found.url);
      lines = htmlToLines(again.body);
    }
    const r = closingFromLines(lines, turnedPlan, turned, found.url);
    return r.ok ? { ...r, detail: `${r.detail} (lagen står i omvänd ordning i loggen)` } : r;
  }
  return closingFromLines(lines, plan, input, found.url);
}

type Plan = Extract<ReturnType<typeof planMarket>, { ok: true }>;

/** "Över 2.5", "Under 3,5 mål" → linjen. Null utan över/under och ett tal. */
export function ouLineFromSelection(selection: string | null | undefined): number | null {
  // Inte \b: den räknar inte "ö" som en bokstav, så "Över" skulle missas.
  const m = (selection ?? "").match(/(?:^|[^a-zåäö])(?:över|over|under|o|u)\s*(\d+(?:[.,]\d+)?)/i);
  return m ? Number(m[1].replace(",", ".")) : null;
}

/** "Arsenal -1.5" / "Leeds +0,25" → linjen. Null utan ett tecken framför talet. */
export function lineFromSelection(selection: string | null | undefined): number | null {
  const m = (selection ?? "").match(/(?:^|[\s(])([+-]\d+(?:[.,]\d+)?)(?:[\s)]|$)/);
  return m ? Number(m[1].replace(",", ".")) : null;
}

/** Klicken som tar fram betets flik och linje på matchsidan. */
function marketActions(plan: Plan, input: ScrapeBetInput): NonNullable<Parameters<ScraplingWorker["fetch"]>[0]["actions"]> {
  const actions: NonNullable<Parameters<ScraplingWorker["fetch"]>[0]["actions"]> = [TABS.wait];
  // Fotbollens matchsida öppnar på 1X2; allt annat (BTTS, linjer, andra sporter) kräver ett klick.
  if (plan.tabs[0] !== "1X2" || input.sport?.toLowerCase() !== "football") {
    actions.push({ clickFirst: plan.tabs }, { waitMs: SETTLE_MS });
  }
  if (plan.lineLabel) actions.push({ clickText: plan.lineLabel }, { waitMs: SETTLE_MS });
  return actions;
}

/** Bettets hemmalag är sidans bortalag och tvärtom. */
export function isSwapped(input: ScrapeBetInput, page: { home: string; away: string } | null): boolean {
  if (!page || !input.homeTeam || !input.awayTeam) return false;
  const home = stripTeamPrefix(input.homeTeam);
  const away = stripTeamPrefix(input.awayTeam);
  const straight = teamSimilarity(home, page.home) + teamSimilarity(away, page.away);
  const turned = teamSimilarity(home, page.away) + teamSimilarity(away, page.home);
  return turned > straight && teamSimilarity(home, page.away) >= MIN_TEAM_SIMILARITY && teamSimilarity(away, page.home) >= MIN_TEAM_SIMILARITY;
}

/** Samma bet med lagen bytta: spelet gäller fortfarande samma lag. */
export function swapSides(input: ScrapeBetInput): ScrapeBetInput {
  const side = input.selectionSide === "home" ? "away" : input.selectionSide === "away" ? "home" : input.selectionSide;
  return { ...input, homeTeam: input.awayTeam, awayTeam: input.homeTeam, selectionSide: side };
}

/** Minuter efter avspark som ännu räknas som före matchen (klockor, avrundning). */
const LIVE_GRACE_MS = 2 * 60_000;

/**
 * Lagt efter avspark: oddsen sattes under matchen och kan inte jämföras med
 * closing. Null när betet lades före, eller när en av tiderna saknas.
 */
export function liveBetDetail(placedAt: Date | null | undefined, kickoff: Date | null): string | null {
  if (!placedAt || !kickoff || placedAt.getTime() <= kickoff.getTime() + LIVE_GRACE_MS) return null;
  const hhmm = (d: Date) => d.toTimeString().slice(0, 5);
  return `Live-spel (lagt ${hhmm(placedAt)}, avspark ${hhmm(kickoff)}) — closing-odds gäller inte live, ingen CLV.`;
}

/** Ett bet med en egen webbläsare — för knappen "Hämta CLV" i appen. */
export async function scrapeClosingForBet(input: ScrapeBetInput): Promise<ScrapeClosingResult> {
  return withScrapeLock(async () => {
    const worker = new ScraplingWorker({});
    try {
      return await scrapeClosingWith(worker, input);
    } catch (e) {
      return fail("browser_error", e instanceof Error ? e.message : String(e));
    } finally {
      await worker.close();
    }
  });
}

/** Många bets med en och samma webbläsare, i tur och ordning. */
export async function scrapeClosingBatch(
  items: BatchScrapeItem[],
  opts: {
    pauseMs?: number;
    worker?: ScraplingWorker;
    /** Efter varje bet, innan nästa hämtas — för att spara och visa framsteg medan körningen pågår. */
    onResult?: (row: BatchScrapeResult, index: number, total: number) => Promise<void> | void;
  } = {}
): Promise<BatchScrapeResult[]> {
  if (items.length === 0) return [];
  return withScrapeLock(async () => {
    const worker = opts.worker ?? new ScraplingWorker({});
    const pauseMs = opts.pauseMs ?? 1200;
    const out: BatchScrapeResult[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let result: ScrapeClosingResult;
        try {
          result = await scrapeClosingWith(worker, item.input);
        } catch (e) {
          result = fail("browser_error", e instanceof Error ? e.message : String(e));
        }
        out.push({ id: item.id, result });
        await opts.onResult?.({ id: item.id, result }, i, items.length);
        if (i < items.length - 1 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
      }
    } finally {
      if (!opts.worker) await worker.close();
    }
    return out;
  });
}
