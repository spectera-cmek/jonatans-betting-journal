// Vilka kartor spelas? Ur lagens pick/ban-historik och vetots ordning.
//
// Varje steg väljer laget en karta bland de kvarvarande med sannolikhet
// proportionell mot hur ofta det gjort samma val tidigare (tidsviktat, med
// en liten pseudoräkning så att aldrig sett ≠ omöjligt). Alla vägar genom
// vetot räknas igenom exakt — sju kartor ger några tusen vägar, inget mer.
//
// Vilket lag som börjar vetot (oftast högst seedat) är okänt före matchen,
// så båda ordningarna vägs lika om inget annat anges.

import type { SeriesFormat } from "./types";

export interface VetoHistoryRow {
  teamId: number | null;
  action: string;
  mapName: string;
  at: Date;
}

export interface TeamVetoProfile {
  ban: Record<string, number>;
  pick: Record<string, number>;
  /** Viktat antal veton bakom profilen. */
  weight: number;
}

export function vetoProfile(rows: VetoHistoryRow[], teamId: number, pool: string[], now = new Date(), halfLifeDays = 90): TeamVetoProfile {
  const ban: Record<string, number> = {};
  const pick: Record<string, number> = {};
  let weight = 0;
  for (const m of pool) {
    ban[m] = 0;
    pick[m] = 0;
  }
  for (const r of rows) {
    if (r.teamId !== teamId || !pool.includes(r.mapName)) continue;
    const w = Math.pow(0.5, Math.max(0, now.getTime() - r.at.getTime()) / 86_400_000 / halfLifeDays);
    if (r.action === "ban") ban[r.mapName] += w;
    else if (r.action === "pick") pick[r.mapName] += w;
    else continue;
    weight += w;
  }
  return { ban, pick, weight };
}

export type VetoStep = { team: "X" | "Y"; action: "ban" | "pick" } | { team: null; action: "decider" };

/**
 * Vetoordningen för ett format och en pool. X börjar. Standard för sju
 * kartor: BO1 = sex ban + decider, BO3 = ban ban pick pick ban ban + decider,
 * BO5 = ban ban pick pick pick pick + decider. Andra poolstorlekar fyller ut
 * med alternerande ban före decidern.
 */
export function vetoSequence(format: SeriesFormat, poolSize: number): VetoStep[] {
  const picks = format === "bo1" ? 0 : format === "bo3" ? 2 : 4;
  const steps: VetoStep[] = [];
  let remaining = poolSize;
  let turn: "X" | "Y" = "X";
  const push = (action: "ban" | "pick") => {
    steps.push({ team: turn, action });
    turn = turn === "X" ? "Y" : "X";
    remaining--;
  };
  // Två inledande ban.
  for (let i = 0; i < 2 && remaining > 1; i++) push("ban");
  for (let i = 0; i < picks && remaining > 1; i++) push("pick");
  while (remaining > 1) push("ban");
  steps.push({ team: null, action: "decider" });
  return steps;
}

export interface VetoPath {
  /** Spelade kartor i ordning (pick 1, pick 2, …, decider). */
  maps: string[];
  p: number;
}

export interface VetoDistribution {
  paths: VetoPath[];
  /** Per karta: P(karta n = m) och P(m spelas alls, givet att serien går dit). */
  marginal: Record<string, { p1: number; p2: number; p3: number; p4: number; p5: number }>;
  pool: string[];
}

const ALPHA = 0.5;

function choiceProbs(profile: TeamVetoProfile, action: "ban" | "pick", remaining: string[]): number[] {
  const raw = remaining.map((m) => {
    if (action === "ban") return (profile.ban[m] ?? 0) + ALPHA;
    // Ett lag väljer sällan en karta det brukar banna.
    const banShare = profile.weight > 0 ? (profile.ban[m] ?? 0) / profile.weight : 0;
    return ((profile.pick[m] ?? 0) + ALPHA) * Math.max(0.05, 1 - 2 * banShare);
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / sum);
}

export function vetoDistribution(
  format: SeriesFormat,
  pool: string[],
  profA: TeamVetoProfile,
  profB: TeamVetoProfile,
  /** Sannolikheten att A börjar vetot. */
  pAFirst = 0.5
): VetoDistribution {
  const steps = vetoSequence(format, pool.length);
  const agg = new Map<string, number>();

  const walk = (stepIdx: number, remaining: string[], played: string[], p: number, x: TeamVetoProfile, y: TeamVetoProfile) => {
    if (p < 1e-9) return;
    const step = steps[stepIdx];
    if (!step) return;
    if (step.action === "decider") {
      const maps = remaining.length ? [...played, remaining[0]] : played;
      const key = maps.join(",");
      agg.set(key, (agg.get(key) ?? 0) + p);
      return;
    }
    const prof = step.team === "X" ? x : y;
    const probs = choiceProbs(prof, step.action, remaining);
    remaining.forEach((m, i) => {
      const rest = remaining.filter((r) => r !== m);
      walk(stepIdx + 1, rest, step.action === "pick" ? [...played, m] : played, p * probs[i], x, y);
    });
  };
  if (pAFirst > 0) walk(0, [...pool], [], pAFirst, profA, profB);
  if (pAFirst < 1) walk(0, [...pool], [], 1 - pAFirst, profB, profA);

  const paths: VetoPath[] = [...agg.entries()].map(([k, p]) => ({ maps: k.split(","), p }));
  const marginal: VetoDistribution["marginal"] = {};
  for (const m of pool) marginal[m] = { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0 };
  for (const path of paths) {
    path.maps.forEach((m, i) => {
      const key = `p${i + 1}` as "p1";
      if (marginal[m] && i < 5) marginal[m][key] += path.p;
    });
  }
  return { paths, marginal, pool };
}

/** Ett redan genomfört veto: en enda väg med sannolikhet 1. */
export function knownVeto(maps: string[], pool: string[]): VetoDistribution {
  const marginal: VetoDistribution["marginal"] = {};
  for (const m of new Set([...pool, ...maps])) marginal[m] = { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0 };
  maps.forEach((m, i) => {
    if (i < 5) marginal[m][`p${i + 1}` as "p1"] = 1;
  });
  return { paths: [{ maps, p: 1 }], marginal, pool };
}

/**
 * Seriens utfall ur kartsannolikheterna längs varje vetoväg. `pMap(m)` är
 * P(A vinner kartan m). Returnerar P(A vinner), resultatfördelning och
 * P(karta 3/4/5 spelas).
 */
export function seriesProbs(
  format: SeriesFormat,
  veto: VetoDistribution,
  pMap: (map: string) => number
): { pA: number; scores: Record<string, number>; pMapPlayed: number[] } {
  const need = format === "bo1" ? 1 : format === "bo3" ? 2 : 3;
  const scores: Record<string, number> = {};
  const pMapPlayed = [0, 0, 0, 0, 0];
  let pA = 0;
  for (const path of veto.paths) {
    // DP över kartorna i ordning: (vinster A, vinster B) → p.
    let states = new Map<string, number>([["0,0", 1]]);
    for (let i = 0; i < path.maps.length; i++) {
      const next = new Map<string, number>();
      const q = pMap(path.maps[i]);
      for (const [key, p] of states) {
        const [a, b] = key.split(",").map(Number);
        if (a === need || b === need) {
          next.set(key, (next.get(key) ?? 0) + p);
          continue;
        }
        pMapPlayed[i] += p * path.p;
        next.set(`${a + 1},${b}`, (next.get(`${a + 1},${b}`) ?? 0) + p * q);
        next.set(`${a},${b + 1}`, (next.get(`${a},${b + 1}`) ?? 0) + p * (1 - q));
      }
      states = next;
    }
    for (const [key, p] of states) {
      scores[key] = (scores[key] ?? 0) + p * path.p;
      const [a] = key.split(",").map(Number);
      if (a === need) pA += p * path.p;
    }
  }
  return { pA, scores, pMapPlayed };
}
