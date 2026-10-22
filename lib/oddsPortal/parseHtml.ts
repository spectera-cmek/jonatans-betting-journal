// Tolkar för OddsPortal-sidor som sparad HTML — Scrapling-vägen
// (lib/oddsPortal/scraplingScrape.ts). Playwright-vägen läser sidan direkt i
// webbläsaren och använder inte de här.
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
 * Sökträffar som Playwright-vägens evaluate-skript: länkar till matchsidor
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

/** Tabellen som OddsRow — samma form som Playwright-vägen ger. */
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
