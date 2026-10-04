// Vilka demos ska laddas ner? En demo är en hel serie (alla kartor i ett
// arkiv), så urvalet görs per karta men laddas per match.
//
// Regeln följer docens SAMPLE SIZE: för varje lag och karta räcker de senaste
// K officiella kartorna inom M månader. Lag med en kommande match går först
// ("vid behov"), sedan resten — nyast först.

export interface QueueMapRow {
  mapId: number;
  matchId: number;
  mapName: string;
  playedAt: Date;
  team1Id: number;
  team2Id: number;
  demoParsedAt: Date | null;
  demoUrl: string | null;
  demoStatus: string;
}

export interface QueueOptions {
  teams: number[];
  priorityTeams: Set<number>;
  perTeamMap: number;
  since: Date;
  retryFailed?: boolean;
}

export interface QueuedSeries {
  matchId: number;
  demoUrl: string;
  /** Kartor i serien som behövs och saknar demofakta. */
  maps: number[];
  priority: boolean;
  playedAt: Date;
}

export function buildDemoQueue(rows: QueueMapRow[], opts: QueueOptions): QueuedSeries[] {
  const teamSet = new Set(opts.teams);
  const recent = rows.filter((r) => r.playedAt >= opts.since).sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime());

  const needed = new Map<number, QueueMapRow>();
  const seenPerTeamMap = new Map<string, number>();
  for (const r of recent) {
    for (const teamId of [r.team1Id, r.team2Id]) {
      if (!teamSet.has(teamId)) continue;
      const key = `${teamId}:${r.mapName}`;
      const n = seenPerTeamMap.get(key) ?? 0;
      if (n >= opts.perTeamMap) continue;
      seenPerTeamMap.set(key, n + 1);
      if (!r.demoParsedAt) needed.set(r.mapId, r);
    }
  }

  const series = new Map<number, QueuedSeries>();
  for (const r of needed.values()) {
    if (!r.demoUrl) continue;
    if (r.demoStatus === "unavailable") continue;
    if (r.demoStatus === "failed" && !opts.retryFailed) continue;
    let s = series.get(r.matchId);
    if (!s) {
      s = { matchId: r.matchId, demoUrl: r.demoUrl, maps: [], priority: false, playedAt: r.playedAt };
      series.set(r.matchId, s);
    }
    s.maps.push(r.mapId);
    if (opts.priorityTeams.has(r.team1Id) || opts.priorityTeams.has(r.team2Id)) s.priority = true;
  }
  return [...series.values()].sort(
    (a, b) => Number(b.priority) - Number(a.priority) || b.playedAt.getTime() - a.playedAt.getTime()
  );
}

/** Ungefärlig storlek på ett HLTV-demoarkiv per serie, för budgeten. */
export const AVG_SERIES_GB = 0.6;
