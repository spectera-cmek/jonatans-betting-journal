// Tidigare möten mellan lagen och lagens senaste form — det Jonatan annars
// letar upp på HLTV ("h2h") innan han väljer spel.

import type { PrismaClient } from ".prisma/cs2-client";
import { mapLabel } from "./maps";

export interface H2hMap {
  mapName: string;
  label: string;
  /** Rundor för matchens lag 1 och lag 2 (inte det dåvarande lag 1). */
  r1: number;
  r2: number;
  winner: 1 | 2 | null;
}

export interface H2hMeeting {
  matchId: number;
  startAt: string;
  eventName: string | null;
  format: string;
  /** Kartor vunna av lag 1 och lag 2. */
  s1: number;
  s2: number;
  winner: 1 | 2 | null;
  maps: H2hMap[];
}

export interface FormItem {
  matchId: number;
  startAt: string;
  eventName: string | null;
  format: string;
  oppId: number | null;
  oppName: string;
  oppRank: number | null;
  /** Kartor vunna / förlorade. */
  won: number;
  lost: number;
  result: "win" | "loss" | "draw";
}

export interface HeadToHeadView {
  meetings: H2hMeeting[];
  /** Kartfacit i mötena, per karta. */
  mapRecord: Array<{ mapName: string; label: string; w1: number; w2: number }>;
  form: { team1: FormItem[]; team2: FormItem[] };
}

type MatchRow = {
  id: number;
  startAt: Date;
  eventName: string | null;
  format: string;
  team1Id: number | null;
  team2Id: number | null;
  team1Name: string;
  team2Name: string;
  winnerId: number | null;
  maps: Array<{ mapNumber: number; mapName: string; team1Id: number; team1Rounds: number; team2Rounds: number }>;
};

/** Kartor vunna av `teamId` och av motståndaren i en serie. */
export function mapsWon(m: Pick<MatchRow, "maps">, teamId: number): { won: number; lost: number } {
  let won = 0,
    lost = 0;
  for (const mp of m.maps) {
    const mine = mp.team1Id === teamId ? mp.team1Rounds : mp.team2Rounds;
    const theirs = mp.team1Id === teamId ? mp.team2Rounds : mp.team1Rounds;
    if (mine > theirs) won++;
    else if (theirs > mine) lost++;
  }
  return { won, lost };
}

export function summarizeHeadToHead(
  team1Id: number,
  team2Id: number,
  meetings: MatchRow[],
  form1: MatchRow[],
  form2: MatchRow[],
  ranks: Map<number, number | null>
): HeadToHeadView {
  const side = (id: number | null): 1 | 2 | null => (id === team1Id ? 1 : id === team2Id ? 2 : null);
  const out: H2hMeeting[] = meetings.map((m) => {
    const maps = [...m.maps]
      .sort((a, b) => a.mapNumber - b.mapNumber)
      .map((mp) => {
        const r1 = mp.team1Id === team1Id ? mp.team1Rounds : mp.team2Rounds;
        const r2 = mp.team1Id === team1Id ? mp.team2Rounds : mp.team1Rounds;
        return { mapName: mp.mapName, label: mapLabel(mp.mapName), r1, r2, winner: r1 > r2 ? (1 as const) : r2 > r1 ? (2 as const) : null };
      });
    const { won, lost } = mapsWon(m, team1Id);
    return { matchId: m.id, startAt: m.startAt.toISOString(), eventName: m.eventName, format: m.format, s1: won, s2: lost, winner: side(m.winnerId), maps };
  });
  const rec = new Map<string, { w1: number; w2: number }>();
  for (const m of out)
    for (const mp of m.maps) {
      const r = rec.get(mp.mapName) ?? { w1: 0, w2: 0 };
      if (mp.winner === 1) r.w1++;
      if (mp.winner === 2) r.w2++;
      rec.set(mp.mapName, r);
    }
  const formOf = (teamId: number, rows: MatchRow[]): FormItem[] =>
    rows.map((m) => {
      const oppId = m.team1Id === teamId ? m.team2Id : m.team1Id;
      const oppName = m.team1Id === teamId ? m.team2Name : m.team1Name;
      const { won, lost } = mapsWon(m, teamId);
      const result: FormItem["result"] = m.winnerId === teamId ? "win" : m.winnerId != null ? "loss" : won > lost ? "win" : lost > won ? "loss" : "draw";
      return { matchId: m.id, startAt: m.startAt.toISOString(), eventName: m.eventName, format: m.format, oppId, oppName, oppRank: oppId != null ? ranks.get(oppId) ?? null : null, won, lost, result };
    });
  return {
    meetings: out,
    mapRecord: [...rec].map(([mapName, r]) => ({ mapName, label: mapLabel(mapName), ...r })).sort((a, b) => b.w1 + b.w2 - (a.w1 + a.w2)),
    form: { team1: formOf(team1Id, form1), team2: formOf(team2Id, form2) },
  };
}

const SELECT = {
  id: true,
  startAt: true,
  eventName: true,
  format: true,
  team1Id: true,
  team2Id: true,
  team1Name: true,
  team2Name: true,
  winnerId: true,
  maps: { select: { mapNumber: true, mapName: true, team1Id: true, team1Rounds: true, team2Rounds: true } },
} as const;

/** Möten senaste året och båda lagens tio senaste serier, före matchen. */
export async function loadHeadToHead(db: PrismaClient, team1Id: number, team2Id: number, before: Date): Promise<HeadToHeadView> {
  const since = new Date(before.getTime() - 365 * 86_400_000);
  const played = { status: "finished", startAt: { lt: before } };
  const [meetings, f1, f2] = await Promise.all([
    db.cs2Match.findMany({
      where: {
        ...played,
        startAt: { lt: before, gte: since },
        OR: [
          { team1Id, team2Id },
          { team1Id: team2Id, team2Id: team1Id },
        ],
      },
      orderBy: { startAt: "desc" },
      take: 8,
      select: SELECT,
    }),
    db.cs2Match.findMany({ where: { ...played, OR: [{ team1Id }, { team2Id: team1Id }] }, orderBy: { startAt: "desc" }, take: 10, select: SELECT }),
    db.cs2Match.findMany({ where: { ...played, OR: [{ team1Id: team2Id }, { team2Id }] }, orderBy: { startAt: "desc" }, take: 10, select: SELECT }),
  ]);
  const oppIds = [...new Set([...f1, ...f2].flatMap((m) => [m.team1Id, m.team2Id]).filter((x): x is number => x != null))];
  const teams = await db.cs2Team.findMany({ where: { id: { in: oppIds } }, select: { id: true, rank: true } });
  return summarizeHeadToHead(team1Id, team2Id, meetings, f1, f2, new Map(teams.map((t) => [t.id, t.rank])));
}
