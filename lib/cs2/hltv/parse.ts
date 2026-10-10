// HLTV-sidor → strukturerad data. Rena funktioner: HTML in, objekt ut. Ingen
// nätverkstrafik här — sessionen (session.ts) hämtar och cachar sidorna.
//
// HLTV ändrar sin markup då och då. Därför:
//  - id:n tas alltid ur länkarnas href (/team/<id>/…), den stabilaste delen;
//  - varje fält har en eller flera reservselektorer;
//  - saknade fält blir null i stället för att kasta, och anroparen avgör om
//    sidan är för trasig för att använda (se `missing` i resultaten).
// Rå-HTML ligger kvar i cachen, så en rättad parser kan köras om
// (`npm run cs2:ingest -- --reparse`) utan nya anrop mot HLTV.

import { load, type Cheerio, type CheerioAPI } from "cheerio";
import { canonicalMap } from "../maps";
import type { RoundEndReason, RoundOutcome, SeriesFormat, Side } from "../types";
import { idFromHref, slugFromHref } from "./urls";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sel = Cheerio<any>;

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

function int(s: string | undefined | null): number | null {
  const m = clean(s).match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

function float(s: string | undefined | null): number | null {
  const m = clean(s).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** data-unix-attribut (ms) → Date. HLTV använder millisekunder. */
function unixAttr(el: Sel): Date | null {
  const raw = el.attr("data-unix") ?? el.attr("data-zonedgrouping-entry-unix");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n) : null;
}

function firstUnix($: CheerioAPI, scope: Sel): Date | null {
  const own = unixAttr(scope);
  if (own) return own;
  const el = scope.find("[data-unix], [data-zonedgrouping-entry-unix]").first();
  return el.length ? unixAttr(el) : null;
}

/** Text i en tabellcell — föredrar "traditional"-värdet när HLTV visar två. */
function cellText(cell: Sel): string {
  const trad = cell.find(".traditional-data").first();
  return clean(trad.length ? trad.text() : cell.text());
}

export interface HltvRef {
  id: number;
  name: string;
  slug: string | null;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface HltvRankedTeam {
  rank: number;
  team: HltvRef;
  points: number | null;
  players: Array<{ id: number; nickname: string }>;
}

/** /valve-ranking/teams och /ranking/teams har samma `.ranked-team`-block. */
export function parseRanking(html: string): HltvRankedTeam[] {
  const $ = load(html);
  const out: HltvRankedTeam[] = [];
  $(".ranked-team").each((i, el) => {
    const box = $(el);
    const link = box.find('a[href^="/team/"]').first();
    const href = link.attr("href");
    const id = idFromHref(href, "team");
    if (id == null) return;
    const name =
      clean(box.find(".teamLine .name, .name").first().text()) ||
      clean(link.attr("title")) ||
      slugFromHref(href, "team") ||
      `team-${id}`;
    const rank = int(box.find(".position").first().text()) ?? i + 1;
    const points = float(box.find(".points").first().text());
    const players: HltvRankedTeam["players"] = [];
    const seen = new Set<number>();
    box.find('a[href^="/player/"]').each((_, a) => {
      const ah = $(a).attr("href");
      const pid = idFromHref(ah, "player");
      if (pid == null || seen.has(pid)) return;
      seen.add(pid);
      const nick =
        clean($(a).find(".nick").text()) || clean($(a).attr("title")) || clean($(a).text()) || slugFromHref(ah, "player") || "";
      players.push({ id: pid, nickname: nick });
    });
    out.push({ rank, team: { id, name, slug: slugFromHref(href, "team") }, points, players });
  });
  return out.sort((a, b) => a.rank - b.rank);
}

// ---------------------------------------------------------------------------
// Lagsida
// ---------------------------------------------------------------------------

export interface HltvTeamPage {
  id: number | null;
  name: string | null;
  country: string | null;
  players: Array<{ id: number; nickname: string; realName: string | null; country: string | null }>;
  upcoming: Array<{ matchId: number; slug: string | null; startAt: Date | null }>;
}

export function parseTeamPage(html: string): HltvTeamPage {
  const $ = load(html);
  const canonical = $('link[rel="canonical"]').attr("href") ?? $('meta[property="og:url"]').attr("content");
  const name = clean($(".profile-team-name").first().text()) || null;
  const country = clean($(".team-country").first().text()) || null;

  const players: HltvTeamPage["players"] = [];
  const seen = new Set<number>();
  const addPlayer = (a: Sel) => {
    const href = a.attr("href");
    const id = idFromHref(href, "player");
    if (id == null || seen.has(id)) return;
    seen.add(id);
    const nickname =
      clean(a.attr("title")) ||
      clean(a.find(".text-ellipsis, .playerFlagName, .bodyshot-team-nick").first().text()) ||
      clean(a.text()) ||
      slugFromHref(href, "player") ||
      "";
    const realName = clean(a.find(".playerRealname, .bodyshot-team-realname").first().text()) || null;
    const country = clean(a.find("img.flag").first().attr("title")) || null;
    players.push({ id, nickname, realName, country });
  };
  // Trupptabellen är auktoritativ (den visar även bänkade spelare med status).
  // Bilderna överst är en reserv om tabellen saknas.
  $(".players-table tbody tr").each((_, tr) => {
    const row = $(tr);
    const status = clean(row.find(".player-status, .players-cell.status-cell").text()).toLowerCase();
    if (/benched|inactive/.test(status)) return;
    const a = row.find('a[href^="/player/"]').first();
    if (a.length) addPlayer(a);
  });
  if (players.length === 0) $('.bodyshot-team a[href^="/player/"]').each((_, a) => addPlayer($(a)));

  // Kommande matcher: rader under en rubrik som innehåller "Upcoming".
  const upcoming: HltvTeamPage["upcoming"] = [];
  const upSeen = new Set<number>();
  const box = $("#matchesBox");
  const scope = box.length ? box : $("body");
  let inUpcoming = false;
  scope.find("h2, .standard-headline, tr, .team-row").each((_, el) => {
    const node = $(el);
    if (node.is("h2, .standard-headline")) {
      inUpcoming = /upcoming/i.test(node.text());
      return;
    }
    if (!inUpcoming) return;
    const a = node.find('a[href^="/matches/"]').first();
    const href = a.attr("href");
    const matchId = idFromHref(href, "matches");
    if (matchId == null || upSeen.has(matchId)) return;
    upSeen.add(matchId);
    upcoming.push({ matchId, slug: slugFromHref(href, "matches"), startAt: firstUnix($, node) });
  });

  return {
    id: idFromHref(canonical, "team"),
    name,
    country,
    players,
    upcoming,
  };
}

// ---------------------------------------------------------------------------
// Resultatlista
// ---------------------------------------------------------------------------

export interface HltvResultItem {
  matchId: number;
  slug: string | null;
  team1Name: string;
  team2Name: string;
  score1: number | null;
  score2: number | null;
  startAt: Date | null;
  eventName: string | null;
}

/** /results?team=…: en rad per serie. Bara matchlänken är garanterad. */
export function parseResults(html: string): HltvResultItem[] {
  const $ = load(html);
  const out: HltvResultItem[] = [];
  const seen = new Set<number>();
  $(".result-con").each((_, el) => {
    const con = $(el);
    const a = con.is("a") ? con : con.find('a[href^="/matches/"]').first();
    const href = a.attr("href") ?? con.find('a[href^="/matches/"]').attr("href");
    const matchId = idFromHref(href, "matches");
    if (matchId == null || seen.has(matchId)) return;
    seen.add(matchId);
    const scores = con.find(".result-score span");
    out.push({
      matchId,
      slug: slugFromHref(href, "matches"),
      team1Name: clean(con.find(".team1 .team").first().text()),
      team2Name: clean(con.find(".team2 .team").first().text()),
      score1: scores.length >= 2 ? int(scores.eq(0).text()) : null,
      score2: scores.length >= 2 ? int(scores.eq(1).text()) : null,
      startAt: firstUnix($, con),
      eventName: clean(con.find(".event-name").first().text()) || null,
    });
  });
  return out;
}

/** Finns det en sida till i resultatlistan? */
export function resultsHasNextPage(html: string): boolean {
  const $ = load(html);
  const next = $(".pagination-next").first();
  return next.length > 0 && !next.hasClass("inactive") && !!next.attr("href");
}

// ---------------------------------------------------------------------------
// Matchsida
// ---------------------------------------------------------------------------

export interface ParsedVeto {
  step: number;
  teamName: string | null;
  action: "ban" | "pick" | "decider";
  mapName: string;
}

/** "1. Vitality removed Anubis" / "3. MOUZ picked Mirage" / "7. Inferno was left over". */
export function parseVetoLine(line: string): ParsedVeto | null {
  const t = clean(line);
  let m = t.match(/^(\d+)\.\s*(.+?)\s+(removed|picked)\s+(.+?)\s*$/i);
  if (m) {
    const map = canonicalMap(m[4]);
    if (!map) return null;
    return { step: Number(m[1]), teamName: m[2], action: m[3].toLowerCase() === "picked" ? "pick" : "ban", mapName: map };
  }
  m = t.match(/^(\d+)\.\s*(.+?)\s+was left over\s*$/i);
  if (m) {
    const map = canonicalMap(m[2]);
    if (!map) return null;
    return { step: Number(m[1]), teamName: null, action: "decider", mapName: map };
  }
  return null;
}

export interface HltvHalf {
  team1: number;
  team2: number;
  /** Sidan team1 spelade i halvleken, när HLTV markerat den. */
  team1Side: Side | null;
}

export interface HltvMatchMap {
  mapNumber: number;
  mapName: string;
  mapStatsId: number | null;
  team1Score: number | null;
  team2Score: number | null;
  pickedBy: "team1" | "team2" | null;
  /** Ordinarie halvlekar (högst två). */
  halves: HltvHalf[];
  /** Rundor spelade i övertid (summa av OT-halvlekarna). */
  otRounds: number;
  played: boolean;
}

export interface HltvMatchPage {
  id: number | null;
  startAt: Date | null;
  format: SeriesFormat | null;
  lan: boolean | null;
  status: "scheduled" | "live" | "finished" | "cancelled";
  event: HltvRef | null;
  team1: HltvRef | null;
  team2: HltvRef | null;
  score1: number | null;
  score2: number | null;
  vetoLines: string[];
  vetoes: ParsedVeto[];
  maps: HltvMatchMap[];
  demoUrl: string | null;
  lineups: Array<{ teamId: number | null; teamName: string | null; players: Array<{ id: number; nickname: string }> }>;
}

function teamRef(scope: Sel): HltvRef | null {
  const a = scope.find('a[href^="/team/"]').first();
  const href = a.attr("href");
  const id = idFromHref(href, "team");
  const name = clean(scope.find(".teamName").first().text()) || clean(a.attr("title")) || null;
  if (id == null && !name) return null;
  if (id == null) return null;
  return { id, name: name ?? slugFromHref(href, "team") ?? `team-${id}`, slug: slugFromHref(href, "team") };
}

function seriesScore(scope: Sel): number | null {
  const el = scope.find(".won, .lost, .tie").first();
  return el.length ? int(el.text()) : null;
}

/**
 * Halvleksraden "(8:4; 5:3) (4:2)" som spans med klass ct/t. Spansen kommer
 * parvis i ordningen team1, team2. Första två paren är ordinarie halvlekar,
 * resten övertid.
 */
export function parseHalfScores($: CheerioAPI, el: Sel): { halves: HltvHalf[]; otRounds: number } {
  const nums: Array<{ n: number; side: Side | null }> = [];
  el.find("span").each((_, s) => {
    const sp = $(s);
    const n = int(sp.text());
    if (n == null || sp.children("span").length > 0) return;
    const side: Side | null = sp.hasClass("ct") ? "ct" : sp.hasClass("t") ? "t" : null;
    nums.push({ n, side });
  });
  const halves: HltvHalf[] = [];
  let otRounds = 0;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const pair = { team1: nums[i].n, team2: nums[i + 1].n, team1Side: nums[i].side };
    if (halves.length < 2) halves.push(pair);
    else otRounds += pair.team1 + pair.team2;
  }
  return { halves, otRounds };
}

export function parseMatchPage(html: string): HltvMatchPage {
  const $ = load(html);
  const canonical = $('link[rel="canonical"]').attr("href") ?? $('meta[property="og:url"]').attr("content");

  const team1 = teamRef($(".team1-gradient").first());
  const team2 = teamRef($(".team2-gradient").first());

  const timeEl = $(".timeAndEvent [data-unix]").first();
  const startAt = timeEl.length ? unixAttr(timeEl) : null;

  const eventA = $('.timeAndEvent .event a[href^="/events/"], .timeAndEvent a[href^="/events/"]').first();
  const eventId = idFromHref(eventA.attr("href"), "events");
  const event: HltvRef | null =
    eventId != null ? { id: eventId, name: clean(eventA.text()) || clean(eventA.attr("title")), slug: slugFromHref(eventA.attr("href"), "events") } : null;

  // Formatet står i första veto-boxen: "Best of 3 (LAN)".
  const formatText = clean($(".veto-box").first().text() || $(".preformatted-text").first().text());
  const bo = formatText.match(/best of\s*(\d)/i);
  const format: SeriesFormat | null = bo ? (`bo${bo[1]}` as SeriesFormat) : null;
  const lan = /\(lan\)/i.test(formatText) ? true : /\(online\)/i.test(formatText) ? false : null;

  // Vetot ligger i den sista veto-boxen, en rad per div.
  const vetoLines: string[] = [];
  const vetoBoxes = $(".veto-box");
  if (vetoBoxes.length > 1) {
    vetoBoxes
      .last()
      .find("div")
      .each((_, d) => {
        const node = $(d);
        if (node.children("div").length > 0) return;
        const t = clean(node.text());
        if (/^\d+\.\s/.test(t)) vetoLines.push(t);
      });
  }
  const vetoes = vetoLines.map(parseVetoLine).filter((v): v is ParsedVeto => v !== null);

  const maps: HltvMatchMap[] = [];
  $(".mapholder").each((i, el) => {
    const holder = $(el);
    const mapName = canonicalMap(holder.find(".mapname").first().text());
    if (!mapName) return;
    const left = holder.find(".results-left").first();
    const right = holder.find(".results-right").first();
    const s1 = int(left.find(".results-team-score").first().text());
    const s2 = int(right.find(".results-team-score").first().text());
    const statsHref = holder.find('a[href*="/mapstatsid/"]').first().attr("href");
    const pickedBy = left.hasClass("pick") ? "team1" : right.hasClass("pick") ? "team2" : null;
    const half = holder.find(".results-center-half-score").first();
    const { halves, otRounds } = half.length ? parseHalfScores($, half) : { halves: [], otRounds: 0 };
    maps.push({
      mapNumber: i + 1,
      mapName,
      mapStatsId: idFromHref(statsHref, "mapstatsid"),
      team1Score: s1,
      team2Score: s2,
      pickedBy,
      halves,
      otRounds,
      played: s1 != null && s2 != null && s1 + s2 > 0,
    });
  });

  const countdown = clean($(".countdown").first().text()).toLowerCase();
  const stillCounting = /\d+\s*[dhms]\b/.test(countdown);
  const status: HltvMatchPage["status"] = /deleted|postponed|cancel/.test(countdown)
    ? "cancelled"
    : /live/.test(countdown)
      ? "live"
      : /match over/.test(countdown) || (maps.some((m) => m.played) && !stillCounting)
        ? "finished"
        : "scheduled";

  const demoHref =
    $("[data-demo-link]").first().attr("data-demo-link") ?? $('a[href^="/download/demo/"]').first().attr("href") ?? null;

  const lineups: HltvMatchPage["lineups"] = [];
  $(".lineups .lineup").each((_, el) => {
    const lu = $(el);
    const ta = lu.find('a[href^="/team/"]').first();
    const players: Array<{ id: number; nickname: string }> = [];
    const seen = new Set<number>();
    lu.find('a[href^="/player/"]').each((_, a) => {
      const href = $(a).attr("href");
      const id = idFromHref(href, "player");
      if (id == null || seen.has(id)) return;
      seen.add(id);
      const nick =
        clean($(a).find(".text-ellipsis, .player-nick").first().text()) ||
        clean($(a).attr("title")) ||
        clean($(a).text()) ||
        slugFromHref(href, "player") ||
        "";
      players.push({ id, nickname: nick });
    });
    // Kommande matcher: inga spelarlänkar, bara data-player-id med smeknamnet
    // i .text-ellipsis (raden under bilderna) eller 'nick' i bildens titel.
    lu.find("[data-player-id]").each((_, el) => {
      const node = $(el);
      const id = Number(node.attr("data-player-id"));
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return;
      const nick =
        clean(lu.find(`[data-player-id="${id}"] .text-ellipsis`).first().text()) ||
        (clean(node.find("img").first().attr("title")).match(/'([^']+)'/)?.[1] ?? "");
      if (!nick) return;
      seen.add(id);
      players.push({ id, nickname: nick });
    });
    lineups.push({ teamId: idFromHref(ta.attr("href"), "team"), teamName: clean(ta.text()) || null, players });
  });

  return {
    id: idFromHref(canonical, "matches"),
    startAt,
    format,
    lan,
    status,
    event,
    team1,
    team2,
    score1: seriesScore($(".team1-gradient").first()),
    score2: seriesScore($(".team2-gradient").first()),
    vetoLines,
    vetoes,
    maps,
    demoUrl: demoHref && /\/download\/demo\/\d+/.test(demoHref) ? demoHref.replace(/^https?:\/\/[^/]+/, "") : null,
    lineups,
  };
}

// ---------------------------------------------------------------------------
// Mapstats
// ---------------------------------------------------------------------------

export interface HltvPlayerLine {
  playerId: number;
  nickname: string;
  teamId: number;
  side: "all" | "ct" | "t";
  kills: number;
  headshots: number | null;
  assists: number | null;
  flashAssists: number | null;
  deaths: number;
  kast: number | null;
  adr: number | null;
  rating: number | null;
  openingDiff: number | null;
}

export interface HltvMapStats {
  id: number | null;
  matchId: number | null;
  mapName: string | null;
  playedAt: Date | null;
  team1: HltvRef | null;
  team2: HltvRef | null;
  team1Score: number | null;
  team2Score: number | null;
  team1StartSide: Side | null;
  rounds: RoundOutcome[];
  players: HltvPlayerLine[];
}

const OUTCOME_ICONS: Array<{ re: RegExp; side: Side; reason: RoundEndReason }> = [
  { re: /bomb_defused/, side: "ct", reason: "bomb_defused" },
  { re: /stopwatch/, side: "ct", reason: "time" },
  { re: /ct_win/, side: "ct", reason: "elimination" },
  { re: /bomb_exploded/, side: "t", reason: "bomb_exploded" },
  { re: /t_win/, side: "t", reason: "elimination" },
];

/** En ikon ur rundhistoriken → vinnarsida och orsak, eller null för "förlorad". */
export function roundIcon(src: string | undefined | null): { side: Side; reason: RoundEndReason } | null {
  if (!src || /emptyHistory/i.test(src)) return null;
  for (const o of OUTCOME_ICONS) if (o.re.test(src)) return { side: o.side, reason: o.reason };
  return null;
}

/**
 * Rundhistoriken: per `.round-history-con` två rader, en per lag, med en ikon
 * per runda. Laget vars ikon inte är "empty" vann rundan. Övertid ligger i
 * egna block efter det ordinarie.
 */
export function parseRoundHistory($: CheerioAPI, team1Name: string | null, team2Name: string | null): RoundOutcome[] {
  const rounds: RoundOutcome[] = [];
  const norm = (s: string | null | undefined) => clean(s).toLowerCase();
  $(".round-history-con").each((_, con) => {
    const rows = $(con).find(".round-history-team-row");
    if (rows.length < 2) return;
    // Raden för team1 identifieras på logotypens title; annars gäller ordningen.
    const titles = rows.toArray().map((r) => norm($(r).find(".round-history-team").first().attr("title")));
    let t1Row = 0;
    if (team1Name && titles[1] === norm(team1Name)) t1Row = 1;
    else if (team2Name && titles[0] === norm(team2Name)) t1Row = 1;
    const iconsOf = (rowIdx: number) =>
      rows
        .eq(rowIdx)
        .find(".round-history-outcome")
        .toArray()
        .map((img) => $(img).attr("src") ?? "");
    const a = iconsOf(t1Row);
    const b = iconsOf(1 - t1Row);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const wa = roundIcon(a[i]);
      const wb = roundIcon(b[i]);
      if (wa && !wb) rounds.push({ n: rounds.length + 1, winner: "team1", side: wa.side, reason: wa.reason });
      else if (wb && !wa) rounds.push({ n: rounds.length + 1, winner: "team2", side: wb.side, reason: wb.reason });
      // Båda tomma = runda som inte spelades (HLTV fyller ut till 24/30).
    }
  });
  return rounds;
}

function parseScoreboards($: CheerioAPI, cls: "totalstats" | "ctstats" | "tstats", side: HltvPlayerLine["side"], teamIds: Array<number | null>): HltvPlayerLine[] {
  const out: HltvPlayerLine[] = [];
  $(`table.stats-table.${cls}`).each((ti, table) => {
    const teamId = teamIds[ti] ?? null;
    if (teamId == null) return;
    $(table)
      .find("tbody tr")
      .each((_, tr) => {
        const row = $(tr);
        const a = row.find('.st-player a[href*="/players/"], .st-player a[href^="/player/"]').first();
        const href = a.attr("href");
        const playerId = idFromHref(href, "players") ?? idFromHref(href, "player");
        if (playerId == null) return;
        const killsText = cellText(row.find(".st-kills").first());
        const assistsText = cellText(row.find(".st-assists").first());
        const kills = int(killsText);
        const deaths = int(cellText(row.find(".st-deaths").first()));
        if (kills == null || deaths == null) return;
        const hs = killsText.match(/\((\d+)\)/);
        const fa = assistsText.match(/\((\d+)\)/);
        out.push({
          playerId,
          nickname: clean(a.text()) || slugFromHref(href, "players") || "",
          teamId,
          side,
          kills,
          headshots: hs ? Number(hs[1]) : null,
          assists: int(assistsText),
          flashAssists: fa ? Number(fa[1]) : null,
          deaths,
          kast: float(cellText(row.find(".st-kdratio").first())),
          adr: float(cellText(row.find(".st-adr").first())),
          rating: float(cellText(row.find(".st-rating").first())),
          openingDiff: int(cellText(row.find(".st-fkdiff").first())),
        });
      });
  });
  return out;
}

export function parseMapStats(html: string): HltvMapStats {
  const $ = load(html);
  const canonical = $('link[rel="canonical"]').attr("href") ?? $('meta[property="og:url"]').attr("content");

  const sideRef = (cls: string): HltvRef | null => {
    const box = $(cls).first();
    const a = box.find('a[href*="/teams/"], a[href^="/team/"]').first();
    const href = a.attr("href");
    const id = idFromHref(href, "teams") ?? idFromHref(href, "team");
    if (id == null) return null;
    const name = clean(a.text()) || clean(box.find("img").first().attr("title")) || slugFromHref(href, "teams") || `team-${id}`;
    return { id, name, slug: slugFromHref(href, "teams") ?? slugFromHref(href, "team") };
  };
  const team1 = sideRef(".team-left");
  const team2 = sideRef(".team-right");

  // Kartnamnet är textnoden direkt i .match-info-box (efter "Map"-etiketten).
  const infoBox = $(".match-info-box").first();
  const direct = infoBox
    .contents()
    .toArray()
    .filter((n) => n.type === "text")
    .map((n) => clean((n as unknown as { data?: string }).data))
    .filter(Boolean);
  const mapName = canonicalMap(direct.find((t) => canonicalMap(t) !== null) ?? null);

  const matchHref = $('a.match-page-link, .match-info-box a[href^="/matches/"]').first().attr("href");
  const date = infoBox.find("[data-unix]").first();

  // Startsidan: första halvlekens spans i infoboxens resultatrad.
  let team1StartSide: Side | null = null;
  const firstColored = $(".match-info-row .right .ct-color, .match-info-row .right .t-color").first();
  if (firstColored.length) team1StartSide = firstColored.hasClass("ct-color") ? "ct" : "t";

  const rounds = parseRoundHistory($, team1?.name ?? null, team2?.name ?? null);
  if (!team1StartSide) {
    const r1 = rounds.find((r) => r.n === 1);
    if (r1) team1StartSide = r1.winner === "team1" ? r1.side : r1.side === "ct" ? "t" : "ct";
  }

  const ids = [team1?.id ?? null, team2?.id ?? null];
  const players = [
    ...parseScoreboards($, "totalstats", "all", ids),
    ...parseScoreboards($, "ctstats", "ct", ids),
    ...parseScoreboards($, "tstats", "t", ids),
  ];

  return {
    id: idFromHref(canonical, "mapstatsid"),
    matchId: idFromHref(matchHref, "matches"),
    mapName,
    playedAt: date.length ? unixAttr(date) : null,
    team1,
    team2,
    team1Score: int($(".team-left .bold").first().text()),
    team2Score: int($(".team-right .bold").first().text()),
    team1StartSide,
    rounds,
    players,
  };
}

/** Sammanfattning av rundhistoriken: rundor per lag och sida samt övertid. */
export function summarizeRounds(rounds: RoundOutcome[]): {
  team1Ct: number;
  team1T: number;
  team2Ct: number;
  team2T: number;
  otRounds: number;
} {
  let team1Ct = 0,
    team1T = 0,
    team2Ct = 0,
    team2T = 0;
  for (const r of rounds) {
    if (r.winner === "team1") r.side === "ct" ? team1Ct++ : team1T++;
    else r.side === "ct" ? team2Ct++ : team2T++;
  }
  return { team1Ct, team1T, team2Ct, team2T, otRounds: Math.max(0, rounds.length - 24) };
}

/** Är sidan en Cloudflare-utmaning i stället för riktigt innehåll? */
/**
 * Cloudflares mellansida ("Just a moment…"), inte en riktig HLTV-sida.
 *
 * `challenge-platform` räcker inte som tecken: Cloudflare lägger in ett
 * skript med det namnet på vanliga sidor också. En riktig HLTV-sida har
 * dessutom massor av interna länkar (meny, lag, matcher); mellansidan har
 * nästan inga.
 */
export function isChallengePage(html: string): boolean {
  // Bara mellansidans egna tecken — Turnstile-rutor kan finnas på vanliga
  // sidor också (inloggning, kommentarer).
  const marker = /<title>\s*Just a moment|_cf_chl_opt|cf-browser-verification|id=["']challenge-form/i.test(html);
  if (!marker) return false;
  const internalLinks = (html.match(/href=["'](?:https?:\/\/(?:www\.)?hltv\.org)?\/(?!cdn-cgi)[a-z]/gi) ?? []).length;
  return internalLinks < 15;
}
