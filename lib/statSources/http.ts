// JSON från öppna API:er (ESPN, NHL) med diskcache och lugn takt. Vanlig
// fetch räcker — ingen skrapning, ingen Scrapling.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const STATS_CACHE_DIR = process.env.STATS_CACHE_DIR || ".cache/stats";

export interface JsonCacheOptions {
  cacheDir?: string;
  /** Minsta väntan mellan anrop mot nätet. */
  throttleMs?: number;
  /** Egen fetch (tester). */
  fetchImpl?: typeof fetch;
}

export function jsonCacheFile(cacheDir: string, url: string): string {
  const u = new URL(url);
  const safe = (u.host + u.pathname + u.search).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
  return path.join(cacheDir, `${safe}__${hash}.json`);
}

export class JsonCache {
  fetched = 0;
  cacheHits = 0;
  private lastCall = 0;
  private readonly cacheDir: string;
  private readonly throttleMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JsonCacheOptions = {}) {
    this.cacheDir = opts.cacheDir ?? STATS_CACHE_DIR;
    this.throttleMs = opts.throttleMs ?? 300;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** JSON för `url`, ur cachen om den är färsk nog. Null vid 404 (cachas inte). */
  async get<T = unknown>(url: string, maxAgeMs: number): Promise<T | null> {
    const file = jsonCacheFile(this.cacheDir, url);
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs <= maxAgeMs) {
        this.cacheHits += 1;
        return JSON.parse(await fs.readFile(file, "utf8")) as T;
      }
    } catch {
      // Inte cachad än.
    }
    const wait = this.throttleMs - (Date.now() - this.lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
    const res = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
    this.fetched += 1;
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${new URL(url).host} svarade ${res.status} på ${url}`);
    const json = (await res.json()) as T;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(json), "utf8");
    return json;
  }
}

/** Hur länge svar får ligga i cachen. */
export const STATS_MAX_AGE = {
  /** Spelade matchers statistik ändras inte. */
  finished: Infinity,
  /** Dagslistor nära i tid — resultat och tider rör sig. */
  recent: 30 * 60_000,
};

/** En dagslista är "gammal" (ändras inte längre) tre dygn efter dagen. */
export function scheduleMaxAge(day: Date): number {
  return Date.now() - day.getTime() > 3 * 86_400_000 ? STATS_MAX_AGE.finished : STATS_MAX_AGE.recent;
}
