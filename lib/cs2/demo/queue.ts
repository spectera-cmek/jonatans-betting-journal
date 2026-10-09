// Vilka demos ska laddas ner? En demo är en hel serie (alla kartor i ett
// arkiv), så urvalet görs per karta men laddas per match.
//
// Regeln följer docens SAMPLE SIZE: för varje lag och karta räcker de senaste
// K officiella kartorna inom M månader. Ordningen går efter lagens nivå
// (DEMO_TIER_LABEL): lag i kommande toppmatcher först, sedan övriga lag med
// kommande match, topp 16, resten — nyast först inom varje nivå.

/** Nivåer i demokön, lägst först. */
export const DEMO_TIER_LABEL = ["kommande toppmatch", "kommande match", "topp 16", "övriga bevakade"] as const;

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
  /** Lagets nivå (index i DEMO_TIER_LABEL). Saknas: 1 för priorityTeams, annars 3. */
  teamTier?: Map<number, number>;
}

export interface QueuedSeries {
  matchId: number;
  demoUrl: string;
  /** Kartor i serien som behövs och saknar demofakta. */
  maps: number[];
  priority: boolean;
  /** Bästa (lägsta) nivån bland seriens två lag. */
  tier: number;
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

  const tierOf = (teamId: number) => opts.teamTier?.get(teamId) ?? (opts.priorityTeams.has(teamId) ? 1 : 3);
  const series = new Map<number, QueuedSeries>();
  for (const r of needed.values()) {
    if (!r.demoUrl) continue;
    if (r.demoStatus === "unavailable") continue;
    if (r.demoStatus === "failed" && !opts.retryFailed) continue;
    let s = series.get(r.matchId);
    if (!s) {
      s = { matchId: r.matchId, demoUrl: r.demoUrl, maps: [], priority: false, tier: 3, playedAt: r.playedAt };
      series.set(r.matchId, s);
    }
    s.maps.push(r.mapId);
    if (opts.priorityTeams.has(r.team1Id) || opts.priorityTeams.has(r.team2Id)) s.priority = true;
    s.tier = Math.min(s.tier, tierOf(r.team1Id), tierOf(r.team2Id));
  }
  return [...series.values()].sort(
    (a, b) => a.tier - b.tier || Number(b.priority) - Number(a.priority) || b.playedAt.getTime() - a.playedAt.getTime()
  );
}

/** Ungefärlig storlek på ett HLTV-demoarkiv per serie, för budgeten. */
export const AVG_SERIES_GB = 0.6;
