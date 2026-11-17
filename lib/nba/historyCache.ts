// Lokal cache för OddsPapi-historiken (gratis endpoint, ~5 s per match).
// En fil per fixture under .claude/oddspapi-history/ (relativt arbetskatalogen,
// eller NBA_HISTORY_CACHE). Används av nba:lag-scan och nba:props-history.

import fs from "node:fs";
import path from "node:path";
import { getHistoricalOdds, oddspapiRetry, OddspapiError, type OpHistoricalOdds } from "../oddspapi";

export function historyCacheDir(): string {
  return process.env.NBA_HISTORY_CACHE ?? path.join(".claude", "oddspapi-history");
}

export function historyCacheFile(fixtureId: string): string {
  return path.join(historyCacheDir(), `${fixtureId}.json`);
}

/** Läser bara cachen. null = saknas, tom (404) eller trasig fil. */
export function readCachedHistory(fixtureId: string): OpHistoricalOdds | null {
  const file = historyCacheFile(fixtureId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as OpHistoricalOdds | null;
  } catch {
    return null;
  }
}

/**
 * Historiken för en fixture: ur cachen om alla `books` finns där, annars
 * hämtad (när `fetch` inte är false) och sparad. Ett 404 sparas som null.
 */
export async function cachedHistory(fixtureId: string, books: string[], opts: { fetch?: boolean } = {}): Promise<OpHistoricalOdds | null> {
  const file = historyCacheFile(fixtureId);
  if (fs.existsSync(file)) {
    const h = readCachedHistory(fixtureId);
    if (!h || books.every((b) => h.bookmakers?.[b]) || opts.fetch === false) return h;
  } else if (opts.fetch === false) {
    return null;
  }
  let h: OpHistoricalOdds | null = null;
  try {
    h = await oddspapiRetry(() => getHistoricalOdds(fixtureId, books), 5);
  } catch (e) {
    if (!(e instanceof OddspapiError && e.statusCode === 404)) throw e;
  }
  fs.mkdirSync(historyCacheDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(h));
  return h;
}
