// Laguppställningar: vem som spelar i en kommande match jämfört med lagets
// vanliga femma. En saknad stjärna eller en stand-in ändrar lagets nivå mer
// än modellen (som räknar per lag) ser, så matchsidan varnar för det.

export interface LineupMapRow {
  mapId: number;
  playedAt: Date;
  playerId: number;
  nickname: string;
  kills: number;
}

export interface LineupPlayerOut {
  playerId: number;
  nickname: string;
  /** Andel av lagets kills på de senaste kartorna (0–1). */
  killShare: number;
  maps: number;
}

export interface LineupPlayerIn {
  playerId: number;
  nickname: string;
  /** Kartor med laget bland de senaste. 0 = ny eller stand-in. */
  mapsWithTeam: number;
}

export interface LineupChange {
  teamId: number;
  out: LineupPlayerOut[];
  in: LineupPlayerIn[];
  /** Kartor som den vanliga femman bygger på. */
  basis: number;
}

/** Antal av lagets senaste kartor som avgör den vanliga femman. */
export const LINEUP_RECENT_MAPS = 10;

/**
 * Lagets vanliga femma = spelarna med flest av de senaste kartorna (minst
 * hälften). Jämförs med `current`: matchens uppställning, eller truppen
 * (då med `reportNew: false`).
 */
export function lineupChange(
  teamId: number,
  rows: LineupMapRow[],
  current: Array<{ playerId: number; nickname: string }>,
  opts: { recent?: number; reportNew?: boolean } = {}
): LineupChange | null {
  const recent = opts.recent ?? LINEUP_RECENT_MAPS;
  const mapIds = [...new Map(rows.map((r) => [r.mapId, r.playedAt.getTime()]))]
    .sort((a, b) => b[1] - a[1])
    .slice(0, recent)
    .map(([id]) => id);
  if (mapIds.length < 3 || current.length === 0) return null;
  const inWindow = new Set(mapIds);
  const win = rows.filter((r) => inWindow.has(r.mapId));
  const teamKills = win.reduce((a, r) => a + r.kills, 0);

  const per = new Map<number, { nickname: string; maps: number; kills: number }>();
  for (const r of win) {
    const e = per.get(r.playerId) ?? { nickname: r.nickname, maps: 0, kills: 0 };
    e.maps += 1;
    e.kills += r.kills;
    per.set(r.playerId, e);
  }
  const usual = [...per.entries()]
    .filter(([, e]) => e.maps * 2 >= mapIds.length)
    .sort((a, b) => b[1].maps - a[1].maps)
    .slice(0, 5);
  const cur = new Set(current.map((p) => p.playerId));
  const usualIds = new Set(usual.map(([id]) => id));

  const out: LineupPlayerOut[] = usual
    .filter(([id]) => !cur.has(id))
    .map(([playerId, e]) => ({ playerId, nickname: e.nickname, killShare: teamKills > 0 ? e.kills / teamKills : 0, maps: e.maps }));
  // Truppen från lagsidan kan ha en sjätte man eller tränare med — nya
  // spelare rapporteras bara när matchens egen uppställning är känd.
  const inn: LineupPlayerIn[] = (opts.reportNew ?? true ? current : [])
    .filter((p) => !usualIds.has(p.playerId))
    .map((p) => ({ playerId: p.playerId, nickname: p.nickname, mapsWithTeam: per.get(p.playerId)?.maps ?? 0 }));
  if (out.length === 0 && inn.length === 0) return null;
  return { teamId, out, in: inn, basis: mapIds.length };
}
