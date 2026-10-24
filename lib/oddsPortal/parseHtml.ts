// Tolkar för OddsPortal-sidor som sparad HTML (hämtade av
// lib/oddsPortal/scrape.ts via Scrapling).
//
// Oddstabellerna läses som TEXT, rad för rad, inte via CSS-klasser: OddsPortal
// byter Tailwind-klasser ofta (oktober 2026 fanns varken li.odds-item eller
// .odds-cell kvar), men texten i tabellen har samma ordning:
//
//   Bookmakers | 1 | X | 2 | Payout | bet365 | 1.36 | 5.00 | 8.00 | 94.3% | …
//   Bookmakers | Total | Over | Under | Payout | bet365 | +2.5 | 1.85 | 2.00 | 96.1% | …
//   Over/Under +2.5 | O/U +2.5 | 3 | 1.85 | 2.00 | 94.0%      (sammanfattning, snittodds)

import * as cheerio from "cheerio";
import type { OddsRow, SearchCandidate } from "./scrape";

const BASE = "https://www.oddsportal.com";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Sidans synliga text, en rad per textnod — ungefär som innerText. */
export function htmlToLines(html: string): string[] {
  return decodeEntities(
    html
      .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "\n")
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Cloudflare-mellansidan i stället för OddsPortal. */
export function isBlockedHtml(html: string): boolean {
  const t = html.slice(0, 20_000).toLowerCase();
  return (t.includes("just a moment") && t.includes("cloudflare")) || t.includes("cf-browser-verification") || t.includes("attention required");
}

/**
 * Sökträffar: länkar till matchsidor
 * (/h2h/… eller klassiska …-<id>) inom sporten, med radens text för datumet.
 */
export function parseSearchCandidates(html: string, sportSlug: string): SearchCandidate[] {
  const $ = cheerio.load(html);
  const out: SearchCandidate[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    let url: URL;
    try {
      url = new URL($(el).attr("href") ?? "", BASE);
    } catch {
      return;
    }
    if (url.origin !== BASE) return;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.includes(`/${sportSlug}/`)) return;
    const isH2h = /\/h2h\/[^/]+\/[^/]+$/i.test(path);
    const isClassic = /-\d+$/.test(path);
    if (!isH2h && !isClassic) return;
    const title = $(el).text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 3) return;
    if (/^(football|tennis|basketball|baseball|hockey)$/i.test(title)) return;
    const href = url.toString().split("?")[0];
    const key = href.split("#")[0];
    if (seen.has(key)) return;
    seen.add(key);
    const row = $(el).closest(".eventRow, div, tr, li, article");
    const dateText = (row.length ? row.text() : $(el).parent().text()).replace(/\s+/g, " ").trim().slice(0, 160);
    out.push({ href, title, dateText });
  });
  return out;
}

const NUM = /^[+-]?\d+(?:\.\d+)?$/;
/** Text i tabellraderna som inte är data. */
const JUNK = /^(claim bonus|claim|back|lay|\(\d+\))$/i;
/** Där tabellen slutar. */
const STOP = new Set(["My coupon", "Betting Exchanges", "User Predictions", "OddsAlert"]);

export interface BookmakerTableRow {
  bookmaker: string;
  /** Linjen i första kolumnen (Total/Handicap), annars null. */
  line: number | null;
  /** Ett värde per oddskolumn, NaN där bolaget saknar odds. */
  values: number[];
}

export interface BookmakerTable {
  /** Oddskolumnerna, t.ex. ["1","X","2"] eller ["Over","Under"]. */
  columns: string[];
  hasLine: boolean;
  rows: BookmakerTableRow[];
}

/** Oddstabellen per bolag (den första på sidan), eller null om ingen syns. */
export function parseBookmakerTable(lines: string[]): BookmakerTable | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "Bookmakers") continue;
    const header: string[] = [];
    let j = i + 1;
    while (j < lines.length && j < i + 8 && lines[j] !== "Payout") header.push(lines[j++]);
    if (lines[j] !== "Payout" || header.length < 2) continue;

    const hasLine = /^(total|handicap)$/i.test(header[0]);
    const columns = hasLine ? header.slice(1) : header;
    const rows: BookmakerTableRow[] = [];
    let cur: BookmakerTableRow | null = null;
    const flush = () => {
      if (cur && cur.values.some((v) => Number.isFinite(v))) rows.push(cur);
      cur = null;
    };
    for (let k = j + 1; k < lines.length; k++) {
      const l = lines[k];
      if (STOP.has(l)) break;
      if (JUNK.test(l)) continue;
      if (cur && NUM.test(l)) {
        const row: BookmakerTableRow = cur;
        if (hasLine && row.line === null && row.values.length === 0) row.line = parseFloat(l);
        else row.values.push(parseFloat(l));
        continue;
      }
      if (cur && l === "-") {
        const row: BookmakerTableRow = cur;
        // Mitt i raden: saknat odds. Efter sista kolumnen: saknad payout = radslut.
        if (row.values.length < columns.length) row.values.push(NaN);
        else flush();
        continue;
      }
      if (/%$/.test(l)) {
        flush();
        continue;
      }
      // Ny rad börjar med bolagets namn.
      flush();
      cur = { bookmaker: l, line: null, values: [] };
    }
    flush();
    return { columns, hasLine, rows };
  }
  return null;
}

/** Tabellen som OddsRow (en rad per bolag). */
export function tableToOddsRows(table: BookmakerTable): (OddsRow & { line: number | null })[] {
  const cols = table.columns.map((c) => c.toLowerCase());
  const val = (r: BookmakerTableRow, i: number) => (Number.isFinite(r.values[i]) && r.values[i] > 1 ? r.values[i] : undefined);
  return table.rows.map((r) => {
    const row: OddsRow & { line: number | null } = { bookmaker: r.bookmaker, line: r.line };
    if (cols.length === 3) {
      row.home = val(r, 0);
      row.draw = val(r, 1);
      row.away = val(r, 2);
    } else if (cols[0] === "over") {
      row.over = row.home = val(r, 0);
      row.under = row.away = val(r, 1);
    } else {
      row.home = val(r, 0);
      row.away = val(r, 1);
    }
    return row;
  });
}

export interface LineSummary {
  line: number;
  /** Over (O/U) eller hemma (AH). */
  first: number;
  /** Under (O/U) eller borta (AH). */
  second: number;
}

/**
 * Sammanfattningen per linje (snittodds): "Over/Under +2.5 | O/U +2.5 | 3 |
 * 1.85 | 2.00 | 94.0%". `prefix` är "Over/Under" eller "Asian Handicap".
 */
export function parseLineSummary(lines: string[], prefix: "Over/Under" | "Asian Handicap"): LineSummary[] {
  const re = new RegExp(`^${prefix.replace("/", "\\/")} ([+-]?\\d+(?:\\.\\d+)?)$`);
  const out: LineSummary[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const line = parseFloat(m[1]);
    // Hoppa över kortformen ("O/U +2.5", "AH -1.5") och antalet bolag.
    let k = i + 1;
    while (k < lines.length && /^(O\/U|AH) /.test(lines[k])) k++;
    if (!/^\d+$/.test(lines[k] ?? "")) continue;
    const first = parseFloat(lines[k + 1] ?? "");
    const second = parseFloat(lines[k + 2] ?? "");
    if (first > 1 && second > 1) out.push({ line, first, second });
  }
  return out;
}

/** Linjen som den står på OddsPortal: "+2.5", "-1", "0". */
export function formatLine(line: number, signed: boolean): string {
  const s = String(Math.abs(line));
  if (line === 0) return "0";
  if (line < 0) return `-${s}`;
  return signed ? `+${s}` : s;
}

// ---------------------------------------------------------------------------
// Spelade matcher (h2h-sidor)
// ---------------------------------------------------------------------------
//
// OddsPortals sök visar bara kommande matcher. En spelad match nås via
// h2h-sidan för lagparet, /{sport}/h2h/{lag-id}/{lag-id}/, som listar
// tidigare möten med datum och en länk (#eventId) till varje. Lagens id:n
// ("arsenal-hA1Zm19f") står i sökträffarnas länkar.

export interface TeamSegment {
  /** Länkens del för laget, t.ex. "arsenal-hA1Zm19f". */
  segment: string;
  /** Namnet ur delen, t.ex. "arsenal" eller "fleetwood town". */
  name: string;
  /** Antal länkar delen stod i — huvudlaget syns oftare än dam- och ungdomslag. */
  count: number;
}

const H2H_PATH = /\/([a-z-]+)\/h2h\/([a-z0-9-]+-[A-Za-z0-9]{8})\/([a-z0-9-]+-[A-Za-z0-9]{8})\/?/;

/** Lagens id-delar ur alla h2h-länkar på en sida (t.ex. sökresultatet), vanligast först. */
export function teamSegmentsFromLinks(html: string, sportSlug: string): TeamSegment[] {
  const seen = new Map<string, TeamSegment>();
  for (const m of html.matchAll(/href="([^"]*\/h2h\/[^"]*)"/g)) {
    const hit = m[1].match(H2H_PATH);
    if (!hit || hit[1] !== sportSlug) continue;
    for (const segment of [hit[2], hit[3]]) {
      const prev = seen.get(segment);
      if (prev) prev.count += 1;
      else seen.set(segment, { segment, name: segment.replace(/-[A-Za-z0-9]{8}$/, "").replace(/-/g, " "), count: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}

/** h2h-sidans sökväg för två lag — OddsPortal sorterar delarna i bokstavsordning. */
export function h2hPath(sportSlug: string, a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `/${sportSlug}/h2h/${x}/${y}/`;
}

export interface H2hMeeting {
  eventId: string;
  /** "10/Oct" eller "10/Oct/2025" som det står. */
  dateText: string;
  /** Länkens text, t.ex. "10/Oct2Arsenal-Leeds1". */
  title: string;
}

/**
 * Lagparet en h2h-sökväg pekar på, oberoende av namnet i länken och av
 * språkprefix: samma lag heter "manchester-united-ppjDR086" på ligasidan och
 * "manchester-utd-ppjDR086" i möteslistan, och sidan kan ha /pl/ först.
 */
export function h2hKey(pathname: string): string | null {
  const hit = pathname.match(H2H_PATH);
  if (!hit) return null;
  const ids = [hit[2], hit[3]].map((s) => s.slice(-8)).sort();
  return `${hit[1]}/${ids[0]}/${ids[1]}`;
}

/** Tidigare (och kommande) möten på en h2h-sida, ett per eventId. */
export function parseH2hMeetings(html: string, path: string): H2hMeeting[] {
  const $ = cheerio.load(html);
  const out = new Map<string, H2hMeeting>();
  const key = h2hKey(path);
  $("a[href*='#']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let url: URL;
    try {
      url = new URL(href, BASE);
    } catch {
      return;
    }
    if (!key || h2hKey(url.pathname) !== key) return;
    const eventId = url.hash.replace(/^#/, "").split(/[:;]/)[0];
    if (!/^[A-Za-z0-9]{8}$/.test(eventId) || out.has(eventId)) return;
    const title = $(el).text().replace(/\s+/g, " ").trim();
    const date = title.match(/^(\d{1,2}\/[A-Za-z]{3}(?:\/\d{4})?)/);
    if (!date) return;
    out.set(eventId, { eventId, dateText: date[1], title });
  });
  return [...out.values()];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "10/Oct" → datum. Utan år väljs det år som ligger närmast `near`
 * (ett möte i december och ett bet i januari ska inte hamna ett år fel).
 */
export function meetingDate(dateText: string, near: Date): Date | null {
  const m = dateText.match(/^(\d{1,2})\/([A-Za-z]{3})(?:\/(\d{4}))?$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  const day = Number(m[1]);
  if (m[3]) return new Date(Date.UTC(Number(m[3]), month, day, 12));
  const y = near.getUTCFullYear();
  const options = [y - 1, y, y + 1].map((yy) => new Date(Date.UTC(yy, month, day, 12)));
  return options.sort((a, b) => Math.abs(a.getTime() - near.getTime()) - Math.abs(b.getTime() - near.getTime()))[0];
}

/**
 * Avsparken på en matchsida: "10 Oct 2026," följt av "18:30". Tiden står i
 * webbläsarens tidszon, som är datorns — samma som Node:s, så den tolkas som
 * lokal tid.
 */
export function kickoffFromLines(lines: string[]): Date | null {
  for (let i = 0; i < lines.length - 1; i++) {
    const d = lines[i].match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4}),?$/);
    const t = lines[i + 1].match(/^(\d{1,2}):(\d{2})$/);
    if (!d || !t) continue;
    const month = MONTHS.indexOf(d[2].toLowerCase());
    if (month < 0) continue;
    return new Date(Number(d[3]), month, Number(d[1]), Number(t[1]), Number(t[2]));
  }
  return null;
}

/**
 * Matchen h2h-sidan visar överst. Den står inte i möteslistan (ingen länk);
 * id:t finns i sidans adress efter laddning (#eventId:…) och datumet som
 * "08 May 2027," under rubriken. Ibland är det just bettets match.
 */
export function featuredMatch(lines: string[], finalUrl: string): { eventId: string; date: Date } | null {
  const hash = finalUrl.split("#")[1] ?? "";
  const eventId = hash.split(/[:;]/)[0];
  if (!/^[A-Za-z0-9]{8}$/.test(eventId)) return null;
  for (const l of lines) {
    const m = l.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4}),?$/);
    if (!m) continue;
    const month = MONTHS.indexOf(m[2].toLowerCase());
    if (month < 0) continue;
    return { eventId, date: new Date(Date.UTC(Number(m[3]), month, Number(m[1]), 12)) };
  }
  return null;
}
