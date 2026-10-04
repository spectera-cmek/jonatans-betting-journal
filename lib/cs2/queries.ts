// Databasläsning för CS2-sidorna. Bygger rader åt de rena aggregeringarna
// i profiles.ts och gameplan.ts — ingen räkning här utöver urval.

import type { PrismaClient } from ".prisma/cs2-client";
import type { PlayerSideFacts, RoundFact } from "./demo/types";
import { buildGameplan, type GameplanPlayer, type GameplanReport } from "./gameplan";
import { mapLabel } from "./maps";
import {
  applyWindow,
  playerMapProfiles,
  sumFacts,
  teamMapPool,
  toTeamMapRow,
  type MapPoolEntry,
  type PlayerMapProfile,
  type PlayerStatInput,
  type SampleWindow,
  type TeamMapRow,
} from "./profiles";
import type { Side } from "./types";

const DAY = 86_400_000;
const sinceOf = (months: number) => new Date(Date.now() - months * 30 * DAY);

const MAP_SELECT = {
  id: true,
  matchId: true,
  mapName: true,
  playedAt: true,
  pickedById: true,
  team1Id: true,
  team2Id: true,
  team1Rounds: true,
  team2Rounds: true,
  team1StartSide: true,
  team1CtRounds: true,
  team1TRounds: true,
  team2CtRounds: true,
  team2TRounds: true,
  otRounds: true,
  winnerId: true,
  roundHistory: true,
  demoParsedAt: true,
} as const;

async function teamNameMap(db: PrismaClient, ids: number[]): Promise<Map<number, string>> {
  const rows = await db.cs2Team.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Lag
// ---------------------------------------------------------------------------

export interface TeamListItem {
  id: number;
  name: string;
  country: string | null;
  rank: number | null;
  tracked: boolean;
  players: string[];
  maps: number;
  demoMaps: number;
  nextMatch: { id: number; startAt: string; opponent: string } | null;
}

export async function listTeams(db: PrismaClient, months = 6): Promise<TeamListItem[]> {
  const since = sinceOf(months);
  const teams = await db.cs2Team.findMany({
    orderBy: [{ tracked: "desc" }, { rank: "asc" }, { name: "asc" }],
    include: { players: { select: { nickname: true } } },
  });
  const maps = await db.cs2Map.findMany({ where: { playedAt: { gte: since } }, select: { team1Id: true, team2Id: true, demoParsedAt: true } });
  const count = new Map<number, { maps: number; demo: number }>();
  for (const m of maps) {
    for (const id of [m.team1Id, m.team2Id]) {
      const c = count.get(id) ?? { maps: 0, demo: 0 };
      c.maps++;
      if (m.demoParsedAt) c.demo++;
      count.set(id, c);
    }
  }
  const upcoming = await db.cs2Match.findMany({
    where: { status: { in: ["scheduled", "live"] }, startAt: { gte: new Date(Date.now() - 6 * 3_600_000) } },
    orderBy: { startAt: "asc" },
    select: { id: true, startAt: true, team1Id: true, team2Id: true, team1Name: true, team2Name: true },
  });
  return teams
    .filter((t) => t.tracked || (count.get(t.id)?.maps ?? 0) > 0)
    .map((t) => {
      const next = upcoming.find((m) => m.team1Id === t.id || m.team2Id === t.id);
      return {
        id: t.id,
        name: t.name,
        country: t.country,
        rank: t.rank,
        tracked: t.tracked,
        players: t.players.map((p) => p.nickname),
        maps: count.get(t.id)?.maps ?? 0,
        demoMaps: count.get(t.id)?.demo ?? 0,
        nextMatch: next
          ? { id: next.id, startAt: next.startAt.toISOString(), opponent: next.team1Id === t.id ? next.team2Name : next.team1Name }
          : null,
      };
    });
}

export interface RosterPlayer {
  id: number;
  nickname: string;
  realName: string | null;
  country: string | null;
  role: string | null;
  roleIsManual: boolean;
  maps: number;
  kpr: number | null;
  hsPct: number | null;
  rating: number | null;
}

export interface MatchListItem {
  id: number;
  startAt: string;
  status: string;
  format: string;
  eventName: string | null;
  opponentId: number | null;
  opponent: string;
  score: string | null;
  won: boolean | null;
  maps: Array<{ mapName: string; score: string; won: boolean }>;
}

export interface TeamOverview {
  team: { id: number; name: string; country: string | null; rank: number | null; tracked: boolean; rosterFetchedAt: string | null };
  roster: RosterPlayer[];
  mapPool: Array<Omit<MapPoolEntry, "lastPlayed"> & { label: string; lastPlayed: string | null }>;
  upcoming: MatchListItem[];
  recent: MatchListItem[];
  coverage: { maps: number; demoMaps: number };
  window: SampleWindow;
}

async function playerStatInputs(db: PrismaClient, where: { playerId?: number | { in: number[] }; mapId?: { in: number[] } }, since: Date): Promise<Array<PlayerStatInput & { playerId: number }>> {
  const rows = await db.cs2PlayerMap.findMany({
    where: { ...where, map: { playedAt: { gte: since } } },
    select: {
      playerId: true,
      teamId: true,
      side: true,
      kills: true,
      deaths: true,
      headshots: true,
      adr: true,
      rating: true,
      kast: true,
      mapId: true,
      map: { select: { mapName: true, playedAt: true, team1Id: true, team2Id: true, team1Rounds: true, team2Rounds: true, team1CtRounds: true, team1TRounds: true, team2CtRounds: true, team2TRounds: true } },
    },
  });
  return rows.map((r) => {
    const m = r.map;
    const isT1 = m.team1Id === r.teamId;
    // Rundor på en sida = lagets vunna + motståndarens vunna på motsatt sida.
    const ctRounds = isT1 ? (m.team1CtRounds ?? 0) + (m.team2TRounds ?? 0) : (m.team2CtRounds ?? 0) + (m.team1TRounds ?? 0);
    const tRounds = isT1 ? (m.team1TRounds ?? 0) + (m.team2CtRounds ?? 0) : (m.team2TRounds ?? 0) + (m.team1CtRounds ?? 0);
    const rounds = r.side === "ct" ? ctRounds : r.side === "t" ? tRounds : m.team1Rounds + m.team2Rounds;
    return {
      playerId: r.playerId,
      mapId: r.mapId,
      mapName: m.mapName,
      playedAt: m.playedAt,
      teamId: r.teamId,
      opponentId: isT1 ? m.team2Id : m.team1Id,
      side: r.side,
      kills: r.kills,
      deaths: r.deaths,
      headshots: r.headshots,
      adr: r.adr,
      rating: r.rating,
      kast: r.kast,
      rounds,
    };
  });
}

function toMatchItem(
  m: { id: number; startAt: Date; status: string; format: string; eventName: string | null; team1Id: number | null; team2Id: number | null; team1Name: string; team2Name: string; score1: number | null; score2: number | null; winnerId: number | null; maps?: Array<{ mapName: string; team1Rounds: number; team2Rounds: number; winnerId: number | null; mapNumber: number }> },
  teamId: number
): MatchListItem {
  const isT1 = m.team1Id === teamId;
  return {
    id: m.id,
    startAt: m.startAt.toISOString(),
    status: m.status,
    format: m.format,
    eventName: m.eventName,
    opponentId: isT1 ? m.team2Id : m.team1Id,
    opponent: isT1 ? m.team2Name : m.team1Name,
    score: m.score1 != null && m.score2 != null ? (isT1 ? `${m.score1}–${m.score2}` : `${m.score2}–${m.score1}`) : null,
    won: m.winnerId == null ? null : m.winnerId === teamId,
    maps: (m.maps ?? [])
      .sort((a, b) => a.mapNumber - b.mapNumber)
      .map((x) => ({
        mapName: x.mapName,
        score: isT1 ? `${x.team1Rounds}–${x.team2Rounds}` : `${x.team2Rounds}–${x.team1Rounds}`,
        won: x.winnerId === teamId,
      })),
  };
}

export async function loadTeam(db: PrismaClient, teamId: number, window: SampleWindow): Promise<TeamOverview | null> {
  const team = await db.cs2Team.findUnique({ where: { id: teamId } });
  if (!team) return null;
  const since = sinceOf(window.months);

  const mapRows = await db.cs2Map.findMany({
    where: { playedAt: { gte: since }, OR: [{ team1Id: teamId }, { team2Id: teamId }] },
    select: MAP_SELECT,
    orderBy: { playedAt: "desc" },
  });
  const teamRows = mapRows.map((m) => toTeamMapRow(m, teamId)).filter((r): r is TeamMapRow => r !== null);
  const vetoes = await db.cs2Veto.findMany({
    where: { match: { startAt: { gte: since }, OR: [{ team1Id: teamId }, { team2Id: teamId }] } },
    select: { matchId: true, step: true, teamId: true, action: true, mapName: true, match: { select: { startAt: true } } },
  });
  const pool = teamMapPool(
    teamRows,
    vetoes.map((v) => ({ ...v, at: v.match.startAt })),
    teamId,
    window.months
  ).map((p) => ({ ...p, label: mapLabel(p.mapName), lastPlayed: p.lastPlayed ? p.lastPlayed.toISOString() : null }));

  const players = await db.cs2Player.findMany({ where: { teamId }, orderBy: { nickname: "asc" } });
  const stats = await playerStatInputs(db, { playerId: { in: players.map((p) => p.id) } }, since);
  const roster: RosterPlayer[] = players.map((p) => {
    const prof = playerMapProfiles(stats.filter((s) => s.playerId === p.id)).find((x) => x.mapName === "all");
    return {
      id: p.id,
      nickname: p.nickname,
      realName: p.realName,
      country: p.country,
      role: p.roleManual ?? p.roleDerived,
      roleIsManual: !!p.roleManual,
      maps: prof?.maps ?? 0,
      kpr: prof?.kpr ?? null,
      hsPct: prof?.hsPct ?? null,
      rating: prof?.rating ?? null,
    };
  });

  const matchSelect = {
    id: true,
    startAt: true,
    status: true,
    format: true,
    eventName: true,
    team1Id: true,
    team2Id: true,
    team1Name: true,
    team2Name: true,
    score1: true,
    score2: true,
    winnerId: true,
    maps: { select: { mapName: true, team1Rounds: true, team2Rounds: true, winnerId: true, mapNumber: true } },
  } as const;
  const upcoming = await db.cs2Match.findMany({
    where: { status: { in: ["scheduled", "live"] }, startAt: { gte: new Date(Date.now() - 6 * 3_600_000) }, OR: [{ team1Id: teamId }, { team2Id: teamId }] },
    orderBy: { startAt: "asc" },
    take: 10,
    select: matchSelect,
  });
  const recent = await db.cs2Match.findMany({
    where: { status: "finished", OR: [{ team1Id: teamId }, { team2Id: teamId }] },
    orderBy: { startAt: "desc" },
    take: 12,
    select: matchSelect,
  });

  return {
    team: {
      id: team.id,
      name: team.name,
      country: team.country,
      rank: team.rank,
      tracked: team.tracked,
      rosterFetchedAt: team.rosterFetchedAt?.toISOString() ?? null,
    },
    roster,
    mapPool: pool,
    upcoming: upcoming.map((m) => toMatchItem(m, teamId)),
    recent: recent.map((m) => toMatchItem(m, teamId)),
    coverage: { maps: mapRows.length, demoMaps: mapRows.filter((m) => m.demoParsedAt).length },
    window,
  };
}

// ---------------------------------------------------------------------------
// Gameplan
// ---------------------------------------------------------------------------

export interface GameplanResponse {
  report: GameplanReport;
  notes: Record<string, { text: string; updatedBy: string | null; updatedAt: string }>;
}

export async function loadGameplan(
  db: PrismaClient,
  teamId: number,
  mapName: string,
  side: Side,
  window: SampleWindow,
  opponentId?: number | null
): Promise<GameplanResponse | null> {
  const team = await db.cs2Team.findUnique({ where: { id: teamId } });
  if (!team) return null;
  const since = sinceOf(window.months);

  const mapRows = await db.cs2Map.findMany({
    where: { mapName, playedAt: { gte: since }, OR: [{ team1Id: teamId }, { team2Id: teamId }] },
    select: MAP_SELECT,
    orderBy: { playedAt: "desc" },
  });
  const maps = applyWindow(
    mapRows.map((m) => toTeamMapRow(m, teamId)).filter((r): r is TeamMapRow => r !== null),
    window
  );
  const mapIds = maps.map((m) => m.mapId);

  const teamFacts = await db.cs2DemoTeamMap.findMany({ where: { teamId, side, mapId: { in: mapIds } }, select: { mapId: true, facts: true } });
  const rounds = teamFacts.flatMap((t) => ((t.facts as unknown as { rounds: RoundFact[] }).rounds ?? []).map((r) => ({ ...r, mapId: t.mapId })));

  const demoPlayers = await db.cs2DemoPlayerMap.findMany({
    where: { mapId: { in: mapIds }, side, teamId },
    select: { steamId: true, playerId: true, name: true, facts: true },
  });
  const roster = await db.cs2Player.findMany({ where: { teamId } });
  const linkedIds = [...new Set(demoPlayers.map((d) => d.playerId).filter((x): x is number => x != null))];
  const linkedPlayers = await db.cs2Player.findMany({ where: { id: { in: linkedIds } }, select: { id: true, nickname: true } });
  const nickOfPlayer = new Map([...roster, ...linkedPlayers].map((p) => [p.id, p.nickname]));

  const steamNick = new Map<string, string>();
  for (const d of demoPlayers) steamNick.set(d.steamId, d.playerId != null ? nickOfPlayer.get(d.playerId) ?? d.name : d.name);

  // Nuvarande trupp först; spelare som bara finns i demos (stand-ins,
  // tidigare spelare) bara om nuvarande trupp saknar demofakta.
  const players: GameplanPlayer[] = roster.map((p) => {
    const rows = demoPlayers.filter((d) => d.playerId === p.id);
    return {
      playerId: p.id,
      steamIds: rows.map((r) => r.steamId),
      nickname: p.nickname,
      role: p.roleManual ?? p.roleDerived,
      facts: sumFacts(rows.map((r) => r.facts as unknown as PlayerSideFacts)),
    };
  });
  if (!players.some((p) => p.facts)) {
    const bySteam = new Map<string, typeof demoPlayers>();
    for (const d of demoPlayers) {
      const key = d.playerId != null ? `p${d.playerId}` : d.steamId;
      const list = bySteam.get(key);
      if (list) list.push(d);
      else bySteam.set(key, [d]);
    }
    players.length = 0;
    for (const list of bySteam.values()) {
      players.push({
        playerId: list[0].playerId,
        steamIds: list.map((r) => r.steamId),
        nickname: steamNick.get(list[0].steamId) ?? list[0].name,
        role: null,
        facts: sumFacts(list.map((r) => r.facts as unknown as PlayerSideFacts)),
      });
    }
  }

  const teamNames = await teamNameMap(db, [...maps.map((m) => m.opponentId), ...(opponentId ? [opponentId] : [])]);
  const report = buildGameplan({
    teamId,
    teamName: team.name,
    mapName,
    side,
    months: window.months,
    maps,
    rounds,
    players,
    nick: (id) => (id ? steamNick.get(id) ?? id : "?"),
    opponentId: opponentId ?? null,
    opponentName: opponentId ? teamNames.get(opponentId) ?? null : null,
    teamNames,
  });

  const notes = await db.cs2GameplanNote.findMany({ where: { teamId, mapName, side } });
  return {
    report,
    notes: Object.fromEntries(notes.map((n) => [n.section, { text: n.text, updatedBy: n.updatedBy, updatedAt: n.updatedAt.toISOString() }])),
  };
}

// ---------------------------------------------------------------------------
// Spelare
// ---------------------------------------------------------------------------

export interface PlayerDemoSummary {
  mapName: string;
  side: Side;
  maps: number;
  facts: PlayerSideFacts;
}

export interface PlayerOverview {
  player: { id: number; nickname: string; realName: string | null; country: string | null; role: string | null; roleDerived: string | null; roleManual: string | null; team: { id: number; name: string } | null };
  profiles: PlayerMapProfile[];
  demo: PlayerDemoSummary[];
  recent: Array<{ mapId: number; matchId: number; mapName: string; playedAt: string; opponent: string; kills: number; deaths: number; headshots: number | null; adr: number | null; rating: number | null; rounds: number }>;
  window: SampleWindow;
}

export async function loadPlayer(db: PrismaClient, playerId: number, window: SampleWindow): Promise<PlayerOverview | null> {
  const p = await db.cs2Player.findUnique({ where: { id: playerId }, include: { team: { select: { id: true, name: true } } } });
  if (!p) return null;
  const since = sinceOf(window.months);
  const stats = await playerStatInputs(db, { playerId }, since);
  const profiles = playerMapProfiles(stats);

  const demoRows = await db.cs2DemoPlayerMap.findMany({
    where: { playerId, map: { playedAt: { gte: since } } },
    select: { side: true, facts: true, map: { select: { mapName: true } } },
  });
  const groups = new Map<string, PlayerSideFacts[]>();
  for (const d of demoRows) {
    for (const key of [`${d.map.mapName}|${d.side}`, `all|${d.side}`]) {
      const list = groups.get(key);
      const f = d.facts as unknown as PlayerSideFacts;
      if (list) list.push(f);
      else groups.set(key, [f]);
    }
  }
  const demo: PlayerDemoSummary[] = [...groups.entries()].map(([key, list]) => {
    const [mapName, side] = key.split("|") as [string, Side];
    return { mapName, side, maps: list.length, facts: sumFacts(list)! };
  });

  const all = stats.filter((s) => s.side === "all").sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime()).slice(0, 20);
  const names = await teamNameMap(db, all.map((s) => s.opponentId));
  const matchIds = await db.cs2Map.findMany({ where: { id: { in: all.map((s) => s.mapId) } }, select: { id: true, matchId: true } });
  const matchOf = new Map(matchIds.map((m) => [m.id, m.matchId]));

  return {
    player: {
      id: p.id,
      nickname: p.nickname,
      realName: p.realName,
      country: p.country,
      role: p.roleManual ?? p.roleDerived,
      roleDerived: p.roleDerived,
      roleManual: p.roleManual,
      team: p.team,
    },
    profiles,
    demo,
    recent: all.map((s) => ({
      mapId: s.mapId,
      matchId: matchOf.get(s.mapId) ?? 0,
      mapName: s.mapName,
      playedAt: s.playedAt.toISOString(),
      opponent: names.get(s.opponentId) ?? "?",
      kills: s.kills,
      deaths: s.deaths,
      headshots: s.headshots,
      adr: s.adr,
      rating: s.rating,
      rounds: s.rounds,
    })),
    window,
  };
}

export async function searchPlayers(db: PrismaClient, q: string, limit = 20) {
  const rows = await db.cs2Player.findMany({
    where: { nickname: { contains: q, mode: "insensitive" } },
    take: limit,
    orderBy: { nickname: "asc" },
    include: { team: { select: { id: true, name: true } } },
  });
  return rows.map((p) => ({ id: p.id, nickname: p.nickname, role: p.roleManual ?? p.roleDerived, team: p.team }));
}

/** Kartpoolens nycklar som har spelats av laget — för kartväljaren. */
export async function teamMapNames(db: PrismaClient, teamId: number, months: number): Promise<string[]> {
  const rows = await db.cs2Map.findMany({
    where: { playedAt: { gte: sinceOf(months) }, OR: [{ team1Id: teamId }, { team2Id: teamId }] },
    select: { mapName: true },
  });
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.mapName, (count.get(r.mapName) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

export interface UpcomingMatch {
  id: number;
  startAt: string;
  status: string;
  format: string;
  eventName: string | null;
  lan: boolean | null;
  team1: { id: number | null; name: string; rank: number | null; tracked: boolean };
  team2: { id: number | null; name: string; rank: number | null; tracked: boolean };
  /** Kartor med HLTV-data / tolkad demo per lag inom 6 månader. */
  coverage: { team1Maps: number; team2Maps: number; team1Demo: number; team2Demo: number };
  lines: number;
}

export async function listUpcoming(db: PrismaClient, days: number): Promise<UpcomingMatch[]> {
  const now = Date.now();
  const rows = await db.cs2Match.findMany({
    where: { status: { in: ["scheduled", "live"] }, startAt: { gte: new Date(now - 6 * 3_600_000), lte: new Date(now + days * DAY) } },
    orderBy: { startAt: "asc" },
    select: {
      id: true,
      startAt: true,
      status: true,
      format: true,
      eventName: true,
      lan: true,
      team1Id: true,
      team2Id: true,
      team1Name: true,
      team2Name: true,
      _count: { select: { lines: true } },
    },
  });
  const teamIds = [...new Set(rows.flatMap((r) => [r.team1Id, r.team2Id]).filter((x): x is number => x != null))];
  const teams = await db.cs2Team.findMany({ where: { id: { in: teamIds } }, select: { id: true, rank: true, tracked: true } });
  const tInfo = new Map(teams.map((t) => [t.id, t]));
  const maps = await db.cs2Map.findMany({
    where: { playedAt: { gte: sinceOf(6) }, OR: [{ team1Id: { in: teamIds } }, { team2Id: { in: teamIds } }] },
    select: { team1Id: true, team2Id: true, demoParsedAt: true },
  });
  const cov = new Map<number, { maps: number; demo: number }>();
  for (const m of maps) {
    for (const id of [m.team1Id, m.team2Id]) {
      const c = cov.get(id) ?? { maps: 0, demo: 0 };
      c.maps++;
      if (m.demoParsedAt) c.demo++;
      cov.set(id, c);
    }
  }
  const side = (id: number | null, name: string) => ({
    id,
    name,
    rank: id != null ? tInfo.get(id)?.rank ?? null : null,
    tracked: id != null ? tInfo.get(id)?.tracked ?? false : false,
  });
  return rows.map((r) => ({
    id: r.id,
    startAt: r.startAt.toISOString(),
    status: r.status,
    format: r.format,
    eventName: r.eventName,
    lan: r.lan,
    team1: side(r.team1Id, r.team1Name),
    team2: side(r.team2Id, r.team2Name),
    coverage: {
      team1Maps: r.team1Id != null ? cov.get(r.team1Id)?.maps ?? 0 : 0,
      team2Maps: r.team2Id != null ? cov.get(r.team2Id)?.maps ?? 0 : 0,
      team1Demo: r.team1Id != null ? cov.get(r.team1Id)?.demo ?? 0 : 0,
      team2Demo: r.team2Id != null ? cov.get(r.team2Id)?.demo ?? 0 : 0,
    },
    lines: r._count.lines,
  }));
}
