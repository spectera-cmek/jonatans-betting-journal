// OddsPortal via Scrapling — experimentet bakom `scrape:clv -- --scrapling`.
// Playwright-vägen (scrape.ts) är fortfarande standard; `--compare` kör båda
// på samma bets så att de kan jämföras innan något byts.
//
// Samma flöde som scrapeClosingForBet: sök matchen, öppna rätt flik, klicka
// fram linjen och välj bolag. Skillnaden är att Scrapling hämtar sidan (och
// gör klicken) och att tolkningen sker på den sparade HTML:en (parseHtml.ts).
// Klickar man fram en linje syns oddsen PER BOLAG, så O/U-closing kan tas från
// bettets bolag/Pinnacle i stället för OddsPortals snitt.
//
// Hanterar h2h/1X2, Over/Under och Asian Handicap. Props, hörnor och kort
// finns inte på OddsPortal på ett sätt som går att lita på — de svarar
// market_not_found.

import { ScraplingWorker } from "../scrapling";
import { buildSearchQuery, matchTitleLooksLike, oddsPortalSportSlug, pickBookmakerOdds, resolveMarketTarget } from "./mapping";
import {
  formatLine,
  h2hPath,
  htmlToLines,
  isBlockedHtml,
  meetingDate,
  parseBookmakerTable,
  parseH2hMeetings,
  parseLineSummary,
  parseSearchCandidates,
  tableToOddsRows,
  teamSegmentsFromLinks,
  type H2hMeeting,
  type TeamSegment,
} from "./parseHtml";
import { MIN_TEAM_SIMILARITY, teamSimilarity } from "../teamMatch";
import {
  pickColumnOdds,
  pickOuLine,
  type BatchScrapeItem,
  type BatchScrapeResult,
  type ScrapeBetInput,
  type ScrapeClosingResult,
  type SearchCandidate,
} from "./scrape";

const BASE = "https://www.oddsportal.com";
/** Väntan efter ett klick innan sidan läses — OddsPortal laddar oddsen i efterhand. */
const SETTLE_MS = 2500;
const TABS = { wait: { waitSelector: "li.tab-item, li.odds-item", timeoutMs: 15_000 } } as const;

function fail(code: ScrapeClosingResult["code"], detail: string, matchUrl: string | null = null): ScrapeClosingResult {
  return { ok: false, closingOdds: null, bookmakerUsed: null, matchUrl, provisional: false, code, detail };
}

/** Rätt flik och linje för betet — eller varför Scrapling-vägen inte tar det. */
export function planMarket(input: ScrapeBetInput):
  | { ok: true; kind: "1x2" | "ou" | "ah"; tabs: string[]; lineLabel: string | null; line: number | null; column: ReturnType<typeof resolveMarketTarget>["column"] }
  | { ok: false; detail: string } {
  const target = resolveMarketTarget(input);
  if (target.isProp || input.marketScope === "player") {
    return { ok: false, detail: "Props hanteras inte av Scrapling-vägen — ange closing manuellt." };
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
        : `Closing ${what}${picked.row.odds.toFixed(2)} från ${picked.matchedAs} via OddsPortal (Scrapling).`,
    };
  }

  // Ingen bolagsrad för linjen: OddsPortals snitt för linjen, som Playwright-vägen.
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
        detail: `${provisional ? "Live" : "Closing"} OU ${line.line} ${plan.column} ${odds.toFixed(2)} (OddsPortal-snitt, Scrapling).`,
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

/**
 * En spelad match via lagparets h2h-sida: mötet närmast bettets datum
 * (inom två dygn). Null om inget lagpar har ett sådant möte.
 */
async function findPlayedMatch(
  worker: ScraplingWorker,
  input: ScrapeBetInput,
  sport: string,
  searchPages: string[]
): Promise<string | null> {
  const at = input.eventAt;
  if (!at || !input.homeTeam || !input.awayTeam) return null;
  const segments = searchPages.flatMap((html) => teamSegmentsFromLinks(html, sport));
  const homes = [...new Set(segmentsFor(input.homeTeam, segments))];
  const aways = [...new Set(segmentsFor(input.awayTeam, segments))];
  const pairs = homes.flatMap((h) => aways.filter((a) => a !== h).map((a) => h2hPath(sport, h, a))).slice(0, MAX_H2H_PAIRS);
  for (const path of [...new Set(pairs)]) {
    // Ett lagpar som aldrig mötts har ingen sida — prova nästa i stället för att ge upp.
    const page = await worker.fetch({ mode: "browser", url: BASE + path, actions: [{ waitMs: 2500 }] }).catch(() => null);
    if (!page || page.status >= 400) continue;
    if (isBlockedHtml(page.body)) return null;
    const meetings = parseH2hMeetings(page.body, path)
      .map((m) => ({ m, d: meetingDate(m.dateText, at) }))
      .filter((x): x is { m: H2hMeeting; d: Date } => x.d !== null && Math.abs(x.d.getTime() - at.getTime()) <= MEETING_WINDOW_MS)
      .sort((a, b) => Math.abs(a.d.getTime() - at.getTime()) - Math.abs(b.d.getTime() - at.getTime()));
    if (meetings[0]) return `${BASE}${path}#${meetings[0].m.eventId}`;
  }
  return null;
}

export async function scrapeClosingForBetScrapling(worker: ScraplingWorker, input: ScrapeBetInput): Promise<ScrapeClosingResult> {
  const plan = planMarket(input);
  if (!plan.ok) return fail("market_not_found", plan.detail);

  const sport = oddsPortalSportSlug(input.sport, input.league);
  const home = buildSearchQuery({ homeTeam: input.homeTeam });
  const away = buildSearchQuery({ homeTeam: input.awayTeam });
  if (home.length < 2 || away.length < 2) {
    return fail("missing_fields", "Saknar hemma- och bortalag (homeTeam/awayTeam eller \"Hemma - Borta\" i event).");
  }

  // OddsPortals sök (okt 2026) svarar inte på två lagnamn i samma fråga och
  // visar bara kommande matcher. Varje lag söks för sig: kommande matcher
  // väljs direkt ur träffarna, spelade nås via lagparets h2h-sida (lagens
  // id:n står i träffarnas länkar).
  const pages: string[] = [];
  let url: string | null = null;
  for (const q of [home, away]) {
    const search = await worker.fetch({
      mode: "browser",
      url: `${BASE}/search/${encodeURIComponent(q)}/`,
      actions: [{ waitSelector: "a[href*='/h2h/'], .eventRow a[href]", timeoutMs: 12_000 }, { waitMs: 800 }],
    });
    if (isBlockedHtml(search.body)) return fail("blocked", "OddsPortal blockerade (Cloudflare).");
    pages.push(search.body);
    url = pickUpcoming(parseSearchCandidates(search.body, sport), input);
    if (url) break;
  }
  if (!url && input.eventAt && input.eventAt.getTime() < Date.now()) {
    url = await findPlayedMatch(worker, input, sport, pages);
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
  return closingFromLines(htmlToLines(page.body), plan, input, found.url);
}

/** Många bets med en och samma webbläsare, i tur och ordning. */
export async function scrapeClosingBatchScrapling(
  items: BatchScrapeItem[],
  opts: { pauseMs?: number; worker?: ScraplingWorker } = {}
): Promise<BatchScrapeResult[]> {
  const worker = opts.worker ?? new ScraplingWorker({});
  const pauseMs = opts.pauseMs ?? 1200;
  const out: BatchScrapeResult[] = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let result: ScrapeClosingResult;
      try {
        result = await scrapeClosingForBetScrapling(worker, item.input);
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
}
