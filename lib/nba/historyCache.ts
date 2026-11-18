// Lokal cache av NBA-historiken som modellen räknar på (box och stintar).
//
// Varje prognoskörning läste tidigare 420 dagars spelarrader och 800 dagars
// stintar ur Neon, och det åt upp gratisplanens 5 GB dataöverföring på nio
// dagar i november 2026. Slutspelade matcher ändras nästan aldrig, så de sparas
// här och bara matcher vars `updatedAt` ändrats hämtas igen.
//
// Bara lokala skript använder cachen; på Vercel läses allt som förut.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NbaPrisma } from "../nbaDb";
import { withDbRetry } from "../nbaDbRetry";

export const CACHE_VERSION = 1;
const CHUNK = 200;

export type TeamRaw = Awaited<ReturnType<NbaPrisma["nbaTeamGame"]["findMany"]>>[number];
export const PLAYER_SELECT = {
  gameId: true,
  playerId: true,
  teamId: true,
  minutes: true,
  fga2: true,
  fgm2: true,
  fga3: true,
  fgm3: true,
  fta: true,
  ftm: true,
  oreb: true,
  dreb: true,
  ast: true,
  tov: true,
  dnp: true,
  dnpReason: true,
  starter: true,
} as const;
export type PlayerRaw = Awaited<ReturnType<NbaPrisma["nbaPlayerGame"]["findMany"]>>[number] extends infer R
  ? Pick<R, Extract<keyof R, keyof typeof PLAYER_SELECT>>
  : never;
export interface StintRaw {
  homeIds: number[];
  awayIds: number[];
  homePts: number;
  awayPts: number;
  poss: number;
}

export interface CachedGame {
  id: number;
  /** NbaGame.updatedAt — ändras när box eller stintar sparas om. */
  version: string;
  startAt: string;
  periods: number | null;
  homeTeamId: number;
  awayTeamId: number;
  hasBox: boolean;
  team: TeamRaw[];
  players: PlayerRaw[];
  /** null = stintarna inte hämtade (cachen byggdes av en körning som inte behövde dem). */
  stints: StintRaw[] | null;
}

/** Matcher att hämta (nya eller ändrade) och att släppa (finns inte längre). */
export function planRefresh(cached: Map<number, string>, current: { id: number; version: string }[]): { fetch: number[]; drop: number[] } {
  const now = new Set(current.map((c) => c.id));
  return {
    fetch: current.filter((c) => cached.get(c.id) !== c.version).map((c) => c.id),
    drop: [...cached.keys()].filter((id) => !now.has(id)),
  };
}

/** Tom cache när filen saknas, är trasig eller har en annan version. */
export function readCache(file: string): Map<number, CachedGame> {
  try {
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: number; games?: CachedGame[] };
    if (raw.version !== CACHE_VERSION || !Array.isArray(raw.games)) return new Map();
    return new Map(raw.games.map((g) => [g.id, g]));
  } catch {
    return new Map();
  }
}

/** Egen tmp-fil per process, så att två samtidiga körningar inte skriver i samma. */
export function cacheTmpFile(file: string): string {
  return `${file}.${process.pid}.tmp`;
}

/** Skriver via en tmp-fil, så att en avbruten körning inte lämnar en halv cache. */
export function writeCache(file: string, games: Map<number, CachedGame>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = cacheTmpFile(file);
  writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, games: [...games.values()] }));
  renameSync(tmp, file);
}

export function historyCacheFile(): string | null {
  return process.env.VERCEL ? null : path.join(".cache", "nba", "history.json");
}

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/**
 * Bringar cachen i kapp med databasen för färdiga matcher sedan `since` och
 * returnerar dem, äldst först. Äldre matcher i cachen lämnas orörda — de
 * behövs av körningar med längre fönster (stintarna läses 800 dagar bakåt).
 */
export async function syncCache(
  db: NbaPrisma,
  since: Date,
  opts: { withStints: boolean; file?: string; log?: (m: string) => void }
): Promise<CachedGame[]> {
  const file = opts.file ?? historyCacheFile();
  if (!file) throw new Error("NBA-cachen används inte på Vercel");
  const cache = readCache(file);
  const current = await withDbRetry(
    db,
    () =>
      db.nbaGame.findMany({
        where: { status: "final", startAt: { gte: since } },
        select: { id: true, updatedAt: true, startAt: true, periods: true, homeTeamId: true, awayTeamId: true, boxFetchedAt: true },
      }),
    { label: "matchlista", log: opts.log }
  );
  const inWindow = new Map([...cache].filter(([, g]) => new Date(g.startAt) >= since).map(([id, g]) => [id, g.version]));
  const plan = planRefresh(
    inWindow,
    current.map((g) => ({ id: g.id, version: g.updatedAt.toISOString() }))
  );
  for (const id of plan.drop) cache.delete(id);

  const fetchSet = new Set(plan.fetch);
  for (const g of current) {
    if (!fetchSet.has(g.id)) continue;
    cache.set(g.id, {
      id: g.id,
      version: g.updatedAt.toISOString(),
      startAt: g.startAt.toISOString(),
      periods: g.periods,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      hasBox: g.boxFetchedAt != null,
      team: [],
      players: [],
      stints: null,
    });
  }

  const boxIds = plan.fetch.filter((id) => cache.get(id)!.hasBox);
  for (const ids of chunks(boxIds)) {
    const [team, players] = await withDbRetry(
      db,
      () =>
        Promise.all([
          db.nbaTeamGame.findMany({ where: { gameId: { in: ids } } }),
          db.nbaPlayerGame.findMany({ where: { gameId: { in: ids } }, select: PLAYER_SELECT }),
        ]),
      { label: "box", log: opts.log }
    );
    for (const r of team) cache.get(r.gameId)!.team.push(r);
    for (const r of players) cache.get(r.gameId)!.players.push(r);
  }

  let stintGames = 0;
  if (opts.withStints) {
    const need = current.map((g) => g.id).filter((id) => cache.get(id)!.stints === null);
    stintGames = need.length;
    for (const ids of chunks(need)) {
      const rows = await withDbRetry(
        db,
        () =>
          db.nbaStint.findMany({
            where: { gameId: { in: ids } },
            select: { gameId: true, homeIds: true, awayIds: true, homePts: true, awayPts: true, poss: true },
            orderBy: { id: "asc" },
          }),
        { label: "stintar", log: opts.log }
      );
      for (const id of ids) cache.get(id)!.stints = [];
      for (const { gameId, ...s } of rows) cache.get(gameId)!.stints!.push(s);
    }
  }

  if (plan.fetch.length || plan.drop.length || stintGames) {
    try {
      writeCache(file, cache);
    } catch (e) {
      // Datan i minnet stämmer ändå — hellre en körning utan sparad cache än ingen körning.
      opts.log?.(`kunde inte skriva NBA-cachen: ${(e as Error).message}`);
    }
  }
  opts.log?.(
    `historik: ${current.length - plan.fetch.length} matcher ur cachen, ${plan.fetch.length} hämtade` +
      (opts.withStints ? `, stintar hämtade för ${stintGames}` : "")
  );
  return current
    .map((g) => cache.get(g.id)!)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}
