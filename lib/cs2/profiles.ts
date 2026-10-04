// Aggregeringar ur CS2-databasen: lagets kartpool och spelarprofiler.
// Rena funktioner på rader — databasläsningen ligger i queries.ts — så att
// samma räkning kan testas och återanvändas av modellen och backtestet.

import type { RoundOutcome, Side } from "./types";

/** Docens SAMPLE SIZE: senaste N officiella kartor inom M månader. */
export interface SampleWindow {
  maps: number;
  months: number;
}
export const DEFAULT_WINDOW: SampleWindow = { maps: 10, months: 6 };

export const other = (s: Side): Side => (s === "ct" ? "t" : "ct");

/** Minimal form av en Cs2Map-rad som aggregeringarna behöver. */
export interface MapRowInput {
  id: number;
  matchId: number;
  mapName: string;
  playedAt: Date;
  pickedById: number | null;
  team1Id: number;
  team2Id: number;
  team1Rounds: number;
  team2Rounds: number;
  team1StartSide: string | null;
  team1CtRounds: number | null;
  team1TRounds: number | null;
  team2CtRounds: number | null;
  team2TRounds: number | null;
  otRounds: number;
  winnerId: number | null;
  roundHistory: unknown;
}

/** En karta ur ett lags perspektiv. */
export interface TeamMapRow {
  mapId: number;
  matchId: number;
  mapName: string;
  playedAt: Date;
  opponentId: number;
  roundsFor: number;
  roundsAgainst: number;
  won: boolean;
  /** Rundor laget vann på CT / T, och motståndaren vann när laget var CT / T. */
  ctWon: number | null;
  tWon: number | null;
  ctLost: number | null;
  tLost: number | null;
  startSide: Side | null;
  ot: boolean;
  pick: "own" | "opp" | "decider";
  /** Pistolrundor (1 och 13) vunna / spelade, när rundhistoriken finns. */
  pistolsWon: number | null;
  pistolsPlayed: number | null;
  /** Rundor ur lagets perspektiv: vann laget, och på vilken sida spelade det. */
  rounds: Array<{ n: number; won: boolean; side: Side }> | null;
}

export function toTeamMapRow(m: MapRowInput, teamId: number): TeamMapRow | null {
  const isT1 = m.team1Id === teamId;
  if (!isT1 && m.team2Id !== teamId) return null;
  const hist = Array.isArray(m.roundHistory) ? (m.roundHistory as RoundOutcome[]) : null;
  const rounds = hist
    ? hist.map((r) => {
        const won = (r.winner === "team1") === isT1;
        return { n: r.n, won, side: won ? r.side : other(r.side) };
      })
    : null;
  const pistols = rounds ? rounds.filter((r) => r.n === 1 || r.n === 13) : null;
  const startT1 = m.team1StartSide === "ct" || m.team1StartSide === "t" ? (m.team1StartSide as Side) : null;
  return {
    mapId: m.id,
    matchId: m.matchId,
    mapName: m.mapName,
    playedAt: m.playedAt,
    opponentId: isT1 ? m.team2Id : m.team1Id,
    roundsFor: isT1 ? m.team1Rounds : m.team2Rounds,
    roundsAgainst: isT1 ? m.team2Rounds : m.team1Rounds,
    won: m.winnerId === teamId,
    ctWon: isT1 ? m.team1CtRounds : m.team2CtRounds,
    tWon: isT1 ? m.team1TRounds : m.team2TRounds,
    // När laget var CT spelade motståndaren T, och tvärtom.
    ctLost: isT1 ? m.team2TRounds : m.team1TRounds,
    tLost: isT1 ? m.team2CtRounds : m.team1CtRounds,
    startSide: startT1 ? (isT1 ? startT1 : other(startT1)) : null,
    ot: m.otRounds > 0 || m.team1Rounds + m.team2Rounds > 24,
    pick: m.pickedById == null ? "decider" : m.pickedById === teamId ? "own" : "opp",
    pistolsWon: pistols ? pistols.filter((p) => p.won).length : null,
    pistolsPlayed: pistols ? pistols.length : null,
    rounds,
  };
}

/** Senaste N kartor inom M månader (nyast först). */
export function applyWindow<T extends { playedAt: Date }>(rows: T[], w: SampleWindow, now = new Date()): T[] {
  const since = now.getTime() - w.months * 30 * 86_400_000;
  return rows
    .filter((r) => r.playedAt.getTime() >= since)
    .sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime())
    .slice(0, w.maps);
}

export interface VetoInput {
  matchId: number;
  step: number;
  teamId: number | null;
  action: string;
  mapName: string;
  at: Date;
}

export interface MapPoolEntry {
  mapName: string;
  played: number;
  wins: number;
  winRate: number | null;
  ctRoundRate: number | null;
  tRoundRate: number | null;
  avgRounds: number | null;
  otRate: number | null;
  pistolWinRate: number | null;
  /** Lagets egna pick av kartan, och hur ofta den bannas av laget. */
  picks: number;
  bans: number;
  firstBans: number;
  /** Andel av lagets veton där kartan var dess första ban (permaban-signal). */
  firstBanRate: number | null;
  lastPlayed: Date | null;
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

/**
 * Kartpoolen: resultat per karta (inom `months`) plus vetobeteende. `maps`
 * begränsar inte här — kartpoolen ska visa hela bilden för perioden.
 */
export function teamMapPool(rows: TeamMapRow[], vetoes: VetoInput[], teamId: number, months: number, now = new Date()): MapPoolEntry[] {
  const since = now.getTime() - months * 30 * 86_400_000;
  const recent = rows.filter((r) => r.playedAt.getTime() >= since);
  const recentVetoes = vetoes.filter((v) => v.at.getTime() >= since);

  const matchesWithVeto = new Set(recentVetoes.filter((v) => v.teamId === teamId).map((v) => v.matchId));
  const firstBanOf = new Map<number, string>();
  for (const v of [...recentVetoes].sort((a, b) => a.step - b.step)) {
    if (v.teamId !== teamId || v.action !== "ban" || firstBanOf.has(v.matchId)) continue;
    firstBanOf.set(v.matchId, v.mapName);
  }

  const names = new Set<string>([...recent.map((r) => r.mapName), ...recentVetoes.map((v) => v.mapName)]);
  const out: MapPoolEntry[] = [];
  for (const mapName of names) {
    const maps = recent.filter((r) => r.mapName === mapName);
    const sum = (f: (r: TeamMapRow) => number | null) => maps.reduce((s, r) => s + (f(r) ?? 0), 0);
    const sidesKnown = maps.filter((r) => r.ctWon != null && r.ctLost != null && r.tWon != null && r.tLost != null);
    const ctW = sidesKnown.reduce((s, r) => s + r.ctWon!, 0);
    const ctL = sidesKnown.reduce((s, r) => s + r.ctLost!, 0);
    const tW = sidesKnown.reduce((s, r) => s + r.tWon!, 0);
    const tL = sidesKnown.reduce((s, r) => s + r.tLost!, 0);
    const pist = maps.filter((r) => r.pistolsPlayed != null);
    const firstBans = [...firstBanOf.values()].filter((m) => m === mapName).length;
    out.push({
      mapName,
      played: maps.length,
      wins: maps.filter((r) => r.won).length,
      winRate: ratio(maps.filter((r) => r.won).length, maps.length),
      ctRoundRate: ratio(ctW, ctW + ctL),
      tRoundRate: ratio(tW, tW + tL),
      avgRounds: maps.length ? sum((r) => r.roundsFor + r.roundsAgainst) / maps.length : null,
      otRate: ratio(maps.filter((r) => r.ot).length, maps.length),
      pistolWinRate: ratio(
        pist.reduce((s, r) => s + (r.pistolsWon ?? 0), 0),
        pist.reduce((s, r) => s + (r.pistolsPlayed ?? 0), 0)
      ),
      picks: recentVetoes.filter((v) => v.teamId === teamId && v.action === "pick" && v.mapName === mapName).length,
      bans: recentVetoes.filter((v) => v.teamId === teamId && v.action === "ban" && v.mapName === mapName).length,
      firstBans,
      firstBanRate: ratio(firstBans, matchesWithVeto.size),
      lastPlayed: maps.length ? maps.reduce((a, r) => (r.playedAt > a ? r.playedAt : a), maps[0].playedAt) : null,
    });
  }
  return out.sort((a, b) => b.played - a.played || b.picks - a.picks || a.bans - b.bans);
}

// ---------------------------------------------------------------------------
// Spelare
// ---------------------------------------------------------------------------

export interface PlayerStatInput {
  mapId: number;
  mapName: string;
  playedAt: Date;
  teamId: number;
  opponentId: number;
  side: string; // all | ct | t
  kills: number;
  deaths: number;
  headshots: number | null;
  adr: number | null;
  rating: number | null;
  kast: number | null;
  /** Rundor spelade på kartan (all) eller på sidan (ct/t). */
  rounds: number;
}

export interface PlayerMapProfile {
  mapName: string;
  maps: number;
  rounds: number;
  kills: number;
  kpr: number | null;
  hsPct: number | null;
  adr: number | null;
  rating: number | null;
  ctKpr: number | null;
  tKpr: number | null;
  /** Kills per karta, nyast först — för spridning och form. */
  killSeries: number[];
}

/** Spelarens siffror per karta (och "all" över alla kartor). */
export function playerMapProfiles(rows: PlayerStatInput[]): PlayerMapProfile[] {
  const groups = new Map<string, PlayerStatInput[]>();
  for (const r of rows) {
    for (const key of [r.mapName, "all"]) {
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
  }
  const out: PlayerMapProfile[] = [];
  for (const [mapName, list] of groups) {
    const all = list.filter((r) => r.side === "all").sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime());
    const side = (s: string) => {
      const l = list.filter((r) => r.side === s);
      const rounds = l.reduce((a, r) => a + r.rounds, 0);
      return rounds > 0 ? l.reduce((a, r) => a + r.kills, 0) / rounds : null;
    };
    const rounds = all.reduce((a, r) => a + r.rounds, 0);
    const kills = all.reduce((a, r) => a + r.kills, 0);
    const hsKnown = all.filter((r) => r.headshots != null);
    const hsKills = hsKnown.reduce((a, r) => a + r.kills, 0);
    const avg = (f: (r: PlayerStatInput) => number | null) => {
      const v = all.map(f).filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    out.push({
      mapName,
      maps: all.length,
      rounds,
      kills,
      kpr: rounds > 0 ? kills / rounds : null,
      hsPct: hsKills > 0 ? hsKnown.reduce((a, r) => a + (r.headshots ?? 0), 0) / hsKills : null,
      adr: avg((r) => r.adr),
      rating: avg((r) => r.rating),
      ctKpr: side("ct"),
      tKpr: side("t"),
      killSeries: all.map((r) => r.kills),
    });
  }
  return out.sort((a, b) => (a.mapName === "all" ? -1 : b.mapName === "all" ? 1 : b.maps - a.maps));
}

/** Summerar demofakta (PlayerSideFacts) — talfält adderas, tabeller slås ihop. */
export function sumFacts<T extends object>(list: T[]): T | null {
  if (list.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const f of list) {
    for (const [k, v] of Object.entries(f)) {
      if (k === "v") {
        out.v = v;
      } else if (typeof v === "number") {
        out[k] = ((out[k] as number) ?? 0) + v;
      } else if (Array.isArray(v)) {
        const prev = (out[k] as number[]) ?? [];
        // multi = [2k,3k,4k,5k] adderas elementvis; rk (kills per runda) läggs efter.
        out[k] = k === "multi" ? (v as number[]).map((x, i) => (prev[i] ?? 0) + x) : [...prev, ...(v as number[])];
      } else if (v && typeof v === "object") {
        const prev = (out[k] as Record<string, number>) ?? {};
        const merged: Record<string, number> = { ...prev };
        for (const [kk, vv] of Object.entries(v as Record<string, number>)) merged[kk] = (merged[kk] ?? 0) + (vv ?? 0);
        out[k] = merged;
      }
    }
  }
  return out as T;
}

/** Topp-n nycklar i en räknetabell, med andel av `total`. */
export function topCounts(rec: Record<string, number> | undefined, n: number, total?: number): Array<{ key: string; count: number; share: number | null }> {
  if (!rec) return [];
  const sum = total ?? Object.values(rec).reduce((a, b) => a + b, 0);
  return Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count, share: sum > 0 ? count / sum : null }));
}
