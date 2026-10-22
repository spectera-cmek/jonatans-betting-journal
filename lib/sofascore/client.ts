// Hämtar Sofascores JSON via Scrapling. Körs bara lokalt (skripten), aldrig
// från Next/Vercel.
//
// Samma principer som HLTV-sessionen (lib/cs2/hltv/session.ts):
//  1. Varje svar sparas på disk (.cache/sofascore). Färdiga matcher hämtas
//     aldrig om; listor får en maxålder.
//  2. Långsam takt med slump (standard 1,5–3 s) och ett tak per körning.
//  3. Flera vägar in, billigast först: HTTP-läget (TLS-fingeravtryck som en
//     riktig Chrome) mot www- och api-adressen, sedan webbläsaren (som först
//     besöker sofascore.com för cookies). Svarar en väg 403 provas nästa; den
//     som fungerar används resten av körningen.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ScraplingWorker } from "../scrapling";
import { SOFASCORE_API_BASES, SOFASCORE_SITE } from "./api";

export const SOFASCORE_CACHE_DIR = process.env.SOFASCORE_CACHE_DIR || ".cache/sofascore";

export class SofascoreBlockedError extends Error {
  constructor(apiPath: string, tried: string[], lastBody: string) {
    super(
      `Sofascore svarade 403 på ${apiPath} på alla vägar (${tried.join(", ")}). ` +
        `Senaste svaret: ${lastBody.replace(/\s+/g, " ").slice(0, 160) || "(tomt)"}\n` +
        `Vanliga orsaker: VPN/moln-IP, eller att adressen spärrats en stund efter många anrop. ` +
        `Öppna ${SOFASCORE_API_BASES[0]}/sport/football/scheduled-events/${new Date().toISOString().slice(0, 10)} i din vanliga webbläsare — syns JSON där men inte här, säg till.`
    );
  }
}

/** En väg in till API:et. */
export interface SofaRoute {
  mode: "http" | "browser";
  base: string;
}

export const SOFA_ROUTES: SofaRoute[] = [
  ...SOFASCORE_API_BASES.map((base) => ({ mode: "http" as const, base })),
  ...SOFASCORE_API_BASES.map((base) => ({ mode: "browser" as const, base })),
];

export class SofascoreBudgetError extends Error {
  constructor(max: number) {
    super(`Taket på ${max} Sofascore-anrop för den här körningen är nått. Kör igen senare — cachen gör att inget hämtas om.`);
  }
}

export interface SofascoreClientOptions {
  /** Minsta väntan mellan anrop i ms. Faktisk väntan är slumpad upp till 2×. */
  throttleMs?: number;
  /** Max antal anrop mot nätet per körning (cacheträffar räknas inte). */
  maxRequests?: number;
  cacheDir?: string;
  /** Läs bara från cachen. */
  offline?: boolean;
  /** Egen worker (tester, eller för att dela den med andra hämtningar). */
  worker?: ScraplingWorker;
  log?: (line: string) => void;
}

export function sofaCacheFile(cacheDir: string, apiPath: string): string {
  const safe = apiPath.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  const hash = createHash("sha1").update(apiPath).digest("hex").slice(0, 10);
  return path.join(cacheDir, `${safe}__${hash}.json`);
}

/** JSON som Chromium visar den: inlindad i <pre>. */
export function jsonFromBrowserPage(html: string): string {
  const m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const raw = m ? m[1] : html;
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeRoute(r: SofaRoute): string {
  return `${r.mode === "http" ? "HTTP" : "webbläsare"} ${new URL(r.base).host}`;
}

export class SofascoreClient {
  /** Anrop mot nätet i den här körningen. */
  fetched = 0;
  cacheHits = 0;

  private readonly cacheDir: string;
  private readonly throttleMs: number;
  private readonly maxRequests: number;
  private readonly ownsWorker: boolean;
  private readonly worker: ScraplingWorker;
  private lastCall = 0;
  /** Index i SOFA_ROUTES för vägen som används just nu. */
  private route = 0;
  private warmedUp = false;

  constructor(private readonly opts: SofascoreClientOptions = {}) {
    this.cacheDir = opts.cacheDir ?? SOFASCORE_CACHE_DIR;
    this.throttleMs = opts.throttleMs ?? (Number(process.env.SOFASCORE_THROTTLE_MS) || 1500);
    this.maxRequests = opts.maxRequests ?? (Number(process.env.SOFASCORE_MAX_REQUESTS) || 800);
    this.ownsWorker = !opts.worker;
    this.worker =
      opts.worker ??
      new ScraplingWorker({
        profileDir: path.join(this.cacheDir, "scrapling-profile"),
        onLog: (line) => {
          if (/error|warn|cloudflare/i.test(line) && !/No Cloudflare challenge found/i.test(line)) this.log(`    ${line}`);
        },
      });
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }

  private async throttle(): Promise<void> {
    const wait = this.throttleMs + Math.random() * this.throttleMs;
    const since = Date.now() - this.lastCall;
    if (since < wait) await sleep(wait - since);
    this.lastCall = Date.now();
  }

  private async readCache(file: string, maxAgeMs: number): Promise<unknown | undefined> {
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > maxAgeMs) return undefined;
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  /**
   * JSON för en API-sökväg (t.ex. "/event/123/statistics"), ur cachen om den
   * är färsk nog. Null om Sofascore svarar 404 — t.ex. lineups som inte finns.
   */
  async get<T = unknown>(apiPath: string, maxAgeMs = Infinity): Promise<T | null> {
    const file = sofaCacheFile(this.cacheDir, apiPath);
    const hit = await this.readCache(file, maxAgeMs);
    if (hit !== undefined) {
      this.cacheHits += 1;
      return hit as T | null;
    }
    if (this.opts.offline) {
      const stale = await this.readCache(file, Infinity);
      if (stale !== undefined) return stale as T | null;
      throw new Error(`Saknas i cachen (offline): ${apiPath}`);
    }
    if (this.fetched >= this.maxRequests) throw new SofascoreBudgetError(this.maxRequests);

    let body: string | null = null;
    let lastUrl = "";
    let last403 = "";
    for (let attempt = 0; attempt < 3 && body === null; ) {
      const route = SOFA_ROUTES[this.route];
      if (!route) throw new SofascoreBlockedError(apiPath, SOFA_ROUTES.map(describeRoute), last403);
      if (route.mode === "browser" && !this.warmedUp) {
        // En riktig besökare kommer via startsidan — det ger cookies.
        this.warmedUp = true;
        await this.throttle();
        await this.worker.fetch({ mode: "browser", url: SOFASCORE_SITE }).catch(() => undefined);
      }
      lastUrl = route.base + apiPath;
      await this.throttle();
      const res = await this.worker.fetch({
        mode: route.mode,
        url: lastUrl,
        headers: { Referer: SOFASCORE_SITE, Origin: SOFASCORE_SITE.replace(/\/$/, "") },
      });
      this.fetched += 1;
      // Inte cachad: lineups och statistik kan dyka upp en stund efter matchen.
      if (res.status === 404) return null;
      if (res.status === 403) {
        last403 = res.body;
        this.route += 1;
        const next = SOFA_ROUTES[this.route];
        if (next) this.log(`    Sofascore svarade 403 (${describeRoute(route)}) — provar ${describeRoute(next)}.`);
        continue;
      }
      attempt += 1;
      if (res.status === 429 || res.status >= 500) {
        this.log(`    Sofascore svarade ${res.status} — väntar och försöker igen.`);
        await sleep(10_000 * attempt);
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`Sofascore svarade ${res.status} på ${lastUrl}`);
      body = route.mode === "browser" ? jsonFromBrowserPage(res.body) : res.body;
    }
    if (body === null) throw new Error(`Sofascore svarade inte på ${lastUrl} efter tre försök`);
    const url = lastUrl;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`Sofascores svar på ${url} var inte JSON (${body.slice(0, 80)}…)`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(parsed), "utf8");
    return parsed as T | null;
  }

  async close(): Promise<void> {
    if (this.ownsWorker) await this.worker.close();
  }
}

/** Hur länge olika svar får ligga i cachen. */
export const SOFA_MAX_AGE = {
  /** Spelade matchers statistik ändras inte. */
  finished: Infinity,
  /** Dagslistor och säsongslistor — resultat och tider rör sig. */
  schedule: 3 * 3_600_000,
  seasons: 7 * 86_400_000,
};
