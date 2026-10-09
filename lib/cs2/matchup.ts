// En match, hela vägen: ratings → veto → kartor → serie → spelare → linjer
// → angles. Läser databasen en gång och räknar resten i minnet.
//
// Den globala delen (rundratings, ligans kill-nivå) anpassas på alla kartor i
// databasen och cachas i processen; den räknas om när nya kartor läses in.

import type { PrismaClient } from ".prisma/cs2-client";
import type { PlayerSideFacts, RoundFact } from "./demo/types";
import { activeMapPool, mapLabel } from "./maps";
import {
  conversionRates,
  fitRatings,
  pistolObsFromMap,
  pistolWinProb,
  ratingSample,
  roundWinProb,
  matchSpread,
  lineupsFromPlayers,
  DEFAULT_TAU_PLAYER,
  DEFAULT_TAU_TEAM_WITH_PLAYERS,
  PLAYER_MODE_ITERATIONS,
  sideObsFromMap,
  timeWeight,
  type RatingModel,
} from "./ratings";
import { flipDistribution, handicapProbs, mapDistribution, roundsPmf, type MapDistribution } from "./mapModel";
import { isManualVetoStep } from "./manualVeto";
import { knownVeto, seriesProbs, vetoDistribution, vetoProfile, type VetoDistribution } from "./veto";
import {
  DEFAULT_KILL_PHI,
  DEFAULT_LEAGUE_PRIOR,
  headshotPmf,
  killPmfForMap,
  killRates,
  medianLine,
  pmfMean,
  seriesPmf,
  type KillRates,
  type LeagueKillPrior,
} from "./killModel";
import { firstKillProb, firstPistolProb, openingRates, playerFirstKillProb, type OpeningRates } from "./openingModel";
import { CS2_MODEL_VERSION, DEFAULT_CS2_BLEND_W, priceTwoWay, type Price } from "./pricing";
import { buildAngles, type Angle } from "./angles";
import { lineProbs } from "../shotModel";
import { sumFacts } from "./profiles";
import { lineupChange, LINEUP_RECENT_MAPS, type LineupChange } from "./lineup";
import { CS2_MARKET_LABEL, CS2_SCOPE_LABEL, PLAYER_MARKETS, type Cs2Market, type Cs2Scope, type SeriesFormat, type Side } from "./types";
import { DEFAULT_SIGMA } from "./mapModel";

const DAY = 86_400_000;
const sinceOf = (months: number) => new Date(Date.now() - months * 30 * DAY);

// ---------------------------------------------------------------------------
// Global modell (cachad)
// ---------------------------------------------------------------------------

export interface GlobalModel {
  ratings: RatingModel;
  league: LeagueKillPrior;
  leagueRounds: number;
  trainedMaps: number;
  key: string;
  at: number;
}

let cache: GlobalModel | null = null;

export async function globalModel(db: PrismaClient): Promise<GlobalModel> {
  const latest = await db.cs2Map.aggregate({ _max: { updatedAt: true }, _count: { _all: true } });
  const key = `${latest._max.updatedAt?.getTime() ?? 0}|${latest._count._all}`;
  if (cache && cache.key === key && Date.now() - cache.at < 10 * 60_000) return cache;

  const now = new Date();
  const maps = await db.cs2Map.findMany({
    where: { playedAt: { gte: sinceOf(12) } },
    select: {
      mapName: true,
      team1Id: true,
      team2Id: true,
      team1CtRounds: true,
      team1TRounds: true,
      team2CtRounds: true,
      team2TRounds: true,
      team1Rounds: true,
      team2Rounds: true,
      roundHistory: true,
      playedAt: true,
      playerStats: { where: { side: "all" }, select: { playerId: true, teamId: true } },
    },
  });
  const obs = maps.flatMap((m) => sideObsFromMap(m, timeWeight(m.playedAt, now), lineupsFromPlayers(m.playerStats)));
  const pistols = maps.flatMap((m) => pistolObsFromMap(m, timeWeight(m.playedAt, now)));
  const ratings = fitRatings(obs, pistols, conversionRates(maps.map((m) => m.roundHistory)), {
    tauPlayer: DEFAULT_TAU_PLAYER,
    tauTeam: DEFAULT_TAU_TEAM_WITH_PLAYERS,
    iterations: PLAYER_MODE_ITERATIONS,
  });

  // Ligans kill-nivå ur ett urval demofakta (de senaste raderna räcker gott).
  const sample = await db.cs2DemoPlayerMap.findMany({ orderBy: { id: "desc" }, take: 3000, select: { facts: true } });
  const s = { kw: 0, rw: 0, kl: 0, rl: 0, hs: 0, k: 0 };
  for (const row of sample) {
    const f = row.facts as unknown as PlayerSideFacts;
    s.kw += f.killsWon ?? 0;
    s.rw += f.roundsWon ?? 0;
    s.kl += f.killsLost ?? 0;
    s.rl += (f.rounds ?? 0) - (f.roundsWon ?? 0);
    s.hs += f.headshots ?? 0;
    s.k += f.kills ?? 0;
  }
  const league: LeagueKillPrior =
    s.rw > 2000 && s.rl > 2000
      ? { kw: s.kw / s.rw, kl: s.kl / s.rl, hs: s.k > 0 ? s.hs / s.k : DEFAULT_LEAGUE_PRIOR.hs }
      : DEFAULT_LEAGUE_PRIOR;
  const recent = maps.filter((m) => m.playedAt >= sinceOf(6));
  const leagueRounds = recent.length ? recent.reduce((a, m) => a + m.team1Rounds + m.team2Rounds, 0) / recent.length : 21.5;

  cache = { ratings, league, leagueRounds, trainedMaps: maps.length, key, at: Date.now() };
  return cache;
}

// ---------------------------------------------------------------------------
// Kontext för en match
// ---------------------------------------------------------------------------

interface TeamInfo {
  id: number;
  name: string;
  rank: number | null;
  tracked: boolean;
}

interface PlayerCtx {
  playerId: number;
  nickname: string;
  teamId: number;
  side: 1 | 2;
  role: string | null;
  rates: Record<string, KillRates> & { all: KillRates };
  kprByMap: Record<string, { kpr: number; maps: number }>;
  kprAll: number | null;
  mapsAll: number;
  mapsForTeam: number;
  demoMaps: number;
  awpRounds: number;
  awpEarlyKills: number;
  openingShare: number | null;
  openingRounds: number;
}

export interface MatchupContext {
  match: { id: number; startAt: Date; status: string; eventName: string | null; lan: boolean | null };
  team1: TeamInfo;
  team2: TeamInfo;
  format: SeriesFormat;
  pool: string[];
  veto: VetoDistribution;
  vetoKnown: boolean;
  /** Vetot är inmatat för hand (se manualVeto.ts), inte inläst från HLTV. */
  vetoManual: boolean;
  dists: Record<string, MapDistribution>;
  series: { pA: number; scores: Record<string, number>; pMapPlayed: number[] };
  pistolCt1: number;
  pistolCt2: number;
  opening: { team1: OpeningRates; team2: OpeningRates };
  players: PlayerCtx[];
  global: GlobalModel;
  /** Skala på lagskillnaden (matchSpread): dämpad mellan två topplag. */
  spread: number;
  /** Matchens uppställning jämfört med lagens vanliga femma. */
  lineupChanges: LineupChange[];
  /** Spelarna kommer från matchsidans uppställning (inte lagens trupper). */
  lineupKnown: boolean;
  /** Femmorna i prissättningen (tom = lagens senaste). */
  fives: Record<number, number[]>;
  teamAngles: Array<{ teamId: number; name: string; pistolWinRate: number | null; pistolN: number; antiEcoLossRate: number | null; antiEcoN: number; mapsInWindow: number }>;
  warnings: string[];
}

/**
 * Matchsidans uppställningar för de två lagen, eller null om någon saknas
 * eller har färre än fem spelare (sidan visar då inget säkert).
 */
export function matchLineups(raw: unknown, teamIds: number[]): Array<{ teamId: number; players: Array<{ id: number; nickname: string }> }> | null {
  if (!Array.isArray(raw)) return null;
  const out = teamIds.map((id) => {
    const l = raw.find((x) => x && typeof x === "object" && (x as { teamId?: unknown }).teamId === id) as
      | { teamId: number; players?: Array<{ id: number; nickname: string }> }
      | undefined;
    return l && Array.isArray(l.players) && l.players.length >= 5 ? { teamId: id, players: l.players.slice(0, 5) } : null;
  });
  return out.every((x) => x != null) ? (out as Array<{ teamId: number; players: Array<{ id: number; nickname: string }> }>) : null;
}

async function teamOpening(db: PrismaClient, teamId: number, since: Date) {
  const rows = await db.cs2DemoTeamMap.findMany({ where: { teamId, map: { playedAt: { gte: since } } }, select: { side: true, facts: true } });
  const rounds: Array<RoundFact & { side: Side }> = rows.flatMap((r) =>
    ((r.facts as unknown as { rounds: RoundFact[] }).rounds ?? []).map((f) => ({ ...f, side: r.side as Side }))
  );
  return rounds;
}

export async function loadMatchupContext(db: PrismaClient, matchId: number): Promise<MatchupContext | null> {
  const m = await db.cs2Match.findUnique({ where: { id: matchId }, include: { vetoes: { orderBy: { step: "asc" } }, maps: { orderBy: { mapNumber: "asc" } } } });
  if (!m || m.team1Id == null || m.team2Id == null) return null;
  const warnings: string[] = [];
  const global = await globalModel(db);
  const teams = await db.cs2Team.findMany({ where: { id: { in: [m.team1Id, m.team2Id] } } });
  const tInfo = (id: number, name: string): TeamInfo => {
    const t = teams.find((x) => x.id === id);
    return { id, name: t?.name ?? name, rank: t?.rank ?? null, tracked: t?.tracked ?? false };
  };
  const team1 = tInfo(m.team1Id, m.team1Name);
  const team2 = tInfo(m.team2Id, m.team2Name);
  const format = (["bo1", "bo3", "bo5"].includes(m.format) ? m.format : "bo3") as SeriesFormat;

  // Kartpool ur senaste 90 dagarnas veton och spelade kartor.
  const recentVetoes = await db.cs2Veto.findMany({
    where: { match: { startAt: { gte: sinceOf(3) } } },
    select: { mapName: true, match: { select: { startAt: true } } },
  });
  let pool = activeMapPool(recentVetoes.map((v) => ({ mapName: v.mapName, at: v.match.startAt })), sinceOf(3), 5);
  if (pool.length < 7) {
    const played = await db.cs2Map.groupBy({ by: ["mapName"], where: { playedAt: { gte: sinceOf(3) } }, _count: { _all: true }, orderBy: { _count: { mapName: "desc" } } });
    for (const p of played) if (!pool.includes(p.mapName) && pool.length < 7) pool.push(p.mapName);
  }
  pool = pool.slice(0, 7);
  if (pool.length === 0) warnings.push("Ingen kartpool i databasen än — läs in fler matcher.");

  // Veto: genomfört (matchsidan visar det) eller modellerat.
  let veto: VetoDistribution;
  const done = m.vetoes.filter((v) => v.action === "pick" || v.action === "decider");
  const vetoKnown = done.length > 0 && m.vetoes.some((v) => v.action === "decider");
  const vetoManual = vetoKnown && m.vetoes.every((v) => isManualVetoStep(v.step));
  if (vetoKnown) {
    veto = knownVeto(done.map((v) => v.mapName), pool);
  } else {
    const hist = await db.cs2Veto.findMany({
      where: { teamId: { in: [team1.id, team2.id] }, match: { startAt: { gte: sinceOf(6) } } },
      select: { teamId: true, action: true, mapName: true, match: { select: { startAt: true } } },
    });
    const rows = hist.map((h) => ({ teamId: h.teamId, action: h.action, mapName: h.mapName, at: h.match.startAt }));
    const p1 = vetoProfile(rows, team1.id, pool);
    const p2 = vetoProfile(rows, team2.id, pool);
    if (p1.weight < 3) warnings.push(`Lite vetohistorik för ${team1.name} — kartvalet är osäkert.`);
    if (p2.weight < 3) warnings.push(`Lite vetohistorik för ${team2.name} — kartvalet är osäkert.`);
    veto = vetoDistribution(format, pool, p1, p2, 0.5);
  }

  const r = global.ratings;
  const spread = matchSpread(team1.tracked, team2.tracked);
  // Femmorna som prissätts: matchsidans uppställning, annars lagens senaste.
  const known = matchLineups(m.lineups, [team1.id, team2.id]);
  const fives: Record<number, number[]> = known ? Object.fromEntries(known.map((l) => [l.teamId, l.players.map((p) => p.id)])) : {};
  const pistolCt1 = pistolWinProb(r, team1.id, team2.id);
  const pistolCt2 = pistolWinProb(r, team2.id, team1.id);
  const dists: Record<string, MapDistribution> = {};
  for (const map of new Set([...pool, ...veto.paths.flatMap((p) => p.maps)])) {
    dists[map] = mapDistribution({
      pCtA: roundWinProb(r, map, team1.id, team2.id, team1.id, spread, fives),
      pCtB: roundWinProb(r, map, team2.id, team1.id, team1.id, spread, fives),
      pistolCtA: pistolCt1,
      pistolCtB: pistolCt2,
      conv2: r.conv2,
      conv3: r.conv3,
      pAStartsCt: 0.5,
      sigma: DEFAULT_SIGMA,
    });
  }
  const series = seriesProbs(format, veto, (map) => dists[map]?.pAWin ?? 0.5);

  // Spelare: matchens uppställning när HLTV visar den (stand-ins med),
  // annars lagens trupper.
  const sinceP = sinceOf(6);
  const rosterRows = known
    ? await db.cs2Player.findMany({ where: { id: { in: known.flatMap((l) => l.players.map((p) => p.id)) } } })
    : await db.cs2Player.findMany({ where: { teamId: { in: [team1.id, team2.id] } } });
  const roster = known
    ? known.flatMap((l) =>
        l.players.map((lp) => {
          const row = rosterRows.find((r) => r.id === lp.id);
          return { id: lp.id, nickname: row?.nickname ?? lp.nickname, teamId: l.teamId, roleManual: row?.roleManual ?? null, roleDerived: row?.roleDerived ?? null };
        })
      )
    : rosterRows;
  const ids = roster.map((p) => p.id);
  const hltvRows = await db.cs2PlayerMap.findMany({
    where: { playerId: { in: ids }, side: "all", map: { playedAt: { gte: sinceP } } },
    select: {
      playerId: true,
      teamId: true,
      kills: true,
      headshots: true,
      map: { select: { mapName: true, team1Id: true, team1Rounds: true, team2Rounds: true } },
    },
  });
  const demoRows = await db.cs2DemoPlayerMap.findMany({
    where: { playerId: { in: ids }, map: { playedAt: { gte: sinceP } } },
    select: { playerId: true, side: true, teamId: true, facts: true, mapId: true, map: { select: { mapName: true } } },
  });

  const players: PlayerCtx[] = roster.map((p) => {
    const hl = hltvRows.filter((h) => h.playerId === p.id);
    const hltv: Record<string, { kills: number; headshots: number | null; roundsWon: number; roundsLost: number }> = {};
    const kprAcc: Record<string, { k: number; r: number; maps: number }> = {};
    for (const h of hl) {
      const won = h.map.team1Id === h.teamId ? h.map.team1Rounds : h.map.team2Rounds;
      const lost = h.map.team1Id === h.teamId ? h.map.team2Rounds : h.map.team1Rounds;
      const e = (hltv[h.map.mapName] ??= { kills: 0, headshots: 0, roundsWon: 0, roundsLost: 0 });
      e.kills += h.kills;
      e.headshots = e.headshots != null && h.headshots != null ? e.headshots + h.headshots : null;
      e.roundsWon += won;
      e.roundsLost += lost;
      const k = (kprAcc[h.map.mapName] ??= { k: 0, r: 0, maps: 0 });
      k.k += h.kills;
      k.r += won + lost;
      k.maps += 1;
    }
    const dr = demoRows.filter((d) => d.playerId === p.id);
    const byMap = new Map<string, PlayerSideFacts[]>();
    for (const d of dr) {
      const list = byMap.get(d.map.mapName);
      const f = d.facts as unknown as PlayerSideFacts;
      if (list) list.push(f);
      else byMap.set(d.map.mapName, [f]);
    }
    const demo: Record<string, PlayerSideFacts> = {};
    for (const [map, list] of byMap) demo[map] = sumFacts(list)!;
    const all = sumFacts(dr.map((d) => d.facts as unknown as PlayerSideFacts));
    const teamId = p.teamId!;
    const totalK = Object.values(kprAcc).reduce((a, x) => a + x.k, 0);
    const totalR = Object.values(kprAcc).reduce((a, x) => a + x.r, 0);
    return {
      playerId: p.id,
      nickname: p.nickname,
      teamId,
      side: teamId === team1.id ? 1 : 2,
      role: p.roleManual ?? p.roleDerived,
      rates: killRates({ demo, hltv }, global.league, pool),
      kprByMap: Object.fromEntries(Object.entries(kprAcc).map(([k, v]) => [k, { kpr: v.r > 0 ? v.k / v.r : 0, maps: v.maps }])),
      kprAll: totalR > 0 ? totalK / totalR : null,
      mapsAll: hl.length,
      mapsForTeam: hl.filter((h) => h.teamId === teamId).length,
      demoMaps: new Set(dr.map((d) => d.mapId)).size,
      awpRounds: all?.awpRounds ?? 0,
      awpEarlyKills: all?.awpEarlyKills ?? 0,
      openingShare: null,
      openingRounds: all?.rounds ?? 0,
    };
  });
  for (const t of [team1, team2]) {
    const n = players.filter((p) => p.teamId === t.id).length;
    if (n < 5) warnings.push(`${t.name}: ${n} spelare i truppen i databasen — kör cs2:ingest så att truppen läses in.`);
  }

  // Uppställningen mot lagens vanliga femma (senaste kartorna).
  const lineupChanges: LineupChange[] = [];
  for (const t of [team1, team2]) {
    const recentMaps = await db.cs2Map.findMany({
      where: { OR: [{ team1Id: t.id }, { team2Id: t.id }], playedAt: { gte: sinceOf(3) }, statsFetchedAt: { not: null } },
      orderBy: { playedAt: "desc" },
      take: LINEUP_RECENT_MAPS,
      select: { id: true, playedAt: true, playerStats: { where: { side: "all", teamId: t.id }, select: { playerId: true, nickname: true, kills: true } } },
    });
    const rows = recentMaps.flatMap((mp) => mp.playerStats.map((ps) => ({ mapId: mp.id, playedAt: mp.playedAt, ...ps })));
    const current = players.filter((p) => p.teamId === t.id).map((p) => ({ playerId: p.playerId, nickname: p.nickname }));
    const change = lineupChange(t.id, rows, current, { reportNew: known != null });
    if (change) lineupChanges.push(change);
  }

  // Öppningar och lagets demofakta.
  const [r1, r2] = await Promise.all([teamOpening(db, team1.id, sinceP), teamOpening(db, team2.id, sinceP)]);
  const playerOpen = (teamId: number) =>
    demoRows
      .filter((d) => d.teamId === teamId && d.playerId != null)
      .map((d) => ({ key: String(d.playerId), side: d.side as Side, openingKills: (d.facts as unknown as PlayerSideFacts).openingKills ?? 0 }));
  const opening = { team1: openingRates(r1, playerOpen(team1.id)), team2: openingRates(r2, playerOpen(team2.id)) };
  for (const p of players) {
    const o = (p.side === 1 ? opening.team1 : opening.team2).players[String(p.playerId)];
    p.openingShare = o ? (o.ct + o.t) / 2 : null;
  }

  const teamMaps = async (id: number) =>
    db.cs2Map.count({ where: { playedAt: { gte: sinceP }, OR: [{ team1Id: id }, { team2Id: id }] } });
  const pistolStats = async (id: number) => {
    const maps = await db.cs2Map.findMany({
      where: { playedAt: { gte: sinceP }, OR: [{ team1Id: id }, { team2Id: id }] },
      select: { team1Id: true, roundHistory: true },
    });
    let w = 0,
      n = 0;
    for (const mp of maps) {
      const hist = Array.isArray(mp.roundHistory) ? (mp.roundHistory as Array<{ n: number; winner: string }>) : [];
      for (const rr of hist) {
        if (rr.n !== 1 && rr.n !== 13) continue;
        n++;
        if ((rr.winner === "team1") === (mp.team1Id === id)) w++;
      }
    }
    return { rate: n > 0 ? w / n : null, n };
  };
  const antiEco = (rounds: RoundFact[]) => {
    const anti = rounds.filter((x) => x.buy === "full" && x.oppBuy === "eco" && !x.pistol);
    return { rate: anti.length ? anti.filter((x) => !x.won).length / anti.length : null, n: anti.length };
  };
  const teamAngles = await Promise.all(
    [
      [team1, r1],
      [team2, r2],
    ].map(async ([t, rounds]) => {
      const ti = t as TeamInfo;
      const ps = await pistolStats(ti.id);
      const ae = antiEco(rounds as RoundFact[]);
      return { teamId: ti.id, name: ti.name, pistolWinRate: ps.rate, pistolN: ps.n, antiEcoLossRate: ae.rate, antiEcoN: ae.n, mapsInWindow: await teamMaps(ti.id) };
    })
  );

  for (const map of pool) {
    const s1 = ratingSample(r, team1.id, map);
    const s2 = ratingSample(r, team2.id, map);
    if (Math.min(s1, s2) < 40 && (veto.marginal[map]?.p1 ?? 0) + (veto.marginal[map]?.p2 ?? 0) > 0.3) {
      warnings.push(`${mapLabel(map)}: få rundor bakom lagens ratings (${s1}/${s2}) — kartans siffror lutar mot lagens allmänna nivå.`);
    }
  }

  return {
    match: { id: m.id, startAt: m.startAt, status: m.status, eventName: m.eventName, lan: m.lan },
    team1,
    team2,
    format,
    pool,
    veto,
    vetoKnown,
    vetoManual,
    dists,
    series,
    pistolCt1,
    pistolCt2,
    opening,
    players,
    global,
    spread,
    lineupChanges,
    lineupKnown: known != null,
    fives,
    teamAngles,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Fördelningar per marknad
// ---------------------------------------------------------------------------

const mapIndex: Record<string, number> = { map1: 0, map2: 1, map3: 2 };

/** Kartornas sannolikhet på en position (betingat på att kartan spelas). */
function mapWeights(ctx: MatchupContext, scope: Cs2Scope): Array<{ map: string; w: number }> {
  const idx = mapIndex[scope] ?? 0;
  const acc = new Map<string, number>();
  let total = 0;
  for (const p of ctx.veto.paths) {
    const m = p.maps[idx];
    if (!m) continue;
    acc.set(m, (acc.get(m) ?? 0) + p.p);
    total += p.p;
  }
  return [...acc.entries()].map(([map, w]) => ({ map, w: total > 0 ? w / total : 0 }));
}

function distFor(ctx: MatchupContext, map: string, teamSide: 1 | 2): MapDistribution {
  const d = ctx.dists[map];
  return teamSide === 1 ? d : flipDistribution(d);
}

function pDecider(ctx: MatchupContext) {
  return (maps: string[]) => {
    const a = ctx.dists[maps[0]]?.pAWin ?? 0.5;
    const b = ctx.dists[maps[1]]?.pAWin ?? 0.5;
    return a * (1 - b) + (1 - a) * b;
  };
}

export function playerPmf(ctx: MatchupContext, playerId: number, market: "kills" | "headshots", scope: Cs2Scope, includeOt: boolean) {
  const p = ctx.players.find((x) => x.playerId === playerId);
  if (!p) return null;
  const perMap = (map: string) => {
    const rates = p.rates[map] ?? p.rates.all;
    const kp = killPmfForMap(rates, distFor(ctx, map, p.side), includeOt, DEFAULT_KILL_PHI);
    return market === "headshots" ? headshotPmf(kp, rates.hs) : kp;
  };
  const sc = scope === "match" && ctx.format === "bo1" ? "map1" : scope;
  return seriesPmf(sc as "map1", ctx.veto, perMap, ctx.series.pMapPlayed, undefined, pDecider(ctx));
}

/** Sannolikhet för "över / laget / ja" och push, för en linje. */
export function modelProb(
  ctx: MatchupContext,
  l: { market: Cs2Market; scope: Cs2Scope; playerId?: number | null; teamId?: number | null; line?: number | null; includesOt?: boolean }
): { p: number; pPush: number; mean: number | null; pPlayed: number } | null {
  const includeOt = l.includesOt ?? true;
  const teamSide: 1 | 2 = l.teamId === ctx.team2.id ? 2 : 1;
  const flipP = (p: number) => (teamSide === 1 ? p : 1 - p);
  const line = l.line ?? 0;
  switch (l.market) {
    case "kills":
    case "headshots": {
      if (l.playerId == null || l.line == null) return null;
      const s = playerPmf(ctx, l.playerId, l.market, l.scope, includeOt);
      if (!s) return null;
      const lp = lineProbs(s.pmf, line);
      return { p: lp.pOverNoPush, pPush: lp.pPush, mean: pmfMean(s.pmf), pPlayed: s.pPlayed };
    }
    case "rounds": {
      if (l.line == null) return null;
      const s = seriesPmf(l.scope === "maps12" || l.scope === "match" ? "map1" : (l.scope as "map1"), ctx.veto, (m) => roundsPmf(ctx.dists[m], includeOt), ctx.series.pMapPlayed, 60);
      const lp = lineProbs(s.pmf, line);
      return { p: lp.pOverNoPush, pPush: lp.pPush, mean: pmfMean(s.pmf), pPlayed: s.pPlayed };
    }
    case "map_handicap": {
      let cover = 0,
        push = 0;
      for (const { map, w } of mapWeights(ctx, l.scope)) {
        const h = handicapProbs(distFor(ctx, map, teamSide), line, includeOt);
        cover += w * h.pCover;
        push += w * h.pPush;
      }
      return { p: push < 1 ? cover / (1 - push) : 0.5, pPush: push, mean: null, pPlayed: ctx.series.pMapPlayed[mapIndex[l.scope] ?? 0] ?? 1 };
    }
    case "map_winner": {
      let p = 0;
      for (const { map, w } of mapWeights(ctx, l.scope)) p += w * (ctx.dists[map]?.pAWin ?? 0.5);
      return { p: flipP(p), pPush: 0, mean: null, pPlayed: ctx.series.pMapPlayed[mapIndex[l.scope] ?? 0] ?? 1 };
    }
    case "match_winner":
      return { p: flipP(ctx.series.pA), pPush: 0, mean: null, pPlayed: 1 };
    case "match_handicap": {
      let cover = 0,
        push = 0;
      for (const [score, p] of Object.entries(ctx.series.scores)) {
        const [a, b] = score.split(",").map(Number);
        const margin = (teamSide === 1 ? a - b : b - a) + line;
        if (Math.abs(margin) < 1e-9) push += p;
        else if (margin > 0) cover += p;
      }
      return { p: push < 1 ? cover / (1 - push) : 0.5, pPush: push, mean: null, pPlayed: 1 };
    }
    case "total_maps": {
      let over = 0,
        push = 0,
        mean = 0;
      for (const [score, p] of Object.entries(ctx.series.scores)) {
        const [a, b] = score.split(",").map(Number);
        const n = a + b;
        mean += p * n;
        if (n === line) push += p;
        else if (n > line) over += p;
      }
      return { p: push < 1 ? over / (1 - push) : 0.5, pPush: push, mean, pPlayed: 1 };
    }
    case "pistol":
      return { p: flipP(firstPistolProb(ctx.pistolCt1, ctx.pistolCt2, 0.5)), pPush: 0, mean: null, pPlayed: 1 };
    case "first_kill":
      return { p: flipP(firstKillProb(ctx.opening.team1, ctx.opening.team2, 0.5)), pPush: 0, mean: null, pPlayed: 1 };
    case "player_first_kill": {
      const pl = ctx.players.find((x) => x.playerId === l.playerId);
      if (!pl) return null;
      const own = pl.side === 1 ? ctx.opening.team1 : ctx.opening.team2;
      const opp = pl.side === 1 ? ctx.opening.team2 : ctx.opening.team1;
      return { p: playerFirstKillProb(own, opp, String(pl.playerId), 0.5), pPush: 0, mean: null, pPlayed: 1 };
    }
  }
}

// ---------------------------------------------------------------------------
// Vy till UI:t
// ---------------------------------------------------------------------------

export interface LineInput {
  id?: number;
  market: Cs2Market;
  scope: Cs2Scope;
  playerId?: number | null;
  teamId?: number | null;
  line?: number | null;
  overOdds?: number | null;
  underOdds?: number | null;
  includesOt?: boolean;
  bookmaker?: string | null;
  source?: string;
  createdAt?: string;
}

export interface PricedLine extends LineInput {
  label: string;
  mean: number | null;
  pPlayed: number;
  price: Price | null;
}

export function lineLabel(ctx: MatchupContext, l: LineInput): string {
  const who = l.playerId != null ? ctx.players.find((p) => p.playerId === l.playerId)?.nickname ?? `spelare ${l.playerId}` : l.teamId != null ? (l.teamId === ctx.team2.id ? ctx.team2.name : ctx.team1.name) : null;
  const lineTxt = l.line != null ? ` ${l.line > 0 && (l.market === "map_handicap" || l.market === "match_handicap") ? "+" : ""}${String(l.line).replace(".", ",")}` : "";
  return [who, CS2_MARKET_LABEL[l.market], CS2_SCOPE_LABEL[l.scope]].filter(Boolean).join(" · ") + lineTxt;
}

export function priceLine(ctx: MatchupContext, l: LineInput, blendW = DEFAULT_CS2_BLEND_W): PricedLine {
  const mp = modelProb(ctx, l);
  return {
    ...l,
    label: lineLabel(ctx, l),
    mean: mp?.mean ?? null,
    pPlayed: mp?.pPlayed ?? 1,
    price: mp ? priceTwoWay(mp.p, mp.pPush, l.overOdds, l.underOdds, blendW) : null,
  };
}

export interface MatchupMapView {
  mapName: string;
  label: string;
  p1: number;
  p2: number;
  p3: number;
  pTeam1Win: number;
  expRounds: number;
  pOt: number;
  team1Ct: number;
  team2Ct: number;
  roundsLine: number;
  sample1: number;
  sample2: number;
}

export interface MatchupPlayerView {
  playerId: number;
  nickname: string;
  teamId: number;
  side: 1 | 2;
  role: string | null;
  mapsAll: number;
  demoMaps: number;
  kprAll: number | null;
  kills12: { mean: number; line: number; pOver: number } | null;
  hs12: { mean: number; line: number; pOver: number } | null;
  killsMap1: { mean: number; line: number; pOver: number } | null;
  firstKill: number | null;
}

export interface MatchupView {
  match: { id: number; startAt: string; status: string; eventName: string | null; lan: boolean | null; format: SeriesFormat };
  team1: TeamInfo;
  team2: TeamInfo;
  vetoKnown: boolean;
  vetoManual: boolean;
  /** Kartorna i spelordning när vetot är känt. */
  vetoMaps: string[];
  pool: string[];
  maps: MatchupMapView[];
  series: { pTeam1: number; scores: Record<string, number>; pMap3: number; pistolTeam1: number; firstKillTeam1: number };
  players: MatchupPlayerView[];
  lines: PricedLine[];
  angles: Angle[];
  warnings: string[];
  lineupChanges: Array<LineupChange & { teamName: string }>;
  lineupKnown: boolean;
  model: { version: string; blendW: number; phi: number; sigma: number; trainedMaps: number; leagueRounds: number };
  /** Fair odds per spelare, karta och linje — snabbläget. */
  ladder: PropLadder;
  /** Förvald karta i snabbläget (gissad ur tiden sedan start). */
  suggestedScope: LadderScope;
}

function summarize(pmf: number[]) {
  const line = medianLine(pmf);
  return { mean: pmfMean(pmf), line, pOver: lineProbs(pmf, line).pOverNoPush };
}

// ---------------------------------------------------------------------------
// Odds-stege: fair odds för varje spelare på flera linjer, så att bokens
// linjer kan jämföras direkt i kartpausen utan inmatning.
// ---------------------------------------------------------------------------

export type LadderScope = "map1" | "map2" | "map3" | "maps12";
export type LadderMarket = "kills" | "headshots";
export const LADDER_SCOPES: LadderScope[] = ["map1", "map2", "map3", "maps12"];
/** Halvlinjer på var sida om medianlinjen. */
export const LADDER_SPAN = 3;

export interface LadderRow {
  playerId: number;
  /** Modellens linje (P(över) närmast 50 %). */
  median: number;
  /** P(över) per halvlinje, median − LADDER_SPAN … median + LADDER_SPAN. Övertid räknas. */
  lines: Array<{ line: number; pOver: number }>;
}

export type PropLadder = Partial<Record<LadderScope, Record<LadderMarket, LadderRow[]>>>;

/** Scopen som är meningsfulla för formatet (bo1 har bara karta 1). */
export function ladderScopes(format: SeriesFormat): LadderScope[] {
  return format === "bo1" ? ["map1"] : LADDER_SCOPES;
}

export function propLadder(ctx: MatchupContext): PropLadder {
  const out: PropLadder = {};
  for (const scope of ladderScopes(ctx.format)) {
    const byMarket = {} as Record<LadderMarket, LadderRow[]>;
    for (const market of ["kills", "headshots"] as const) {
      const rows: LadderRow[] = [];
      for (const p of ctx.players) {
        const s = playerPmf(ctx, p.playerId, market, scope, true);
        if (!s) continue;
        const median = medianLine(s.pmf);
        const lines: LadderRow["lines"] = [];
        for (let k = -LADDER_SPAN; k <= LADDER_SPAN; k++) {
          const line = median + k;
          if (line < 0.5) continue;
          lines.push({ line, pOver: lineProbs(s.pmf, line).pOverNoPush });
        }
        rows.push({ playerId: p.playerId, median, lines });
      }
      byMarket[market] = rows;
    }
    out[scope] = byMarket;
  }
  return out;
}

/**
 * Gissad karta som spelas härnäst, ur tiden sedan start — bara ett förval
 * i snabbläget. Före start: karta 1 (bo1) eller karta 1–2.
 */
export function suggestedScope(format: SeriesFormat, startAt: Date, now: Date = new Date()): LadderScope {
  const min = (now.getTime() - startAt.getTime()) / 60_000;
  if (format === "bo1") return "map1";
  if (min < 0) return "maps12";
  if (min < 50) return "map1";
  if (min < 100) return "map2";
  return "map3";
}

export function buildMatchupView(ctx: MatchupContext, lines: LineInput[], blendW = DEFAULT_CS2_BLEND_W): MatchupView {
  const maps: MatchupMapView[] = Object.keys(ctx.dists)
    .map((map) => {
      const d = ctx.dists[map];
      const mg = ctx.veto.marginal[map] ?? { p1: 0, p2: 0, p3: 0 };
      return {
        mapName: map,
        label: mapLabel(map),
        p1: mg.p1,
        p2: mg.p2,
        p3: mg.p3,
        pTeam1Win: d.pAWin,
        expRounds: d.expRounds,
        pOt: d.pOt,
        team1Ct: roundWinProb(ctx.global.ratings, map, ctx.team1.id, ctx.team2.id, ctx.team1.id, ctx.spread, ctx.fives),
        team2Ct: roundWinProb(ctx.global.ratings, map, ctx.team2.id, ctx.team1.id, ctx.team1.id, ctx.spread, ctx.fives),
        roundsLine: medianLine(d.roundsPmf),
        sample1: ratingSample(ctx.global.ratings, ctx.team1.id, map),
        sample2: ratingSample(ctx.global.ratings, ctx.team2.id, map),
      };
    })
    .sort((a, b) => b.p1 + b.p2 + b.p3 - (a.p1 + a.p2 + a.p3));

  const players: MatchupPlayerView[] = ctx.players
    .map((p) => {
      const k12 = ctx.format === "bo1" ? null : playerPmf(ctx, p.playerId, "kills", "maps12", true);
      const h12 = ctx.format === "bo1" ? null : playerPmf(ctx, p.playerId, "headshots", "maps12", true);
      const k1 = playerPmf(ctx, p.playerId, "kills", "map1", true);
      const own = p.side === 1 ? ctx.opening.team1 : ctx.opening.team2;
      const opp = p.side === 1 ? ctx.opening.team2 : ctx.opening.team1;
      return {
        playerId: p.playerId,
        nickname: p.nickname,
        teamId: p.teamId,
        side: p.side,
        role: p.role,
        mapsAll: p.mapsAll,
        demoMaps: p.demoMaps,
        kprAll: p.kprAll,
        kills12: k12 ? summarize(k12.pmf) : null,
        hs12: h12 ? summarize(h12.pmf) : null,
        killsMap1: k1 ? summarize(k1.pmf) : null,
        firstKill: playerFirstKillProb(own, opp, String(p.playerId), 0.5),
      };
    })
    .sort((a, b) => a.side - b.side || (b.kills12?.mean ?? b.killsMap1?.mean ?? 0) - (a.kills12?.mean ?? a.killsMap1?.mean ?? 0));

  const priced = lines.map((l) => priceLine(ctx, l, blendW));
  const pIn12 = (map: string) => (ctx.veto.marginal[map]?.p1 ?? 0) + (ctx.veto.marginal[map]?.p2 ?? 0);
  const angles = buildAngles({
    players: ctx.players.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      teamId: p.teamId,
      teamName: p.side === 1 ? ctx.team1.name : ctx.team2.name,
      kprByMap: p.kprByMap,
      kprAll: p.kprAll,
      mapsAll: p.mapsAll,
      mapsForTeam: p.mapsForTeam,
      awpRounds: p.awpRounds,
      awpEarlyKills: p.awpEarlyKills,
      openingShare: p.openingShare,
      openingRounds: p.openingRounds,
    })),
    maps: maps.map((m) => ({ mapName: m.mapName, label: m.label, pIn12: pIn12(m.mapName), expRounds: m.expRounds, pOt: m.pOt })),
    teams: ctx.teamAngles,
    pTeam1: ctx.series.pA,
    team1Name: ctx.team1.name,
    team2Name: ctx.team2.name,
    leagueRounds: ctx.global.leagueRounds,
    pricedLines: priced.map((l) => ({ label: l.label, edge: l.price?.edge ?? null, bestSide: l.price?.bestSide ?? null, market: l.market, playerId: l.playerId })),
  });

  return {
    match: { ...ctx.match, startAt: ctx.match.startAt.toISOString(), format: ctx.format },
    team1: ctx.team1,
    team2: ctx.team2,
    vetoKnown: ctx.vetoKnown,
    vetoManual: ctx.vetoManual,
    vetoMaps: ctx.vetoKnown ? ctx.veto.paths[0]?.maps ?? [] : [],
    pool: ctx.pool,
    maps,
    series: {
      pTeam1: ctx.series.pA,
      scores: ctx.series.scores,
      pMap3: ctx.series.pMapPlayed[2] ?? 0,
      pistolTeam1: firstPistolProb(ctx.pistolCt1, ctx.pistolCt2, 0.5),
      firstKillTeam1: firstKillProb(ctx.opening.team1, ctx.opening.team2, 0.5),
    },
    players,
    lines: priced,
    angles,
    warnings: ctx.warnings,
    lineupChanges: ctx.lineupChanges.map((c) => ({ ...c, teamName: c.teamId === ctx.team1.id ? ctx.team1.name : ctx.team2.name })),
    lineupKnown: ctx.lineupKnown,
    model: {
      version: CS2_MODEL_VERSION,
      blendW,
      phi: DEFAULT_KILL_PHI,
      sigma: DEFAULT_SIGMA,
      trainedMaps: ctx.global.trainedMaps,
      leagueRounds: ctx.global.leagueRounds,
    },
    ladder: propLadder(ctx),
    suggestedScope: suggestedScope(ctx.format, ctx.match.startAt),
  };
}

export function isPlayerMarket(m: Cs2Market): boolean {
  return PLAYER_MARKETS.has(m);
}
