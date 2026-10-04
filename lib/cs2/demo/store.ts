// Skriver demoanalysen till CS2-databasen och kontrollerar den mot HLTV.

import type { PrismaClient } from ".prisma/cs2-client";
import type { DemoAnalysis, DemoTeam } from "./analyze";
import type { LineupPlayer } from "./link";
import { addToGrid, type GridCells } from "./places";
import { DEMO_FACTS_VERSION } from "./types";

export async function loadPlaceGrid(db: PrismaClient, mapName: string): Promise<GridCells> {
  const row = await db.cs2PlaceGrid.findUnique({ where: { mapName } });
  return (row?.cells as unknown as GridCells) ?? {};
}

export async function mergePlaceGrid(
  db: PrismaClient,
  mapName: string,
  samples: Array<[number, number, number, string]>
): Promise<GridCells> {
  const current = await loadPlaceGrid(db, mapName);
  const cells = addToGrid(current, samples);
  const total = Object.values(cells).reduce((s, [, n]) => s + n, 0);
  await db.cs2PlaceGrid.upsert({
    where: { mapName },
    create: { mapName, cellSize: 96, cells: cells as unknown as object, samples: total },
    update: { cells: cells as unknown as object, samples: total },
  });
  return cells;
}

export interface KillCheck {
  nickname: string;
  demo: number;
  hltv: number;
}

/**
 * Jämför demons kills med HLTV:s scoreboard. Avvikelser betyder nästan alltid
 * fel spelarlänk eller fel avgränsning av rundor (knivrunda, omstart).
 */
export function compareKills(
  analysis: DemoAnalysis,
  links: Map<string, LineupPlayer>,
  hltvKills: Map<number, number>
): KillCheck[] {
  const out: KillCheck[] = [];
  for (const [steamId, kills] of Object.entries(analysis.killTotals)) {
    const l = links.get(steamId);
    if (!l) continue;
    const h = hltvKills.get(l.playerId);
    if (h == null) continue;
    if (h !== kills) out.push({ nickname: l.nickname, demo: kills, hltv: h });
  }
  return out;
}

/** Stämmer demons rundvinnare med HLTV:s rundhistorik (givet lagkopplingen)? */
export function roundsAgree(
  analysis: DemoAnalysis,
  teamIds: Record<DemoTeam, number | null>,
  map: { team1Id: number; roundHistory: unknown }
): boolean | null {
  const hist = Array.isArray(map.roundHistory) ? (map.roundHistory as Array<{ n: number; winner: "team1" | "team2" }>) : null;
  if (!hist || hist.length === 0) return null;
  if (hist.length !== analysis.roundWinners.length) return false;
  return analysis.roundWinners.every((rw, i) => {
    const winnerId = teamIds[rw.team];
    const hltvWinner = hist[i].winner === "team1" ? map.team1Id : null;
    return hltvWinner != null ? winnerId === hltvWinner : winnerId !== map.team1Id;
  });
}

export async function storeDemoAnalysis(
  db: PrismaClient,
  mapId: number,
  analysis: DemoAnalysis,
  links: Map<string, LineupPlayer>,
  teamIds: Record<DemoTeam, number | null>
): Promise<{ teamRows: number; playerRows: number }> {
  await db.cs2DemoTeamMap.deleteMany({ where: { mapId } });
  await db.cs2DemoPlayerMap.deleteMany({ where: { mapId } });

  const teamRows: Array<{ mapId: number; teamId: number; side: string; facts: object }> = [];
  for (const team of ["A", "B"] as const) {
    const teamId = teamIds[team];
    if (teamId == null) continue;
    for (const side of ["ct", "t"] as const) {
      const facts = analysis.teams[team][side];
      if (facts.rounds.length === 0) continue;
      teamRows.push({ mapId, teamId, side, facts: facts as unknown as object });
    }
  }
  if (teamRows.length) await db.cs2DemoTeamMap.createMany({ data: teamRows });

  const playerRows = analysis.players.map((p) => {
    const l = links.get(p.steamId);
    return {
      mapId,
      steamId: p.steamId,
      playerId: l?.playerId ?? null,
      name: p.name,
      teamId: teamIds[p.team],
      side: p.side,
      facts: p.facts as unknown as object,
    };
  });
  if (playerRows.length) await db.cs2DemoPlayerMap.createMany({ data: playerRows, skipDuplicates: true });

  // Spara automatiska länkar — men skriv aldrig över en manuell rättning.
  for (const [steamId, l] of links) {
    const existing = await db.cs2SteamLink.findUnique({ where: { steamId } });
    if (existing?.source === "manual") continue;
    await db.cs2SteamLink.upsert({
      where: { steamId },
      create: { steamId, playerId: l.playerId, source: "auto" },
      update: { playerId: l.playerId },
    });
  }

  await db.cs2Map.update({ where: { id: mapId }, data: { demoParsedAt: new Date(), demoVersion: DEMO_FACTS_VERSION } });
  return { teamRows: teamRows.length, playerRows: playerRows.length };
}
