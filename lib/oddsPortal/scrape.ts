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
import { buildSearchQuery, matchTitleLooksLike, oddsPortalSportSlug, pickBookmakerOdds, resolveMarketTarget, type SelectionColumn } from "./mapping";
import {
  formatLine,
  h2hPath,
  htmlToLines,
  isBlockedHtml,
  kickoffFromLines,
  meetingDate,
  parseBookmakerTable,
  featuredMatch,
  parseH2hMeetings,
  parseLineSummary,
  parseSearchCandidates,
  tableToOddsRows,
  teamSegmentsFromLinks,
  type TeamSegment,
} from "./parseHtml";
import { MIN_TEAM_SIMILARITY, teamSimilarity } from "../teamMatch";

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
  if (input.marketScope === "team") {
    return { ok: false, detail: "Lagtotaler finns inte på OddsPortals Over/Under-flik — ange closing manuellt." };
  }
  if (target.column === "over" || target.column === "under") {
    const label = target.line != null ? `Over/Under ${formatLine(target.line, true)}` : null;
    return { ok: true, kind: "ou", tabs: ["Over/Under", "Over Under", "Totals"], lineLabel: label, line: target.line, column: target.column };
  }
  if (target.tabLabels.includes("Asian Handicap")) {
    if (target.line == null) return { ok: false, detail: "Handikapp utan linje." };
    // OddsPortal anger linjen från hemmalagets håll.
    const homeLine = target.column === "away" ? -target.line : target.line;
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
};

/** Ligans resultatsida, eller null för ligor som inte står i listan. */
export function leagueResultsPath(league: string | null | undefined): string | null {
  const l = (league ?? "").trim().toLowerCase();
  if (!l) return null;
  const key = Object.keys(LEAGUE_PAGES).find((k) => l === k || l.includes(k));
  return key ? `${LEAGUE_PAGES[key]}results/` : null;
}

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
  const out = [
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
function segmentsFor(team: string, segments: TeamSegment[]): string[] {
  const counts = new Map<string, number>();
  for (const s of segments) {
    if (teamSimilarity(team, s.name) >= MIN_TEAM_SIMILARITY) counts.set(s.segment, (counts.get(s.segment) ?? 0) + s.count);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([segment]) => segment);
}

/** Söker tills laget dyker upp i träffarnas länkar; ger dess id-delar. */
async function searchTeam(worker: ScraplingWorker, team: string, sport: string): Promise<TeamSegment[]> {
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
  const segments: TeamSegment[] = [];
  const leaguePath = leagueResultsPath(input.league);
  if (leaguePath && leaguePath.startsWith(`/${sport}/`)) {
    const page = await worker.fetch({ mode: "browser", url: BASE + leaguePath, actions: [{ waitMs: 2500 }] }).catch(() => null);
    if (page && page.status < 400 && !isBlockedHtml(page.body)) segments.push(...teamSegmentsFromLinks(page.body, sport));
  }
  for (const team of [input.homeTeam, input.awayTeam]) {
    if (!segmentsFor(team, segments).length) segments.push(...(await searchTeam(worker, team, sport)));
  }
  const homes = segmentsFor(input.homeTeam, segments);
  const aways = segmentsFor(input.awayTeam, segments);
  const pairs = homes.flatMap((h) => aways.filter((a) => a !== h).map((a) => h2hPath(sport, h, a))).slice(0, MAX_H2H_PAIRS);
  for (const path of [...new Set(pairs)]) {
    // Ett lagpar som aldrig mötts har ingen sida — prova nästa i stället för att ge upp.
    const page = await worker.fetch({ mode: "browser", url: BASE + path, actions: [{ waitMs: 2500 }] }).catch(() => null);
    if (!page || page.status >= 400) continue;
    if (isBlockedHtml(page.body)) return null;
    const candidates = parseH2hMeetings(page.body, path)
      .map((m) => ({ eventId: m.eventId, d: meetingDate(m.dateText, at) }))
      .filter((x): x is { eventId: string; d: Date } => x.d !== null);
    const top = featuredMatch(htmlToLines(page.body), page.url);
    if (top) candidates.push({ eventId: top.eventId, d: top.date });
    const best = candidates
      .filter((x) => Math.abs(x.d.getTime() - at.getTime()) <= MEETING_WINDOW_MS)
      .sort((a, b) => Math.abs(a.d.getTime() - at.getTime()) - Math.abs(b.d.getTime() - at.getTime()))[0];
    if (best) return `${BASE}${path}#${best.eventId}`;
  }
  return null;
}

export async function scrapeClosingWith(worker: ScraplingWorker, input: ScrapeBetInput): Promise<ScrapeClosingResult> {
  const plan = planMarket(input);
  if (!plan.ok) return fail("market_not_found", plan.detail);

  const sport = oddsPortalSportSlug(input.sport, input.league);
  const home = buildSearchQuery({ homeTeam: input.homeTeam });
  const away = buildSearchQuery({ homeTeam: input.awayTeam });
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

  const actions: NonNullable<Parameters<ScraplingWorker["fetch"]>[0]["actions"]> = [TABS.wait];
  if (plan.kind !== "1x2" || input.sport?.toLowerCase() !== "football") {
    actions.push({ clickFirst: plan.tabs }, { waitMs: SETTLE_MS });
  }
  if (plan.lineLabel) actions.push({ clickText: plan.lineLabel }, { waitMs: SETTLE_MS });
  const page = await worker.fetch({ mode: "browser", url: found.url, actions });
  if (isBlockedHtml(page.body)) return fail("blocked", "OddsPortal blockerade (Cloudflare).", found.url);
  const lines = htmlToLines(page.body);
  const live = liveBetDetail(input.placedAt, kickoffFromLines(lines));
  if (live) return fail("live_bet", live, found.url);
  return closingFromLines(lines, plan, input, found.url);
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
  opts: { pauseMs?: number; worker?: ScraplingWorker } = {}
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
        if (i < items.length - 1 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
      }
    } finally {
      if (!opts.worker) await worker.close();
    }
    return out;
  });
}
