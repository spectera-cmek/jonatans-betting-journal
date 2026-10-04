// Playwright-session mot HLTV. Körs bara lokalt (skripten under scripts/cs2),
// aldrig från Next/Vercel — där finns ingen webbläsare.
//
// Tre principer:
//  1. Varje hämtad sida sparas på disk (.cache/cs2/html). Samma sida hämtas
//     aldrig två gånger inom sin livslängd, och en rättad parser kan köras om
//     på cachen utan ett enda nytt anrop.
//  2. Långsam takt med slump (standard 4–8 s) och ett tak per körning. HLTV
//     står bakom Cloudflare och spärrar IP:n vid för hög takt.
//  3. Persistent webbläsarprofil (.cache/cs2/browser), så en Cloudflare-
//     utmaning som klarats en gång (kör med --headed) gäller nästa körning.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { HLTV_ORIGIN } from "./urls";
import { isChallengePage } from "./parse";

export const CS2_CACHE_DIR = process.env.CS2_CACHE_DIR || ".cache/cs2";

export class HltvBlockedError extends Error {
  constructor(url: string) {
    super(
      `HLTV svarade med en Cloudflare-utmaning på ${url}. Kör om med --headed och klicka igenom utmaningen i fönstret, eller vänta en stund.`
    );
  }
}

export class HltvBudgetError extends Error {
  constructor(max: number) {
    super(`Taket på ${max} sidor för den här körningen är nått. Kör igen senare — cachen gör att inget hämtas om.`);
  }
}

export interface HltvSessionOptions {
  headed?: boolean;
  /** Minsta väntan mellan sidor i ms. Faktisk väntan är slumpad upp till 2×. */
  throttleMs?: number;
  /** Max antal sidor från nätet per körning (cacheträffar räknas inte). */
  maxPages?: number;
  /** Läs bara från cachen — kasta om en sida saknas. Används av --reparse. */
  offline?: boolean;
  cacheDir?: string;
}

export interface GetOptions {
  /** Hur gammal en cachad sida får vara. Infinity = för alltid (färdiga matcher). */
  maxAgeMs?: number;
}

export function cacheFileFor(cacheDir: string, urlPath: string): string {
  const safe = urlPath.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  const hash = createHash("sha1").update(urlPath).digest("hex").slice(0, 10);
  return path.join(cacheDir, "html", `${safe}__${hash}.html`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HltvSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastNav = 0;
  /** Sidor hämtade från nätet i den här körningen. */
  fetched = 0;
  /** Sidor lästa ur cachen. */
  cacheHits = 0;

  private readonly cacheDir: string;
  private readonly throttleMs: number;
  private readonly maxPages: number;

  constructor(private readonly opts: HltvSessionOptions = {}) {
    this.cacheDir = opts.cacheDir ?? CS2_CACHE_DIR;
    this.throttleMs = opts.throttleMs ?? (Number(process.env.CS2_HLTV_THROTTLE_MS) || 4000);
    this.maxPages = opts.maxPages ?? (Number(process.env.CS2_HLTV_MAX_PAGES) || 1500);
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    let chromium: typeof import("playwright").chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error("playwright saknas. Kör: npm i && npx playwright install chromium");
    }
    const profile = path.join(this.cacheDir, "browser");
    await fs.mkdir(profile, { recursive: true });
    this.context = await chromium.launchPersistentContext(profile, {
      headless: !this.opts.headed,
      channel: process.env.CS2_BROWSER_CHANNEL || undefined,
      acceptDownloads: true,
      locale: "en-US",
      viewport: { width: 1400, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    // Bilder och typsnitt behövs inte för att läsa sidorna — spara bandbredd.
    await this.context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(60_000);
    return this.page;
  }

  private async throttle(): Promise<void> {
    const wait = this.throttleMs + Math.random() * this.throttleMs;
    const since = Date.now() - this.lastNav;
    if (since < wait) await sleep(wait - since);
    this.lastNav = Date.now();
  }

  /** Läser en cachad sida om den finns och är färsk nog. */
  async cached(urlPath: string, maxAgeMs = Infinity): Promise<string | null> {
    const file = cacheFileFor(this.cacheDir, urlPath);
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  /** HTML för en HLTV-sökväg — ur cachen om möjligt, annars från nätet. */
  async getHtml(urlPath: string, opts: GetOptions = {}): Promise<string> {
    const hit = await this.cached(urlPath, opts.maxAgeMs ?? Infinity);
    if (hit !== null) {
      this.cacheHits += 1;
      return hit;
    }
    if (this.opts.offline) {
      // I offline-läge duger även en gammal sida — det är hela poängen.
      const stale = await this.cached(urlPath, Infinity);
      if (stale !== null) return stale;
      throw new Error(`Saknas i cachen (offline): ${urlPath}`);
    }
    if (this.fetched >= this.maxPages) throw new HltvBudgetError(this.maxPages);

    const page = await this.ensurePage();
    const url = HLTV_ORIGIN + urlPath;
    let html = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.throttle();
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      html = await page.content();
      if (isChallengePage(html)) {
        // Ge utmaningen tid att lösa sig själv (eller användaren att klicka).
        const deadline = Date.now() + (this.opts.headed ? 90_000 : 20_000);
        while (Date.now() < deadline && isChallengePage(html)) {
          await sleep(2000);
          html = await page.content();
        }
        if (isChallengePage(html)) {
          if (attempt === 2) throw new HltvBlockedError(url);
          await sleep(15_000 * (attempt + 1));
          continue;
        }
      }
      const status = res?.status() ?? 200;
      if (status === 404) throw new Error(`404 från HLTV: ${url}`);
      if (status >= 500 || status === 429) {
        await sleep(10_000 * (attempt + 1));
        continue;
      }
      break;
    }
    this.fetched += 1;
    const file = cacheFileFor(this.cacheDir, urlPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html, "utf8");
    return html;
  }

  /**
   * Laddar ner en demo (/download/demo/<id>) till `destDir`. HLTV
   * omdirigerar till sin fil-CDN; webbläsaren tar nedladdningen så samma
   * Cloudflare-session gäller.
   */
  async downloadDemo(demoPath: string, destDir: string): Promise<string> {
    if (this.opts.offline) throw new Error("Demos kan inte hämtas i offline-läge");
    const page = await this.ensurePage();
    await fs.mkdir(destDir, { recursive: true });
    await this.throttle();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      // goto kastar "Download is starting" när svaret är en fil — förväntat.
      page.goto(HLTV_ORIGIN + demoPath).catch(() => null),
    ]);
    const name = download.suggestedFilename() || `${path.basename(demoPath)}.bin`;
    const dest = path.join(destDir, name);
    await download.saveAs(dest);
    const failure = await download.failure();
    if (failure) throw new Error(`Nedladdningen misslyckades: ${failure}`);
    this.fetched += 1;
    return dest;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
  }
}
