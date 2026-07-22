// OddsPortal Playwright scraper — search match + extract closing/current odds.
// Tuned for OddsPortal's 2025+ UI: /{sport}/h2h/... links, li.odds-item tabs, div.odds-cell rows.
//
// IMPORTANT: page.evaluate callbacks must not declare nested functions.
// tsx/esbuild injects `__name(...)` into nested fns which crashes in the browser.

import type { Browser, Page } from "playwright";
import {
  buildSearchQuery,
  dateWithinWindow,
  matchTitleLooksLike,
  oddsPortalSportSlug,
  pickBookmakerOdds,
  resolveMarketTarget,
  type MarketTarget,
  type SelectionColumn,
} from "./mapping";

const BASE = "https://www.oddsportal.com";
const NAV_TIMEOUT_MS = 45_000;

export interface ScrapeBetInput {
  sport?: string | null;
  league?: string | null;
  event?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  eventAt?: Date | null;
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

export interface SearchMatchResult {
  ok: boolean;
  url: string | null;
  title: string | null;
  code?: string;
  detail: string;
}

type OddsRow = {
  bookmaker: string;
  home?: number;
  draw?: number;
  away?: number;
  over?: number;
  under?: number;
  odds?: number;
};

let scrapeChain: Promise<unknown> = Promise.resolve();

/** Serialize scrapes so we never spawn parallel Chromium instances. */
export function withScrapeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = scrapeChain.then(fn, fn);
  scrapeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "playwright saknas. Kör: npm i playwright && npx playwright install chromium"
    );
  }
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await loadPlaywright();
  return chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1400, height: 900 },
  });
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  return page;
}

function isBlocked(page: Page, bodyText: string): boolean {
  const t = bodyText.toLowerCase();
  return (
    (t.includes("just a moment") && t.includes("cloudflare")) ||
    t.includes("cf-browser-verification") ||
    t.includes("attention required") ||
    page.url().includes("cdn-cgi/challenge")
  );
}

function pickColumnOdds(row: OddsRow, column: SelectionColumn): number | null {
  if (column === "home") return row.home ?? row.odds ?? null;
  if (column === "draw") return row.draw ?? null;
  if (column === "away") return row.away ?? row.odds ?? null;
  if (column === "over") return row.over ?? row.home ?? row.odds ?? null;
  if (column === "under") return row.under ?? row.away ?? row.odds ?? null;
  return null;
}

async function dismissCookies(page: Page): Promise<void> {
  const labels = ["Accept", "I Agree", "Agree", "Godkänn", "Allow all", "Accept All"];
  for (const label of labels) {
    try {
      const btn = page.getByRole("button", { name: new RegExp(label, "i") }).first();
      if (await btn.isVisible({ timeout: 700 })) {
        await btn.click({ timeout: 1500 });
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      /* ignore */
    }
  }
}

/** True if href looks like an OddsPortal match page (new h2h or classic). */
export function isMatchHref(href: string, sportSlug?: string): boolean {
  try {
    const u = new URL(href);
    if (!u.hostname.includes("oddsportal.com")) return false;
    const path = u.pathname.replace(/\/+$/, "");
    if (sportSlug && !path.includes(`/${sportSlug}/`)) return false;
    if (/\/h2h\/[^/]+\/[^/]+$/i.test(path)) return true;
    if (/-\d+$/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function searchMatch(
  page: Page,
  input: ScrapeBetInput
): Promise<SearchMatchResult> {
  const sport = oddsPortalSportSlug(input.sport, input.league);
  const query = buildSearchQuery(input);
  if (!query || query.length < 2) {
    return { ok: false, url: null, title: null, code: "missing_fields", detail: "Saknar lag/event för sök." };
  }

  const searchUrl = `${BASE}/search/${encodeURIComponent(query)}/`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await dismissCookies(page);
  try {
    await page.waitForSelector("a[href*='/h2h/'], .eventRow a[href]", { timeout: 12_000 });
  } catch {
    /* continue */
  }
  await page.waitForTimeout(1200);

  const body = await page.locator("body").innerText().catch(() => "");
  if (isBlocked(page, body)) {
    return { ok: false, url: null, title: null, code: "blocked", detail: "OddsPortal blockerade (Cloudflare)." };
  }

  const candidates = await page.evaluate(({ sportSlug, base }) => {
    const out: { href: string; title: string; dateText: string }[] = [];
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i] as HTMLAnchorElement;
      const hrefRaw = a.href || "";
      if (!hrefRaw.startsWith(base)) continue;
      let path = "";
      try {
        path = new URL(hrefRaw).pathname.replace(/\/+$/, "");
      } catch {
        continue;
      }
      if (path.indexOf("/" + sportSlug + "/") < 0) continue;
      const isH2h = /\/h2h\/[^/]+\/[^/]+$/i.test(path);
      const isClassic = /-\d+$/.test(path);
      if (!isH2h && !isClassic) continue;
      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.length < 3) continue;
      if (/^(football|tennis|basketball|baseball|hockey)$/i.test(title)) continue;
      const row = a.closest(".eventRow, div, tr, li, article") || a.parentElement;
      const dateText = ((row && row.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 160);
      out.push({ href: hrefRaw.split("?")[0], title, dateText });
    }
    const seen: Record<string, boolean> = {};
    const uniq: typeof out = [];
    for (let i = 0; i < out.length; i++) {
      const key = out[i].href.split("#")[0];
      if (seen[key]) continue;
      seen[key] = true;
      uniq.push(out[i]);
    }
    return uniq;
  }, { sportSlug: sport, base: BASE });

  const home = input.homeTeam;
  const away = input.awayTeam;
  const scored = candidates
    .filter((c) => matchTitleLooksLike(c.title, home, away))
    .map((c) => {
      let iso: string | null = null;
      const m1 = c.dateText.match(/(\d{2})[./-](\d{2})[./-](\d{4})/);
      if (m1) iso = `${m1[3]}-${m1[2]}-${m1[1]}T12:00:00Z`;
      const m2 = c.dateText.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m2) iso = `${m2[1]}-${m2[2]}-${m2[3]}T12:00:00Z`;
      if (/today|tomorrow|idag|imorgon/i.test(c.dateText)) iso = null;
      const dateOk = dateWithinWindow(iso, input.eventAt ?? null);
      return { ...c, iso, dateOk };
    })
    .filter((c) => c.dateOk);

  const pick =
    scored[0] ||
    candidates.find(
      (c) =>
        matchTitleLooksLike(c.title, home, null) ||
        matchTitleLooksLike(c.title, null, away) ||
        matchTitleLooksLike(c.title, home, away)
    );

  if (!pick) {
    return {
      ok: false,
      url: null,
      title: null,
      code: "match_not_found",
      detail: `Hittade ingen OddsPortal-match för "${query}" (${sport}).`,
    };
  }

  return { ok: true, url: pick.href, title: pick.title, detail: `Match: ${pick.title}` };
}

async function clickVisibleTab(page: Page, labels: string[]): Promise<boolean> {
  for (const label of labels) {
    const clicked = await page.evaluate((lab) => {
      const items = Array.from(document.querySelectorAll("li.odds-item, a, button, div, span"));
      const matches: Element[] = [];
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.toLowerCase() !== String(lab).toLowerCase()) continue;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (r.width <= 8 || r.height <= 8) continue;
        matches.push(el);
      }
      matches.sort((a, b) => {
        const aScore =
          (a.tagName === "LI" && a.classList.contains("odds-item") ? 0 : 1) +
          a.getBoundingClientRect().y / 10000;
        const bScore =
          (b.tagName === "LI" && b.classList.contains("odds-item") ? 0 : 1) +
          b.getBoundingClientRect().y / 10000;
        return aScore - bScore;
      });
      if (!matches.length) return false;
      (matches[0] as HTMLElement).click();
      return true;
    }, label);
    if (clicked) {
      await page.waitForTimeout(2200);
      return true;
    }
  }
  return false;
}

async function activateMarket(page: Page, target: MarketTarget): Promise<boolean> {
  const currentHash = page.url().split("#")[1] || "";
  const eventId = currentHash.split(":")[0] || "";
  const wantsTwoWay =
    target.column === "over" ||
    target.column === "under" ||
    target.hashHints.some((h) => /over-under|ah|handicap|spread|bts/i.test(h));

  if (eventId && target.hashHints.length) {
    for (const hint of target.hashHints) {
      try {
        const next = `${page.url().split("#")[0]}#${eventId}:${hint}`;
        await page.goto(next, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(2000);
        const rows = await extractOddsRows(page);
        if (rows.length && (!wantsTwoWay || rows.some((r) => r.draw == null && (r.over != null || r.away != null)))) {
          return true;
        }
      } catch {
        /* continue */
      }
    }
  }

  const clicked = await clickVisibleTab(page, target.tabLabels);
  if (clicked) {
    await page.waitForTimeout(1500);
    if (wantsTwoWay) {
      // Confirm URL/hash moved off plain 1X2 when possible
      await page.waitForTimeout(800);
    }
    const rows = await extractOddsRows(page);
    if (rows.length) {
      if (!wantsTwoWay) return true;
      if (rows.some((r) => r.draw == null && ((r.over ?? r.home) != null) && ((r.under ?? r.away) != null))) {
        return true;
      }
    }
  }

  if (!target.isProp && !wantsTwoWay) {
    const rows = await extractOddsRows(page);
    return rows.length > 0;
  }
  return false;
}

async function selectLine(page: Page, line: number | null): Promise<void> {
  if (line == null) return;
  const variants = Array.from(
    new Set([String(line), line.toFixed(1), line.toFixed(2)])
  );

  for (const v of variants) {
    const clicked = await page.evaluate((val) => {
      const els = Array.from(document.querySelectorAll("div, button, a, span, li"));
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const text = (el.textContent || "").trim();
        if (text !== val) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (text.length > 8) continue;
        (el as HTMLElement).click();
        return true;
      }
      return false;
    }, v);
    if (clicked) {
      await page.waitForTimeout(1500);
      return;
    }
  }
}

async function extractOddsRows(page: Page): Promise<OddsRow[]> {
  return page.evaluate(() => {
    const rows: {
      bookmaker: string;
      home?: number;
      draw?: number;
      away?: number;
      over?: number;
      under?: number;
      odds?: number;
    }[] = [];

    const bookRows = Array.from(document.querySelectorAll("div.flex.h-9"));
    for (let i = 0; i < bookRows.length; i++) {
      const row = bookRows[i];
      const img =
        row.querySelector("img[src*='bookmaker']") ||
        row.querySelector("img[title]") ||
        row.querySelector("img[alt]");
      if (!img) continue;
      const htmlImg = img as HTMLImageElement;
      const bookmaker = (htmlImg.title || htmlImg.alt || "").replace(/\s+/g, " ").trim();
      if (!bookmaker || bookmaker === "img") continue;
      if (/team-logo|sport_icons|logo\.svg/i.test(htmlImg.src || "")) continue;

      const cells = Array.from(row.querySelectorAll(".odds-cell"));
      const nums: number[] = [];
      for (let c = 0; c < cells.length; c++) {
        const cleaned = (cells[c].textContent || "").replace(",", ".").replace(/[^\d.]/g, "");
        const n = parseFloat(cleaned);
        if (Number.isFinite(n) && n > 1 && n < 80) nums.push(n);
      }
      if (!nums.length) {
        const matches = (row.textContent || "").match(/\d+[.,]\d{2,3}/g) || [];
        for (let m = 0; m < matches.length; m++) {
          const cleaned = matches[m].replace(",", ".").replace(/[^\d.]/g, "");
          const n = parseFloat(cleaned);
          if (Number.isFinite(n) && n > 1 && n < 80) nums.push(n);
        }
      }
      if (!nums.length) continue;

      if (nums.length >= 3) rows.push({ bookmaker, home: nums[0], draw: nums[1], away: nums[2] });
      else if (nums.length === 2)
        rows.push({ bookmaker, home: nums[0], away: nums[1], over: nums[0], under: nums[1] });
      else rows.push({ bookmaker, odds: nums[0], home: nums[0] });
    }

    if (!rows.length) {
      const imgs = Array.from(document.querySelectorAll("img[src*='serve/bookmaker']"));
      for (let i = 0; i < imgs.length; i++) {
        const htmlImg = imgs[i] as HTMLImageElement;
        const bookmaker = (htmlImg.title || htmlImg.alt || "").trim();
        if (!bookmaker) continue;
        const row = htmlImg.closest("div.flex") || htmlImg.parentElement?.parentElement;
        if (!row) continue;
        const nums: number[] = [];
        const matches = (row.textContent || "").match(/\d+[.,]\d{2,3}/g) || [];
        for (let m = 0; m < matches.length; m++) {
          const cleaned = matches[m].replace(",", ".").replace(/[^\d.]/g, "");
          const n = parseFloat(cleaned);
          if (Number.isFinite(n) && n > 1 && n < 80) nums.push(n);
        }
        if (!nums.length) continue;
        let dup = false;
        for (let r = 0; r < rows.length; r++) {
          if (rows[r].bookmaker.toLowerCase() === bookmaker.toLowerCase()) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        if (nums.length >= 3) rows.push({ bookmaker, home: nums[0], draw: nums[1], away: nums[2] });
        else if (nums.length === 2)
          rows.push({ bookmaker, home: nums[0], away: nums[1], over: nums[0], under: nums[1] });
        else rows.push({ bookmaker, odds: nums[0], home: nums[0] });
      }
    }

    const byBook: Record<string, (typeof rows)[0]> = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = r.bookmaker.toLowerCase();
      const rich =
        (r.home != null ? 1 : 0) +
        (r.draw != null ? 1 : 0) +
        (r.away != null ? 1 : 0) +
        (r.over != null ? 1 : 0) +
        (r.under != null ? 1 : 0) +
        (r.odds != null ? 1 : 0);
      const prev = byBook[key];
      const prevRich = prev
        ? (prev.home != null ? 1 : 0) +
          (prev.draw != null ? 1 : 0) +
          (prev.away != null ? 1 : 0) +
          (prev.over != null ? 1 : 0) +
          (prev.under != null ? 1 : 0) +
          (prev.odds != null ? 1 : 0)
        : -1;
      if (!prev || rich >= prevRich) byBook[key] = r;
    }
    return Object.keys(byBook).map((k) => byBook[k]);
  });
}

/** Parse OddsPortal Over/Under (or AH) summary table: line → over/under avg odds. */
export function parseOuSummaryText(
  text: string
): { line: number; over: number; under: number }[] {
  const out: { line: number; over: number; under: number }[] = [];
  const re =
    /Over\/Under\s*\+?(\d+(?:\.\d+)?)\s+(\d+)\s+([\d.]+|-)\s+([\d.]+|-)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text.replace(/\u00a0/g, " ")))) {
    const line = parseFloat(m[1]);
    const over = parseFloat(m[3]);
    const under = parseFloat(m[4]);
    if (!Number.isFinite(line)) continue;
    if (!(over > 1) || !(under > 1)) continue;
    out.push({ line, over, under });
  }
  // Also accept newline-separated form from innerText
  if (!out.length) {
    const re2 =
      /Over\/Under\s*\+?(\d+(?:\.\d+)?)\s*\n\s*\d+\s*\n\s*([\d.]+|-)\s*\n\s*([\d.]+|-)/gi;
    while ((m = re2.exec(text))) {
      const line = parseFloat(m[1]);
      const over = parseFloat(m[2]);
      const under = parseFloat(m[3]);
      if (!Number.isFinite(line) || !(over > 1) || !(under > 1)) continue;
      out.push({ line, over, under });
    }
  }
  return out;
}

async function extractOuSummary(
  page: Page
): Promise<{ line: number; over: number; under: number }[]> {
  const text = await page.locator("body").innerText();
  return parseOuSummaryText(text);
}

function pickOuLine(
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

async function tryPropOdds(page: Page, target: MarketTarget): Promise<OddsRow[]> {
  await clickVisibleTab(page, target.tabLabels);
  for (const hint of target.propHints) {
    if (!hint || hint.length < 3) continue;
    try {
      const el = page.getByText(new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(1000);
      }
    } catch {
      /* continue */
    }
  }
  return extractOddsRows(page);
}

export async function fetchClosingFromMatch(
  page: Page,
  matchUrl: string,
  input: ScrapeBetInput
): Promise<ScrapeClosingResult> {
  const target = resolveMarketTarget(input);
  await page.goto(matchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await dismissCookies(page);
  try {
    await page.waitForSelector("li.odds-item, .odds-cell, img[src*='bookmaker']", { timeout: 12_000 });
  } catch {
    /* continue */
  }
  await page.waitForTimeout(1000);

  const body = await page.locator("body").innerText().catch(() => "");
  if (isBlocked(page, body)) {
    return {
      ok: false,
      closingOdds: null,
      bookmakerUsed: null,
      matchUrl,
      provisional: false,
      code: "blocked",
      detail: "OddsPortal blockerade (Cloudflare).",
    };
  }

  const activated = await activateMarket(page, target);
  if (!activated && target.isProp) {
    return {
      ok: false,
      closingOdds: null,
      bookmakerUsed: null,
      matchUrl,
      provisional: false,
      code: "market_not_found",
      detail: `Hittade inte marknaden (${target.tabLabels[0] || "prop"}). Ange closing manuellt.`,
    };
  }

  const wantsOu = target.column === "over" || target.column === "under";
  const provisional = input.eventAt != null ? input.eventAt.getTime() > Date.now() : false;

  // Totals / OU on modern OddsPortal: summary table per line (avg odds), not per-book rows.
  if (wantsOu) {
    await clickVisibleTab(page, ["Over/Under", "Over Under", "Totals"]);
    await page.waitForTimeout(1500);
    let summary = await extractOuSummary(page);
    if (!summary.length) {
      await page.waitForTimeout(2000);
      summary = await extractOuSummary(page);
    }
    const pickedLine = pickOuLine(summary, target.line);
    if (pickedLine) {
      const odds = target.column === "under" ? pickedLine.under : pickedLine.over;
      const detail = provisional
        ? `Live OU ${pickedLine.line} ${target.column} ${odds.toFixed(2)} (OddsPortal-snitt, match ej startad).`
        : `Closing OU ${pickedLine.line} ${target.column} ${odds.toFixed(2)} (OddsPortal-snitt).`;
      return {
        ok: true,
        closingOdds: odds,
        bookmakerUsed: "OddsPortal avg",
        matchUrl: page.url(),
        provisional,
        detail,
      };
    }
    return {
      ok: false,
      closingOdds: null,
      bookmakerUsed: null,
      matchUrl,
      provisional: false,
      code: "odds_not_found",
      detail:
        target.line != null
          ? `Hittade Over/Under men inte linjen ${target.line}.`
          : "Hittade ingen Over/Under-tabell på OddsPortal.",
    };
  }

  await selectLine(page, target.line);

  let rows = target.isProp ? await tryPropOdds(page, target) : await extractOddsRows(page);
  if (!rows.length) {
    await page.waitForTimeout(2500);
    rows = await extractOddsRows(page);
  }

  if (!rows.length && !target.isProp) {
    await clickVisibleTab(page, target.tabLabels);
    await selectLine(page, target.line);
    await page.waitForTimeout(2000);
    rows = await extractOddsRows(page);
  }

  if (!rows.length) {
    return {
      ok: false,
      closingOdds: null,
      bookmakerUsed: null,
      matchUrl,
      provisional: false,
      code: "odds_not_found",
      detail: "Inga bookmaker-odds synliga på OddsPortal-sidan.",
    };
  }

  const flat = rows
    .map((r) => {
      const odds = pickColumnOdds(r, target.column);
      return odds != null ? { bookmaker: r.bookmaker, odds } : null;
    })
    .filter((r): r is { bookmaker: string; odds: number } => r != null);

  const picked = pickBookmakerOdds(flat, input.bookmaker);
  if (!picked) {
    return {
      ok: false,
      closingOdds: null,
      bookmakerUsed: null,
      matchUrl,
      provisional: false,
      code: "odds_not_found",
      detail: `Hittade odds men inte kolumnen "${target.column}".`,
    };
  }

  const detail = provisional
    ? `Live-odds ${picked.row.odds.toFixed(2)} från ${picked.matchedAs} (match ej startad — ej slutgiltig closing).`
    : `Closing ${picked.row.odds.toFixed(2)} från ${picked.matchedAs} via OddsPortal.`;

  return {
    ok: true,
    closingOdds: picked.row.odds,
    bookmakerUsed: picked.matchedAs,
    matchUrl,
    provisional,
    detail,
  };
}

/** Full search + closing scrape with its own browser lifecycle. */
export async function scrapeClosingForBet(input: ScrapeBetInput): Promise<ScrapeClosingResult> {
  return withScrapeLock(async () => {
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const page = await newPage(browser);
      const found = await searchMatch(page, input);
      if (!found.ok || !found.url) {
        return {
          ok: false,
          closingOdds: null,
          bookmakerUsed: null,
          matchUrl: null,
          provisional: false,
          code: found.code || "match_not_found",
          detail: found.detail,
        };
      }
      return await fetchClosingFromMatch(page, found.url, input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        closingOdds: null,
        bookmakerUsed: null,
        matchUrl: null,
        provisional: false,
        code: "browser_error",
        detail: msg,
      };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  });
}
