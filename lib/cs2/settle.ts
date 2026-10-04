// Facit för modellen: när en match är spelad fylls `actual` i på varje
// sparad projektion (Cs2Projection), och facit räknas ur dem.
//
// Den ärliga jämförelsen är modellen mot boken på samma linjer: har modellens
// P(över) lägre log-loss än bokens avviggade pris? Bara då finns en edge att
// tala om. Plattspel på de linjer modellen gav positiv edge visar resten.

import type { PrismaClient } from ".prisma/cs2-client";
import type { RoundFact } from "./demo/types";
import type { RoundOutcome } from "./types";
import { TOTAL_MARKETS, type Cs2Market } from "./types";

const SCOPE_MAPS: Record<string, number[] | null> = { map1: [1], map2: [2], map3: [3], maps12: [1, 2], match: null };

/** Utfallet för en projektion, eller undefined om det inte går att avgöra (än). null = void. */
export function projectionActual(
  p: { market: string; scope: string; playerId: number | null; teamId: number | null; line: number | null },
  match: {
    status: string;
    team1Id: number | null;
    team2Id: number | null;
    winnerId: number | null;
    maps: Array<{
      mapNumber: number;
      team1Id: number;
      team1Rounds: number;
      team2Rounds: number;
      winnerId: number | null;
      roundHistory: unknown;
      stats: Array<{ playerId: number; side: string; kills: number; headshots: number | null }>;
      firstKillTeam?: number | null;
      firstKillPlayer?: number | null;
    }>;
  }
): number | null | undefined {
  if (match.status !== "finished") return undefined;
  const want = SCOPE_MAPS[p.scope];
  const maps = want ? match.maps.filter((m) => want.includes(m.mapNumber)) : match.maps;
  if (want && maps.length < want.length) return want.includes(3) ? null : undefined; // karta 3 ospelad = void
  const team = p.teamId ?? match.team1Id;
  const market = p.market as Cs2Market;
  switch (market) {
    case "kills":
    case "headshots": {
      let sum = 0;
      for (const m of maps) {
        const row = m.stats.find((s) => s.playerId === p.playerId && s.side === "all");
        if (!row) return undefined;
        const v = market === "kills" ? row.kills : row.headshots;
        if (v == null) return undefined;
        sum += v;
      }
      return sum;
    }
    case "rounds":
      return maps.length === 1 ? maps[0].team1Rounds + maps[0].team2Rounds : undefined;
    case "map_winner":
      return maps.length === 1 && maps[0].winnerId != null ? (maps[0].winnerId === team ? 1 : 0) : undefined;
    case "map_handicap": {
      if (maps.length !== 1 || p.line == null) return undefined;
      const m = maps[0];
      const isT1 = m.team1Id === team;
      return (isT1 ? m.team1Rounds - m.team2Rounds : m.team2Rounds - m.team1Rounds) + p.line;
    }
    case "match_winner":
      return match.winnerId == null ? undefined : match.winnerId === team ? 1 : 0;
    case "match_handicap": {
      if (p.line == null) return undefined;
      const won = match.maps.filter((m) => m.winnerId === team).length;
      return won - (match.maps.length - won) + p.line;
    }
    case "total_maps":
      return match.maps.length;
    case "pistol": {
      if (maps.length !== 1) return undefined;
      const hist = Array.isArray(maps[0].roundHistory) ? (maps[0].roundHistory as RoundOutcome[]) : [];
      const r1 = hist.find((r) => r.n === 1);
      if (!r1) return undefined;
      const winner = r1.winner === "team1" ? maps[0].team1Id : maps[0].team1Id === match.team1Id ? match.team2Id : match.team1Id;
      return winner === team ? 1 : 0;
    }
    case "first_kill":
      return maps.length === 1 && maps[0].firstKillTeam != null ? (maps[0].firstKillTeam === team ? 1 : 0) : undefined;
    case "player_first_kill":
      return maps.length === 1 && maps[0].firstKillPlayer !== undefined ? (maps[0].firstKillPlayer === p.playerId ? 1 : 0) : undefined;
  }
}

/** Vann "över / sida 1"? 1, 0 eller 0,5 vid push. Totaler jämförs mot linjen; handikapp mot noll. */
export function overResult(market: string, line: number | null, actual: number): number {
  if (TOTAL_MARKETS.has(market as Cs2Market)) {
    if (line == null) return actual > 0 ? 1 : 0;
    return actual > line ? 1 : actual === line ? 0.5 : 0;
  }
  if (market === "map_handicap" || market === "match_handicap") return actual > 0 ? 1 : actual === 0 ? 0.5 : 0;
  return actual;
}

export interface FacitRow {
  market: string;
  line: number | null;
  actual: number;
  pModel: number;
  pMarket: number | null;
  pFinal: number;
  bestSide: string | null;
  bestOdds: number | null;
  edgePct: number | null;
}

export interface FacitSummary {
  settled: number;
  /** Log-loss på linjer där båda finns: modellen, boken och blandningen. */
  vsMarket: { n: number; model: number; market: number; blend: number } | null;
  /** Plattspel 1 u på varje linje modellen gav positiv edge. */
  flat: { bets: number; units: number; roi: number | null; hitRate: number | null };
  byMarket: Array<{ market: string; n: number; flatBets: number; units: number }>;
}

const ll = (p: number, y: number) => {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
};

export function summarizeFacit(rows: FacitRow[]): FacitSummary {
  const both = rows.filter((r) => r.pMarket != null);
  const yOf = (r: FacitRow) => overResult(r.market, r.line, r.actual);
  const decided = (r: FacitRow) => yOf(r) !== 0.5;
  const vs = both.filter(decided);
  let bets = 0,
    units = 0,
    hits = 0;
  const per = new Map<string, { n: number; flatBets: number; units: number }>();
  for (const r of rows) {
    const e = per.get(r.market) ?? { n: 0, flatBets: 0, units: 0 };
    e.n++;
    if (r.edgePct != null && r.edgePct > 0 && r.bestOdds && r.bestSide) {
      const y = yOf(r);
      const win = r.bestSide === "over" ? y : 1 - y;
      const pnl = win === 0.5 ? 0 : win === 1 ? r.bestOdds - 1 : -1;
      bets++;
      units += pnl;
      if (win === 1) hits++;
      e.flatBets++;
      e.units += pnl;
    }
    per.set(r.market, e);
  }
  return {
    settled: rows.length,
    vsMarket: vs.length
      ? {
          n: vs.length,
          model: vs.reduce((a, r) => a + ll(r.pModel, yOf(r)), 0) / vs.length,
          market: vs.reduce((a, r) => a + ll(r.pMarket!, yOf(r)), 0) / vs.length,
          blend: vs.reduce((a, r) => a + ll(r.pFinal, yOf(r)), 0) / vs.length,
        }
      : null,
    flat: { bets, units, roi: bets ? units / bets : null, hitRate: bets ? hits / bets : null },
    byMarket: [...per.entries()].map(([market, e]) => ({ market, ...e })).sort((a, b) => b.n - a.n),
  };
}

/** Fyller i `actual` på projektioner vars match är spelad. Returnerar antal avgjorda. */
export async function settleProjections(db: PrismaClient): Promise<number> {
  const open = await db.cs2Projection.findMany({ where: { settledAt: null }, select: { id: true, matchId: true, market: true, scope: true, playerId: true, teamId: true, line: true } });
  const matchIds = [...new Set(open.map((o) => o.matchId))];
  let settled = 0;
  for (const matchId of matchIds) {
    const m = await db.cs2Match.findUnique({
      where: { id: matchId },
      include: { maps: { include: { playerStats: true, demoTeams: true }, orderBy: { mapNumber: "asc" } } },
    });
    if (!m) continue;
    const links = await db.cs2SteamLink.findMany();
    const steamToPlayer = new Map(links.map((l) => [l.steamId, l.playerId]));
    const maps = m.maps.map((mp) => {
      // Första kill ur demofakta (runda 1), när demon är tolkad.
      let firstKillTeam: number | null | undefined;
      let firstKillPlayer: number | null | undefined;
      for (const dt of mp.demoTeams) {
        const r1 = ((dt.facts as unknown as { rounds: RoundFact[] }).rounds ?? []).find((r) => r.n === 1);
        if (!r1 || !r1.firstKillBy) continue;
        firstKillTeam = r1.firstKillBy === "own" ? dt.teamId : dt.teamId === mp.team1Id ? mp.team2Id : mp.team1Id;
        firstKillPlayer = r1.openingKiller ? steamToPlayer.get(r1.openingKiller) ?? null : null;
      }
      return {
        mapNumber: mp.mapNumber,
        team1Id: mp.team1Id,
        team1Rounds: mp.team1Rounds,
        team2Rounds: mp.team2Rounds,
        winnerId: mp.winnerId,
        roundHistory: mp.roundHistory,
        stats: mp.playerStats,
        firstKillTeam,
        firstKillPlayer,
      };
    });
    for (const p of open.filter((o) => o.matchId === matchId)) {
      const actual = projectionActual(p, { status: m.status, team1Id: m.team1Id, team2Id: m.team2Id, winnerId: m.winnerId, maps });
      if (actual === undefined) continue;
      await db.cs2Projection.update({ where: { id: p.id }, data: { actual, settledAt: new Date() } });
      settled++;
    }
  }
  return settled;
}
