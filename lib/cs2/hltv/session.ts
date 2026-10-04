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
//
// Cloudflare känner igen automatiserade webbläsare. Därför används
// patchright när det finns (Playwright utan felsökningsspåren), den
// installerade Chrome i stället för testbygget, och inga avlyssnade anrop.
// Räcker inte det: starta en vanlig Chrome med
// fjärrfelsökning och sätt CS2_CDP_URL — då kopplar skripten upp sig mot den
// i stället för att starta en egen.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";

type Chromium = BrowserType;
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

  private browser: Browser | null = null;

  constructor(private readonly opts: HltvSessionOptions = {}) {
    this.cacheDir = opts.cacheDir ?? CS2_CACHE_DIR;
    this.throttleMs = opts.throttleMs ?? (Number(process.env.CS2_HLTV_THROTTLE_MS) || 4000);
    this.maxPages = opts.maxPages ?? (Number(process.env.CS2_HLTV_MAX_PAGES) || 1500);
  }

  /**
   * patchright (en Playwright-variant som inte lämnar de spår Cloudflare
   * letar efter) om den finns, annars vanliga Playwright.
   */
  private async loadChromium(): Promise<{ chromium: Chromium; stealth: boolean }> {
    const tryImport = async (name: string): Promise<Chromium | null> => {
      try {
        return ((await import(name)) as { chromium: Chromium }).chromium;
      } catch {
        return null;
      }
    };
    // Variabelnamn så att bundlare och typkontroll inte kräver paketet.
    const stealthPkg = "patchright";
    const stealth = await tryImport(stealthPkg);
    if (stealth) return { chromium: stealth, stealth: true };
    const plain = await tryImport("playwright");
    if (plain) return { chromium: plain, stealth: false };
    throw new Error("Varken patchright eller playwright är installerat. Kör: npm i");
  }

  private async openContext(chromium: Chromium, stealth: boolean): Promise<BrowserContext> {
    const cdp = process.env.CS2_CDP_URL;
    if (cdp) {
      // En Chrome som användaren själv startat — Cloudflare ser en vanlig webbläsare.
      this.browser = await chromium.connectOverCDP(cdp);
      console.log(`  (kopplad till Chrome på ${cdp})`);
      return this.browser.contexts()[0] ?? (await this.browser.newContext());
    }
    const profile = path.join(this.cacheDir, "browser");
    await fs.mkdir(profile, { recursive: true });
    const launch = (channel: string | undefined) =>
      chromium.launchPersistentContext(
        profile,
        stealth
          ? // patchright sköter flaggorna själv; egna headers/viewport avslöjar mer än de döljer.
            { headless: !this.opts.headed, channel, acceptDownloads: true, viewport: null }
          : {
              headless: !this.opts.headed,
              channel,
              acceptDownloads: true,
              locale: "en-US",
              viewport: { width: 1400, height: 900 },
              ignoreDefaultArgs: ["--enable-automation"],
              args: ["--disable-blink-features=AutomationControlled"],
            }
      );
    const wanted = process.env.CS2_BROWSER_CHANNEL;
    if (wanted) return launch(wanted === "chromium" ? undefined : wanted);
    try {
      return await launch("chrome");
    } catch {
      console.log(`  (Chrome hittades inte — använder ${stealth ? "patchrights" : "Playwrights"} Chromium)`);
      return launch(undefined);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    const { chromium, stealth } = await this.loadChromium();
    console.log(`  (webbläsare: ${stealth ? "patchright" : "playwright"}${this.opts.headed ? ", synlig" : ""})`);
    this.context = await this.openContext(chromium, stealth);
    // Inga avlyssnade anrop (route): Cloudflare märker när de fångas upp.
    // I användarens egen Chrome: en egen flik, inte någon av de redan öppna.
    this.page = (!this.browser && this.context.pages()[0]) || (await this.context.newPage());
    this.page.setDefaultTimeout(60_000);
    return this.page;
  }

  /** Sidans HTML, eller "" medan den byter sida (efter en klarad kontroll). */
  private async readPage(page: Page): Promise<string> {
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    try {
      return await page.content();
    } catch {
      return "";
    }
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
    console.log(`  → ${urlPath}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.throttle();
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      html = await this.readPage(page);
      if (!html || isChallengePage(html)) {
        // Ge utmaningen tid att lösa sig själv (eller användaren att klicka).
        // Ingen omladdning under tiden — den skulle starta om kontrollen.
        if (this.opts.headed) console.log("    Cloudflare-kontroll: klicka i rutan i Chrome-fönstret och vänta (upp till 3 min) …");
        else console.log("    Cloudflare-kontroll — väntar 20 s. Fastnar den: kör igen med --headed.");
        const deadline = Date.now() + (this.opts.headed ? 180_000 : 20_000);
        while (Date.now() < deadline && (!html || isChallengePage(html))) {
          await sleep(2000);
          html = await this.readPage(page);
        }
        if (!html || isChallengePage(html)) {
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
    if (this.browser) {
      // Användarens egen Chrome stängs inte — bara vår flik och kopplingen.
      await this.page?.close().catch(() => undefined);
      await this.browser.close().catch(() => undefined);
    } else {
      await this.context?.close().catch(() => undefined);
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
