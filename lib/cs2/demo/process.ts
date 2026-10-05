// En demofil → demofakta i DB. Delas av nedladdningsflödet, --file och
// --reanalyze i scripts/cs2/demos.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PrismaClient } from ".prisma/cs2-client";
import { canonicalMap } from "../maps";
import { analyzeDemo } from "./analyze";
import { mergeDemoParts } from "./merge";
import { linkPlayers, linkTeams, type LineupPlayer } from "./link";
import { normalizeRaw, readRawDemo, type DemoparserApi } from "./parseDemo";
import { placeAt } from "./places";
import { compareKills, loadPlaceGrid, mergePlaceGrid, roundsAgree, storeDemoAnalysis, type KillCheck } from "./store";
import type { NormalizedDemo } from "./types";

export interface ProcessResult {
  mapId: number;
  mapName: string;
  rounds: number;
  linkedPlayers: number;
  killDiffs: KillCheck[];
  roundsOk: boolean | null;
  missingFields: string[];
  /** Antal demofiler kartan bestod av (fler än 1 efter en omstart). */
  parts?: number;
}

export function normCacheFile(cacheDir: string, mapId: number): string {
  return path.join(cacheDir, "demos", "norm", `${mapId}.json.gz`);
}

export async function saveNormalized(cacheDir: string, mapId: number, demo: NormalizedDemo): Promise<void> {
  const file = normCacheFile(cacheDir, mapId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, gzipSync(Buffer.from(JSON.stringify(demo))));
}

export async function loadNormalized(cacheDir: string, mapId: number): Promise<NormalizedDemo | null> {
  try {
    return JSON.parse(gunzipSync(await fs.readFile(normCacheFile(cacheDir, mapId))).toString("utf8")) as NormalizedDemo;
  } catch {
    return null;
  }
}

/** Analysera en normaliserad demo för en känd karta och spara resultatet. */
export async function analyzeAndStore(
  db: PrismaClient,
  mapId: number,
  demo: NormalizedDemo,
  opts: { mergeGrid: boolean }
): Promise<ProcessResult> {
  const map = await db.cs2Map.findUnique({ where: { id: mapId } });
  if (!map) throw new Error(`Kartan ${mapId} finns inte i DB`);

  const grid = opts.mergeGrid ? await mergePlaceGrid(db, map.mapName, demo.gridSamples) : await loadPlaceGrid(db, map.mapName);
  const analysis = analyzeDemo(demo, (x, y, z) => placeAt(grid, x, y, z));

  const lineupRows = await db.cs2PlayerMap.findMany({ where: { mapId, side: "all" }, select: { playerId: true, nickname: true, teamId: true, kills: true } });
  const lineup: LineupPlayer[] = lineupRows.map((r) => ({ playerId: r.playerId, nickname: r.nickname, teamId: r.teamId }));
  const knownRows = await db.cs2SteamLink.findMany({ where: { steamId: { in: demo.players.map((p) => p.steamId) } } });
  const links = linkPlayers(demo.players, lineup, new Map(knownRows.map((k) => [k.steamId, k.playerId])));

  const teams = await db.cs2Team.findMany({ where: { id: { in: [map.team1Id, map.team2Id] } }, select: { id: true, name: true } });
  const teamIds = linkTeams(
    analysis.teamOf,
    links,
    new Map(demo.players.map((p) => [p.steamId, p.clan])),
    teams
  );

  const killDiffs = compareKills(analysis, links, new Map(lineupRows.map((r) => [r.playerId, r.kills])));
  const roundsOk = roundsAgree(analysis, teamIds, map);
  await storeDemoAnalysis(db, mapId, analysis, links, teamIds);

  return {
    mapId,
    mapName: map.mapName,
    rounds: demo.rounds.length,
    linkedPlayers: links.size,
    killDiffs,
    roundsOk,
    missingFields: demo.missingFields,
  };
}

/** Delnumret i ett filnamn ("…-inferno-p2.dem" → 2, utan nummer → 0), för spelordningen. */
export function partNumber(file: string): number {
  const m = path.basename(file).match(/[-_. ]p?(\d{1,2})\.dem$/i);
  return m ? Number(m[1]) : 0;
}

/**
 * Tolka demofilerna ur en matchs arkiv. Kartan hittas via varje fils header
 * (de_nuke → nuke). Flera filer för samma karta (omstart) fogas ihop i
 * delnummerordning. Kartor som inte finns i matchen hoppas över.
 */
export async function processDemoFiles(
  db: PrismaClient,
  api: DemoparserApi,
  files: string[],
  matchId: number,
  cacheDir: string
): Promise<{ results: ProcessResult[]; errors: string[] }> {
  const errors: string[] = [];
  const byMap = new Map<string, string[]>();
  for (const file of files) {
    try {
      const header = api.parseHeader(file) ?? {};
      const mapName = canonicalMap(String(header.map_name ?? header.mapname ?? ""));
      if (!mapName) throw new Error("kartnamn saknas i demons header");
      byMap.set(mapName, [...(byMap.get(mapName) ?? []), file]);
    } catch (err) {
      errors.push(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const results: ProcessResult[] = [];
  for (const [mapName, group] of byMap) {
    try {
      const map = await db.cs2Map.findFirst({ where: { matchId, mapName } });
      if (!map) continue;
      const expectedRounds = map.team1Rounds + map.team2Rounds;
      const ordered = [...group].sort((a, b) => partNumber(a) - partNumber(b) || a.localeCompare(b));
      const parts = ordered.map((file) => normalizeRaw(readRawDemo(api, file, { expectedRounds }), { expectedRounds }));
      const demo = parts.length === 1 ? parts[0] : mergeDemoParts(parts, expectedRounds);
      await saveNormalized(cacheDir, map.id, demo);
      const res = await analyzeAndStore(db, map.id, demo, { mergeGrid: true });
      results.push({ ...res, parts: parts.length });
    } catch (err) {
      errors.push(`${mapName} (${group.map((f) => path.basename(f)).join(", ")}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { results, errors };
}

/** En enskild .dem (scripts/cs2/demos.ts --file). Null om kartan inte finns i matchen. */
export async function processDemoFile(
  db: PrismaClient,
  api: DemoparserApi,
  file: string,
  matchId: number,
  cacheDir: string
): Promise<ProcessResult | null> {
  const { results, errors } = await processDemoFiles(db, api, [file], matchId, cacheDir);
  if (errors.length) throw new Error(errors.join("; "));
  return results[0] ?? null;
}
