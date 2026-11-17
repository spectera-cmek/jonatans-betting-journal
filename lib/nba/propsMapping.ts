// Kopplar OddsPapi:s spelar-id (historiken har inga namn) till ESPN-spelare.
//
//   1. Seed — sparade live-linjer (med ESPN-spelare) har samma pris som
//      historiken har för EN spelar-id vid samma tidpunkt och linje.
//   2. Statistisk — kandidaterna är spelarna som spelade i matcherna där id:t
//      hade en linje; kostnaden är hur långt linjerna ligger från spelarens
//      snitt FÖRE matchen. Utfallet används aldrig, annars blir backtesten
//      cirkulär (marknaden skulle se bättre ut än den är).
//
// Bara entydiga kopplingar godtas; resten lämnas okopplade.

import type { PropStatKey } from "../oddspapi/markets";
import { firstBefore, type History, type PlayerGameRow } from "./ratings";
import { priceAt, type PropSeriesByBook } from "./propsHistory";

export const MAP_STATS: PropStatKey[] = ["pts", "reb", "ast", "fg3", "pra"];

/** Ungefärlig spridning mellan en linje och spelarens snitt de senaste 10 matcherna. */
export const LINE_SIGMA: Record<PropStatKey, number> = { pts: 3.5, reb: 1.8, ast: 1.5, fg3: 0.7, pra: 5 };

export function rowStat(r: PlayerGameRow, stat: PropStatKey): number {
  const pts = 2 * r.fgm2 + 3 * r.fgm3 + r.ftm;
  const reb = r.oreb + (r.dreb ?? 0);
  const ast = r.ast ?? 0;
  switch (stat) {
    case "pts":
      return pts;
    case "reb":
      return reb;
    case "ast":
      return ast;
    case "fg3":
      return r.fgm3;
    case "pra":
      return pts + reb + ast;
  }
}

/** Spelarens snitt de senaste `n` matcherna (med minuter) före t, eller null. */
export function preGameAverage(h: History, playerId: number, t: number, stat: PropStatKey, n = 10): number | null {
  const rows = h.players.get(playerId) ?? [];
  let sum = 0;
  let k = 0;
  for (let i = firstBefore(rows, t); i < rows.length && k < n; i++) {
    if (rows[i].minutes <= 0) continue;
    sum += rowStat(rows[i], stat);
    k++;
  }
  return k ? sum / k : null;
}

// ---------------------------------------------------------------------------
// 1. Seed: sparade live-linjer mot historikens priser
// ---------------------------------------------------------------------------

export interface LiveLineRow {
  gameId: number;
  playerId: number;
  stat: string;
  line: number;
  over: number;
  under: number;
  capturedAt: number;
}

export interface SeedHit {
  playerId: number;
  votes: number;
}

/**
 * Röster per (OddsPapi-id, spelare): en sparad linje vars över- OCH underpris
 * är exakt historikens pris för id:t på samma linje vid samma tidpunkt.
 * Godtas när id:t bara fått röster för en spelare (minst `minVotes`) och
 * spelaren bara för ett id.
 */
export function seedFromLiveLines(
  rows: LiveLineRow[],
  series: Map<number, { startMs: number; books: PropSeriesByBook }>,
  book = "pinnacle",
  minVotes = 2
): Map<string, SeedHit> {
  const votes = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const g = series.get(r.gameId);
    const byPid = g?.books[book];
    if (!g || !byPid) continue;
    const t = Math.round((r.capturedAt - g.startMs) / 1000);
    for (const [pid, byStat] of Object.entries(byPid)) {
      const rung = byStat[r.stat as PropStatKey]?.[String(r.line)];
      if (!rung) continue;
      const o = priceAt(rung.o, t);
      const u = priceAt(rung.u, t);
      if (!o || !u || Math.abs(o.price - r.over) > 0.0015 || Math.abs(u.price - r.under) > 0.0015) continue;
      const m = votes.get(pid) ?? new Map<number, number>();
      m.set(r.playerId, (m.get(r.playerId) ?? 0) + 1);
      votes.set(pid, m);
    }
  }
  const out = new Map<string, SeedHit>();
  const claimed = new Map<number, string[]>();
  for (const [pid, m] of votes) {
    if (m.size !== 1) continue;
    const [[playerId, v]] = [...m];
    if (v < minVotes) continue;
    out.set(pid, { playerId, votes: v });
    { const l_ = claimed.get(playerId); if (l_) l_.push(pid); else claimed.set(playerId, [pid]); }
  }
  for (const pids of claimed.values()) if (pids.length > 1) for (const p of pids) out.delete(p);
  return out;
}

// ---------------------------------------------------------------------------
// 2. Statistisk koppling
// ---------------------------------------------------------------------------

export interface PidAppearance {
  gameId: number;
  t: number;
  homeTeamId: number;
  awayTeamId: number;
  /** Huvudlinjen per statistik (senast före start). */
  lines: Partial<Record<PropStatKey, number>>;
}

export interface StatMatch {
  pid: string;
  playerId: number;
  cost: number;
  /** Kostnaden för näst bästa kandidat minus den bästa. */
  margin: number;
  games: number;
  confidence: number;
}

export interface StatMapOptions {
  /** Kandidaten ska ha spelat i minst så stor andel av id:ts matcher. */
  minPresence?: number;
  /** Minsta marginal till tvåan (snitt av z²). */
  minMargin?: number;
  /** Högsta godtagbara kostnad (snitt av z²). */
  maxCost?: number;
  /** Straff per match där kandidaten inte spelade. */
  absencePenalty?: number;
}

/**
 * Kostnad för varje kandidat: snittet av ((linje − snitt före matchen) / σ)²
 * över id:ts matcher och statistik, plus straff för matcher kandidaten inte
 * spelade. Tilldelning girigt efter marginal, en spelare per id.
 */
export function statMap(apps: Map<string, PidAppearance[]>, h: History, fixed: Map<string, number>, opts: StatMapOptions = {}): StatMatch[] {
  const minPresence = opts.minPresence ?? 0.8;
  // Svep jan–nov 2026 (468 id, linjer vid −1h/stängning), precision mot 122
  // seed-kopplingar: marginal ≥ 0,5 och kostnad ≤ 4 → 83/83 rätt, 81 % av
  // Pinnacles rader kopplade (0,25 → 91/91 och 87,5 %; 1,5 → 55/55 och 68 %).
  const minMargin = opts.minMargin ?? 0.5;
  const maxCost = opts.maxCost ?? 4;
  const absencePenalty = opts.absencePenalty ?? 6;
  const byGame = new Map<number, PlayerGameRow[]>();
  for (const r of h.allPlayerRows) {
    const l = byGame.get(r.gameId);
    if (l) l.push(r);
    else byGame.set(r.gameId, [r]);
  }
  const avgCache = new Map<string, number | null>();
  const avg = (playerId: number, t: number, stat: PropStatKey) => {
    const k = `${playerId}|${t}|${stat}`;
    if (!avgCache.has(k)) avgCache.set(k, preGameAverage(h, playerId, t, stat));
    return avgCache.get(k)!;
  };

  const scored: Array<{ pid: string; ranked: Array<{ playerId: number; cost: number }>; games: number }> = [];
  const taken = new Set(fixed.values());
  for (const [pid, list] of apps) {
    if (fixed.has(pid)) continue;
    const presence = new Map<number, number>();
    for (const a of list) {
      for (const r of byGame.get(a.gameId) ?? []) {
        if (r.minutes > 0 && (r.teamId === a.homeTeamId || r.teamId === a.awayTeamId)) presence.set(r.playerId, (presence.get(r.playerId) ?? 0) + 1);
      }
    }
    const need = Math.max(1, Math.ceil(minPresence * list.length));
    const ranked: Array<{ playerId: number; cost: number }> = [];
    for (const [playerId, n] of presence) {
      if (n < need) continue;
      let sum = 0;
      let terms = 0;
      for (const a of list) {
        const played = (byGame.get(a.gameId) ?? []).some((r) => r.playerId === playerId && r.minutes > 0);
        if (!played) {
          sum += absencePenalty;
          terms++;
          continue;
        }
        for (const stat of MAP_STATS) {
          const line = a.lines[stat];
          if (line == null) continue;
          const m = avg(playerId, a.t, stat);
          sum += m == null ? 1 : ((line - m) / LINE_SIGMA[stat]) ** 2;
          terms++;
        }
      }
      if (terms) ranked.push({ playerId, cost: sum / terms });
    }
    ranked.sort((a, b) => a.cost - b.cost);
    if (ranked.length) scored.push({ pid, ranked, games: list.length });
  }

  // Marginalen räknas mot näst bästa kandidat bland ALLA (även redan kopplade).
  // Prövat och bortvalt: räkna mot näst bästa LEDIGA i flera varv — täckningen
  // steg (75 → 88 %) men en felkoppling tvingade fram nästa och precisionen
  // mot seed föll till ~95 %.
  const marginOf = (s: (typeof scored)[number]) => (s.ranked.length > 1 ? s.ranked[1].cost - s.ranked[0].cost : Infinity);
  scored.sort((a, b) => marginOf(b) - marginOf(a));
  const out: StatMatch[] = [];
  for (const s of scored) {
    const best = s.ranked[0];
    const margin = marginOf(s);
    if (taken.has(best.playerId) || best.cost > maxCost || margin < minMargin) continue;
    taken.add(best.playerId);
    out.push({ pid: s.pid, playerId: best.playerId, cost: best.cost, margin, games: s.games, confidence: Math.min(1, 1 - Math.exp(-margin / 2)) });
  }
  return out;
}
