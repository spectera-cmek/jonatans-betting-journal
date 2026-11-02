// Stints: vilka tio spelare som var på planen, hur länge, och vad som hände.
//
// ESPN:s play-by-play loggar varje byte ("X enters the game for Y", även vid
// periodstart), och boxscoren märker startfemmorna. Uppställningen följs play
// för play; varje gång någon femma ändras stängs en stint. Per stint sparas
// poäng för båda lagen, possessions och sekunder.
//
// Kontroll: varje spelare som agerar i en play (skott, retur, turnover …)
// måste stå på planen. ESPN missar ibland ett byte; då byts spelaren in mot
// den lagkamrat som varit inaktiv längst. Matcher med fler än 8 sådana
// reparationer sparas inte — hellre ingen data än felaktiga uppställningar.

import { parseMinutes } from "./espn";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface Stint {
  homeIds: number[];
  awayIds: number[];
  homePts: number;
  awayPts: number;
  /** Possessions (snitt av lagens FGA + 0,44·FTA − OREB + TOV). */
  poss: number;
  seconds: number;
}

export interface StintParse {
  stints: Stint[];
  /** Reparerade byten: spelare som agerade utan att stå på planen enligt uppställningen. */
  mismatches: number;
  /** Medel- och största avvikelse i minuter mot boxscoren. */
  minuteMae: number;
  minuteMaxError: number;
  valid: boolean;
}

/**
 * Kvalitetskontroll mot boxscoren: spelarnas minuter ur stintarna ska stämma
 * med de officiella. Antalet reparationer säger mindre — en match med 12
 * reparationer kan stämma på minuten och en med 8 vara fel på en spelare.
 */
const MAX_MINUTE_MAE = 1.0;
const MAX_MINUTE_ERROR = 4;

function clockSeconds(display: string | undefined, period: number): number {
  // Kvar på klockan → spelad tid i perioden.
  const len = period <= 4 ? 720 : 300;
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(display ?? "").trim());
  const left = m ? Number(m[1]) * 60 + Number(m[2]) : Number(display) || 0;
  return Math.max(0, Math.min(len, len - left));
}

/** Spelade sekunder före periodens start (4 × 12 min, sedan 5 min per förlängning). */
export function periodStart(period: number): number {
  return Math.min(period - 1, 4) * 720 + Math.max(0, period - 5) * 300;
}

interface Acc {
  fga: number;
  fta: number;
  oreb: number;
  tov: number;
}

export function parseStints(json: Any): StintParse | null {
  const plays: Any[] = Array.isArray(json?.plays) ? [...json.plays] : [];
  const box: Any[] = json?.boxscore?.players ?? [];
  const comp = json?.header?.competitions?.[0];
  const homeId = Number(comp?.competitors?.find((c: Any) => c.homeAway === "home")?.team?.id ?? comp?.competitors?.find((c: Any) => c.homeAway === "home")?.id);
  const awayId = Number(comp?.competitors?.find((c: Any) => c.homeAway === "away")?.team?.id ?? comp?.competitors?.find((c: Any) => c.homeAway === "away")?.id);
  if (!plays.length || !box.length || !homeId || !awayId) return null;

  const teamOf = new Map<number, number>();
  const boxMinutes = new Map<number, number>();
  const starters: Record<number, number[]> = { [homeId]: [], [awayId]: [] };
  for (const g of box) {
    const tid = Number(g?.team?.id);
    for (const a of g?.statistics?.[0]?.athletes ?? []) {
      const id = Number(a?.athlete?.id);
      if (!id) continue;
      teamOf.set(id, tid);
      const keys: string[] = g?.statistics?.[0]?.keys ?? [];
      const mi = keys.indexOf("minutes");
      const mins = mi >= 0 ? parseMinutes(a?.stats?.[mi]) : 0;
      if (mins > 0) boxMinutes.set(id, mins);
      if (a.starter && starters[tid]) starters[tid].push(id);
    }
  }
  if (starters[homeId].length !== 5 || starters[awayId].length !== 5) return null;

  plays.sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
  const on: Record<number, Set<number>> = { [homeId]: new Set(starters[homeId]), [awayId]: new Set(starters[awayId]) };
  const stints: Stint[] = [];
  let mismatches = 0;
  // Senast spelaren syntes (agerade eller byttes in) — för att reparera missade byten.
  const lastSeen = new Map<number, number>();
  /** Ta bort den lagkamrat på planen som varit inaktiv längst (inte `keep`). */
  const dropStalest = (tid: number, keep: number) => {
    let worst: number | null = null;
    let worstT = Infinity;
    for (const id of on[tid]) {
      if (id === keep) continue;
      const t = lastSeen.get(id) ?? -1;
      if (t < worstT) {
        worstT = t;
        worst = id;
      }
    }
    if (worst != null) on[tid].delete(worst);
  };

  let startHome = 0;
  let startAway = 0;
  let startT = 0; // spelade sekunder i matchen när stinten började
  let curHome = 0;
  let curAway = 0;
  let curT = 0;
  let acc: Record<number, Acc> = { [homeId]: { fga: 0, fta: 0, oreb: 0, tov: 0 }, [awayId]: { fga: 0, fta: 0, oreb: 0, tov: 0 } };
  let lastPeriod = 1;

  const close = () => {
    const seconds = curT - startT;
    const homePts = curHome - startHome;
    const awayPts = curAway - startAway;
    const possOf = (a: Acc) => a.fga + 0.44 * a.fta - a.oreb + a.tov;
    const poss = (possOf(acc[homeId]) + possOf(acc[awayId])) / 2;
    if (seconds > 0 || homePts || awayPts || poss > 0) {
      stints.push({ homeIds: [...on[homeId]].sort((a, b) => a - b), awayIds: [...on[awayId]].sort((a, b) => a - b), homePts, awayPts, poss: Math.max(0, poss), seconds });
    }
    startHome = curHome;
    startAway = curAway;
    startT = curT;
    acc = { [homeId]: { fga: 0, fta: 0, oreb: 0, tov: 0 }, [awayId]: { fga: 0, fta: 0, oreb: 0, tov: 0 } };
  };

  for (const p of plays) {
    const period = Number(p?.period?.number) || lastPeriod;
    lastPeriod = period;
    // Spelad tid räknas ur periodnumret, inte genom att räkna periodbyten —
    // plays kommer ibland något i oordning och skulle annars räknas dubbelt.
    const t = periodStart(period) + clockSeconds(p?.clock?.displayValue, period);
    if (t > curT) curT = t;
    const type = String(p?.type?.text ?? "");
    const parts: number[] = (p?.participants ?? []).map((x: Any) => Number(x?.athlete?.id)).filter(Boolean);

    if (/^Substitution/i.test(type) && parts.length >= 2) {
      const [inId, outId] = parts;
      const tid = teamOf.get(inId) ?? teamOf.get(outId);
      if (!tid || !on[tid]) continue;
      if (on[tid].has(inId) && !on[tid].has(outId)) continue; // dubbelloggat byte
      close();
      if (!on[tid].delete(outId)) mismatches++;
      on[tid].add(inId);
      lastSeen.set(inId, curT);
      // Ett missat byte tidigare: den som skulle ut stod inte på planen — ta bort den mest inaktiva i stället.
      while (on[tid].size > 5) dropStalest(tid, inId);
      continue;
    }

    // Aktörerna ska stå på planen. Gör de inte det har ESPN missat ett byte:
    // spelaren byts in mot den lagkamrat som varit inaktiv längst (samma
    // reparation som pbpstats m.fl. gör). Varje reparation räknas.
    if (!/technical|ejection|timeout|end period|end game|challenge|delay/i.test(type)) {
      for (const id of parts) {
        const tid = teamOf.get(id);
        if (!tid || !on[tid]) continue;
        if (!on[tid].has(id)) {
          mismatches++;
          close();
          on[tid].add(id);
          while (on[tid].size > 5) dropStalest(tid, id);
        }
        lastSeen.set(id, curT);
      }
    }

    const teamId = Number(p?.team?.id);
    const a = acc[teamId];
    if (a) {
      if (p?.shootingPlay) {
        if (/free throw/i.test(type)) a.fta++;
        else a.fga++;
      }
      if (/offensive rebound/i.test(type)) a.oreb++;
      if (/turnover/i.test(type)) a.tov++;
    }
    // Ställningen kan bara öka — en play i oordning ska inte dra tillbaka den.
    if (typeof p?.homeScore === "number" && p.homeScore > curHome) curHome = p.homeScore;
    if (typeof p?.awayScore === "number" && p.awayScore > curAway) curAway = p.awayScore;
  }
  close();
  const played = new Map<number, number>();
  for (const st of stints) for (const id of [...st.homeIds, ...st.awayIds]) played.set(id, (played.get(id) ?? 0) + st.seconds / 60);
  let err = 0;
  let worst = 0;
  boxMinutes.forEach((m, id) => {
    const d = Math.abs((played.get(id) ?? 0) - m);
    err += d;
    worst = Math.max(worst, d);
  });
  const minuteMae = boxMinutes.size ? err / boxMinutes.size : 99;
  return { stints, mismatches, minuteMae, minuteMaxError: worst, valid: minuteMae <= MAX_MINUTE_MAE && worst <= MAX_MINUTE_ERROR };
}
