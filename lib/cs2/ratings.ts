// Rundvinst-ratings: hur sannolikt ett lag vinner en köprunda på en viss
// karta och sida mot ett visst motstånd.
//
//   logit P(CT-laget X vinner en runda mot T-laget Y på karta m)
//     = μ_m + ct[X,m] − t[Y,m] ± h
//
// h är HLTV:s lag 1-fördel (+h när lag 1 är CT, −h när lag 1 är T). Lag 1
// vinner klart oftare än modellen utan h tror — troligen för att HLTV
// listar den högre seedade laget först — och ordningen är känd före matchen.
//
// μ_m är kartans CT-fördel. ct/t är lagets förmåga på sidan, krympta i två
// nivåer: kartans värde mot lagets värde över alla kartor (τ_map), och det
// mot noll (τ_team). Ett lag med tre kartor Anubis får alltså mest sin
// allmänna nivå där, inte tre kartors brus.
//
// Rundorna i en karta är inte oberoende (ekonomi, momentum), så varje
// runda räknas som 1/roundDispersion observation. Annars tror modellen att
// en karta säger mer än den gör, och lag med få kartor får extremvärden.
//
// Spelarläge (tauPlayer > 0): lagets förmåga på en sida = lagets värde ovan
// + medel av de fem spelarnas egna värden (pc/pt, krympta mot 0). En spelare
// som byter lag tar med sig sitt värde, en okänd stand-in börjar på 0, så
// en saknad stjärna eller en värvning syns i priset. Lagvärdet krymps då
// hårdare (tauTeam 0,3), eftersom spelarna bär det mesta av nivån.
//
// Observationer vägs med halveringstid (standard 120 dagar). Pistolrundor
// modelleras separat — de är nästan slumpmässiga och skulle annars spä ut
// köprundornas signal — liksom konverteringen efter vunnen pistol.

import type { RoundOutcome } from "./types";

export interface SideObs {
  map: string;
  ctTeam: number;
  tTeam: number;
  /** Rundor CT-laget vann / rundor spelade med de sidorna. */
  ctWins: number;
  rounds: number;
  w: number;
  /** HLTV:s lag 1 i matchen (för lag 1-fördelen). */
  team1?: number;
  /** Spelarna i CT- och T-laget (spelarläge). */
  ctLineup?: number[];
  tLineup?: number[];
}

export interface PistolObs {
  ctTeam: number;
  tTeam: number;
  ctWon: boolean;
  w: number;
}

export interface RatingOptions {
  tauTeam?: number;
  tauMap?: number;
  tauPistol?: number;
  iterations?: number;
  /** Hur många rundor som motsvarar en oberoende observation (≥ 1). */
  roundDispersion?: number;
  /** Prior-sd för lag 1-fördelen h. 0 = ingen lag 1-fördel. */
  tauTeam1?: number;
  /** Prior-sd för spelarvärdena. 0/utelämnad = lagmodell utan spelare. */
  tauPlayer?: number;
}

/** Standard, valda med walk-forward-backtest på HLTV-data (se backtest.ts). */
export const DEFAULT_ROUND_DISPERSION = 4;
export const DEFAULT_TAU_TEAM1 = 0.2;
/**
 * Spelarläget, valt med walk-forward-backtest på 3 433 kartor: log-loss
 * 0,6653 → 0,6559 (träff 59,4 → 60,9 %), efter ett spelarbyte 0,6560 → 0,6361.
 */
export const DEFAULT_TAU_PLAYER = 1.2;
export const DEFAULT_TAU_TEAM_WITH_PLAYERS = 0.3;
/** Spelarläget konvergerar på ~10 varv (log-likelihood oförändrad till 80); 25 ger marginal. */
export const PLAYER_MODE_ITERATIONS = 25;
/**
 * Mellan två topplag (båda bevakade, topp 50) är skillnaderna i förmåga
 * mindre än modellen skattar: i walk-forward-backtest vann en favorit på
 * 67 % bara 60 % av kartorna. Lagskillnaden skalas därför ner där. Värdet
 * valdes på första halvan av datan och höll på andra (log-loss topp mot
 * topp 0,6897 → 0,6883). För övriga matcher gav ingen skala stabil vinst.
 */
export const TOP_TIER_SPREAD = 0.8;

/** Skalan på lagskillnaden för en match (se TOP_TIER_SPREAD). */
export function matchSpread(team1Tracked: boolean, team2Tracked: boolean): number {
  return team1Tracked && team2Tracked ? TOP_TIER_SPREAD : 1;
}

export interface RatingModel {
  mapBias: Record<string, number>;
  /** "team|map" och "team|*" → förmåga på logit-skala. */
  ct: Record<string, number>;
  t: Record<string, number>;
  pistolBias: number;
  pistol: Record<number, number>;
  /** Lag 1-fördel per runda på logit-skala (h). */
  team1Bias: number;
  /** P(pistolvinnaren vinner runda 2) och P(vinnaren av 1+2 vinner runda 3). */
  conv2: number;
  conv3: number;
  /** Rundor bakom lagets värde per karta — för osäkerhetsflaggor. */
  rounds: Record<string, number>;
  /** Spelarläge: spelarnas värden på CT och T. */
  playerCt?: Record<number, number>;
  playerT?: Record<number, number>;
  /** Spelarläge: lagets senaste femma (standard när matchens inte är känd). */
  lineups?: Record<number, number[]>;
}

export const DEFAULT_CONV2 = 0.8;
/** Steglängd för parametrar som uppdateras samtidigt (se fitRatings). */
const DAMPING = 0.5;
export const DEFAULT_CONV3 = 0.7;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const logit = (p: number) => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
};

export function timeWeight(playedAt: Date, now: Date, halfLifeDays = 120): number {
  const ageDays = Math.max(0, (now.getTime() - playedAt.getTime()) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Två observationer per karta: team1 som CT och team2 som CT. */
export function sideObsFromMap(
  m: {
    mapName: string;
    team1Id: number;
    team2Id: number;
    team1CtRounds: number | null;
    team1TRounds: number | null;
    team2CtRounds: number | null;
    team2TRounds: number | null;
  },
  w: number,
  /** Spelarna per lag-id på kartan (spelarläge). */
  lineups?: Record<number, number[]>
): SideObs[] {
  const { team1CtRounds: a, team1TRounds: b, team2CtRounds: c, team2TRounds: d } = m;
  if (a == null || b == null || c == null || d == null) return [];
  const out: SideObs[] = [];
  const team1 = m.team1Id;
  const l1 = lineups?.[m.team1Id];
  const l2 = lineups?.[m.team2Id];
  if (a + d > 0) out.push({ map: m.mapName, ctTeam: m.team1Id, tTeam: m.team2Id, ctWins: a, rounds: a + d, w, team1, ctLineup: l1, tLineup: l2 });
  if (c + b > 0) out.push({ map: m.mapName, ctTeam: m.team2Id, tTeam: m.team1Id, ctWins: c, rounds: c + b, w, team1, ctLineup: l2, tLineup: l1 });
  return out;
}

/** Spelarna per lag ur en kartas scoreboard-rader. */
export function lineupsFromPlayers(players: Array<{ playerId: number; teamId: number }>): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const p of players) (out[p.teamId] ??= []).push(p.playerId);
  return out;
}

/** Pistolrundor (1 och 13) ur rundhistoriken. */
export function pistolObsFromMap(m: { team1Id: number; team2Id: number; roundHistory: unknown }, w: number): PistolObs[] {
  const hist = Array.isArray(m.roundHistory) ? (m.roundHistory as RoundOutcome[]) : [];
  const out: PistolObs[] = [];
  for (const r of hist) {
    if (r.n !== 1 && r.n !== 13) continue;
    const winner = r.winner === "team1" ? m.team1Id : m.team2Id;
    const loser = r.winner === "team1" ? m.team2Id : m.team1Id;
    out.push(r.side === "ct" ? { ctTeam: winner, tTeam: loser, ctWon: true, w } : { ctTeam: loser, tTeam: winner, ctWon: false, w });
  }
  return out;
}

/** Ligans konvertering efter vunnen pistol, ur rundhistoriken. */
export function conversionRates(histories: unknown[]): { conv2: number; conv3: number; n2: number; n3: number } {
  let w2 = 0,
    n2 = 0,
    w3 = 0,
    n3 = 0;
  for (const h of histories) {
    if (!Array.isArray(h)) continue;
    const rounds = h as RoundOutcome[];
    const by = new Map(rounds.map((r) => [r.n, r.winner]));
    for (const start of [1, 13]) {
      const p = by.get(start);
      const r2 = by.get(start + 1);
      const r3 = by.get(start + 2);
      if (!p || !r2) continue;
      n2++;
      if (r2 === p) {
        w2++;
        if (r3) {
          n3++;
          if (r3 === p) w3++;
        }
      }
    }
  }
  // Krympt mot standardvärdena så att få observationer inte ger extremvärden.
  const k = 30;
  return {
    conv2: (w2 + k * DEFAULT_CONV2) / (n2 + k),
    conv3: (w3 + k * DEFAULT_CONV3) / (n3 + k),
    n2,
    n3,
  };
}

export function fitRatings(
  obs: SideObs[],
  pistols: PistolObs[],
  conv: { conv2: number; conv3: number },
  opts: RatingOptions = {}
): RatingModel {
  const tauTeam = opts.tauTeam ?? 0.5;
  const tauMap = opts.tauMap ?? 0.25;
  const tauPistol = opts.tauPistol ?? 0.25;
  const iterations = opts.iterations ?? 60;
  const vTeam = tauTeam * tauTeam;
  const vMap = tauMap * tauMap;
  const tauTeam1 = opts.tauTeam1 ?? DEFAULT_TAU_TEAM1;
  const vTeam1 = tauTeam1 * tauTeam1;
  // Rundorna vägs ner en gång för alla, så att resten av anpassningen är oförändrad.
  const disp = Math.max(1, opts.roundDispersion ?? DEFAULT_ROUND_DISPERSION);
  if (disp !== 1) obs = obs.map((o) => ({ ...o, w: o.w / disp }));

  const mapBias: Record<string, number> = {};
  const ct: Record<string, number> = {};
  const t: Record<string, number> = {};
  const rounds: Record<string, number> = {};
  for (const o of obs) {
    mapBias[o.map] ??= 0;
    ct[`${o.ctTeam}|${o.map}`] ??= 0;
    t[`${o.tTeam}|${o.map}`] ??= 0;
    ct[`${o.ctTeam}|*`] ??= 0;
    t[`${o.tTeam}|*`] ??= 0;
    rounds[`${o.ctTeam}|${o.map}`] = (rounds[`${o.ctTeam}|${o.map}`] ?? 0) + o.rounds;
    rounds[`${o.tTeam}|${o.map}`] = (rounds[`${o.tTeam}|${o.map}`] ?? 0) + o.rounds;
  }

  // Spelarläge: separat anpassning (se fitWithPlayers), samma pistolmodell.
  const tauPlayer = opts.tauPlayer ?? 0;
  const vPlayer = tauPlayer * tauPlayer;
  if (vPlayer > 0) {
    const f = fitWithPlayers(obs, { vPlayer, vMap, vTeam, vTeam1, iterations });
    Object.assign(mapBias, f.mapBias);
    Object.assign(ct, f.ct);
    Object.assign(t, f.t);
    const model = finish(f.team1Bias);
    model.playerCt = f.pc;
    model.playerT = f.pt;
    model.lineups = f.lineups;
    return model;
  }

  let team1Bias = 0;
  const eta = (o: SideObs) =>
    mapBias[o.map] + ct[`${o.ctTeam}|${o.map}`] - t[`${o.tTeam}|${o.map}`] + team1Bias * team1Sign(o.ctTeam, o.tTeam, o.team1);

  for (let it = 0; it < iterations; it++) {
    // Kartornas CT-fördel (svag prior mot 0).
    const gm: Record<string, number> = {};
    const hm: Record<string, number> = {};
    for (const o of obs) {
      const p = sigmoid(eta(o));
      gm[o.map] = (gm[o.map] ?? 0) + o.w * (o.ctWins - o.rounds * p);
      hm[o.map] = (hm[o.map] ?? 0) + o.w * o.rounds * p * (1 - p);
    }
    for (const m of Object.keys(mapBias)) mapBias[m] += (gm[m] - mapBias[m]) / (hm[m] + 1);

    // Lag 1-fördelen, krympt mot 0 med prior-sd tauTeam1.
    if (vTeam1 > 0) {
      let gh = 0,
        hh = 0;
      for (const o of obs) {
        const sgn = team1Sign(o.ctTeam, o.tTeam, o.team1);
        if (sgn === 0) continue;
        const p = sigmoid(eta(o));
        gh += sgn * o.w * (o.ctWins - o.rounds * p);
        hh += o.w * o.rounds * p * (1 - p);
      }
      team1Bias += (gh - team1Bias / vTeam1) / (hh + 1 / vTeam1);
    }

    // Lagets förmåga per karta och sida, med prior = lagets allmänna nivå.
    const g: Record<string, number> = {};
    const h: Record<string, number> = {};
    for (const o of obs) {
      const p = sigmoid(eta(o));
      const resid = o.w * (o.ctWins - o.rounds * p);
      const info = o.w * o.rounds * p * (1 - p);
      const kc = `c|${o.ctTeam}|${o.map}`;
      const kt = `t|${o.tTeam}|${o.map}`;
      g[kc] = (g[kc] ?? 0) + resid;
      h[kc] = (h[kc] ?? 0) + info;
      g[kt] = (g[kt] ?? 0) - resid;
      h[kt] = (h[kt] ?? 0) + info;
    }
    // CT- och T-parametrarna i samma observation flyttas samtidigt från samma
    // gradient — utan dämpning skjuter de över varandra och svänger.
    for (const [key, grad] of Object.entries(g)) {
      const [side, team, map] = key.split("|");
      const store = side === "c" ? ct : t;
      const k = `${team}|${map}`;
      const prior = store[`${team}|*`] ?? 0;
      const val = store[k];
      store[k] = val + DAMPING * ((grad - (val - prior) / vMap) / (h[key] + 1 / vMap));
    }

    // Lagets allmänna nivå: medel av kartvärdena, krympt mot 0.
    for (const store of [ct, t]) {
      const sum: Record<string, number> = {};
      const cnt: Record<string, number> = {};
      for (const [k, v] of Object.entries(store)) {
        const [team, map] = k.split("|");
        if (map === "*") continue;
        sum[team] = (sum[team] ?? 0) + v;
        cnt[team] = (cnt[team] ?? 0) + 1;
      }
      for (const team of Object.keys(sum)) store[`${team}|*`] = sum[team] / vMap / (cnt[team] / vMap + 1 / vTeam);
    }
  }

  return finish(team1Bias);

  function finish(team1Bias: number): RatingModel {
  // Pistol: en förmåga per lag, kraftigt krympt.
  let pistolBias = 0;
  const pistol: Record<number, number> = {};
  for (const p of pistols) {
    pistol[p.ctTeam] ??= 0;
    pistol[p.tTeam] ??= 0;
  }
  const vP = tauPistol * tauPistol;
  for (let it = 0; it < iterations; it++) {
    // Interceptet först, sedan lagen på färska residualer (Gauss–Seidel).
    let gb = 0,
      hb = 0;
    for (const p of pistols) {
      const pr = sigmoid(pistolBias + pistol[p.ctTeam] - pistol[p.tTeam]);
      gb += p.w * ((p.ctWon ? 1 : 0) - pr);
      hb += p.w * pr * (1 - pr);
    }
    pistolBias += (gb - pistolBias) / (hb + 1);
    const g: Record<number, number> = {};
    const h: Record<number, number> = {};
    for (const p of pistols) {
      const pr = sigmoid(pistolBias + pistol[p.ctTeam] - pistol[p.tTeam]);
      const resid = p.w * ((p.ctWon ? 1 : 0) - pr);
      const info = p.w * pr * (1 - pr);
      g[p.ctTeam] = (g[p.ctTeam] ?? 0) + resid;
      h[p.ctTeam] = (h[p.ctTeam] ?? 0) + info;
      g[p.tTeam] = (g[p.tTeam] ?? 0) - resid;
      h[p.tTeam] = (h[p.tTeam] ?? 0) + info;
    }
    for (const team of Object.keys(g)) {
      const id = Number(team);
      pistol[id] += DAMPING * ((g[id] - pistol[id] / vP) / (h[id] + 1 / vP));
    }
  }

  return { mapBias, ct, t, pistolBias, pistol, team1Bias, conv2: conv.conv2, conv3: conv.conv3, rounds };
  }
}

function lineupMean(store: Record<number, number>, lineup: number[] | undefined): number {
  if (!lineup || lineup.length === 0) return 0;
  let s = 0;
  for (const p of lineup) s += store[p] ?? 0;
  return s / lineup.length;
}

/**
 * Spelarläget. logit = μ_m + dev[lag|karta] + lag[lag] + medel(spelare) ± h,
 * där dev, lag och spelare krymps mot 0 var för sig och uppdateras med dämpade
 * steg. (Lagvärdet som prior för kartvärdet, som i lagmodellen, räknar samma
 * residual två gånger när spelarna ligger ovanpå och divergerar.) Resultatet
 * skrivs i lagmodellens form: ct[lag|karta] = dev + lag, ct[lag|*] = lag.
 */
function fitWithPlayers(
  obs: SideObs[],
  o: { vPlayer: number; vMap: number; vTeam: number; vTeam1: number; iterations: number }
) {
  const mapBias: Record<string, number> = {};
  const dc: Record<string, number> = {};
  const dt: Record<string, number> = {};
  const tc: Record<number, number> = {};
  const tt: Record<number, number> = {};
  const pc: Record<number, number> = {};
  const pt: Record<number, number> = {};
  // Lagets senaste femma = den med högst vikt (nyast).
  const latest: Record<number, { w: number; lineup: number[] }> = {};
  for (const x of obs) {
    mapBias[x.map] ??= 0;
    dc[`${x.ctTeam}|${x.map}`] ??= 0;
    dt[`${x.tTeam}|${x.map}`] ??= 0;
    tc[x.ctTeam] ??= 0;
    tt[x.tTeam] ??= 0;
    for (const p of x.ctLineup ?? []) pc[p] ??= 0;
    for (const p of x.tLineup ?? []) pt[p] ??= 0;
    for (const [team, lu] of [
      [x.ctTeam, x.ctLineup],
      [x.tTeam, x.tLineup],
    ] as const) {
      if (lu && lu.length > 0 && (latest[team]?.w ?? -1) < x.w) latest[team] = { w: x.w, lineup: lu };
    }
  }
  let h = 0;
  const eta = (x: SideObs) =>
    mapBias[x.map] +
    dc[`${x.ctTeam}|${x.map}`] -
    dt[`${x.tTeam}|${x.map}`] +
    tc[x.ctTeam] -
    tt[x.tTeam] +
    lineupMean(pc, x.ctLineup) -
    lineupMean(pt, x.tLineup) +
    h * team1Sign(x.ctTeam, x.tTeam, x.team1);
  const resid = (x: SideObs) => {
    const p = sigmoid(eta(x));
    return [x.w * (x.ctWins - x.rounds * p), x.w * x.rounds * p * (1 - p)] as const;
  };
  const step = (store: Record<string | number, number>, key: string | number, g: number, hh: number, v: number) => {
    store[key] += DAMPING * ((g - store[key] / v) / (hh + 1 / v));
  };

  for (let it = 0; it < o.iterations; it++) {
    {
      const g: Record<string, number> = {};
      const hh: Record<string, number> = {};
      for (const x of obs) {
        const [r, i] = resid(x);
        g[x.map] = (g[x.map] ?? 0) + r;
        hh[x.map] = (hh[x.map] ?? 0) + i;
      }
      for (const m of Object.keys(mapBias)) mapBias[m] += (g[m] - mapBias[m]) / (hh[m] + 1);
    }
    if (o.vTeam1 > 0) {
      let g = 0;
      let hh = 0;
      for (const x of obs) {
        const sgn = team1Sign(x.ctTeam, x.tTeam, x.team1);
        if (sgn === 0) continue;
        const [r, i] = resid(x);
        g += sgn * r;
        hh += i;
      }
      h += (g - h / o.vTeam1) / (hh + 1 / o.vTeam1);
    }
    {
      const g: Record<string, number> = {};
      const hh: Record<string, number> = {};
      for (const x of obs) {
        const [r, i] = resid(x);
        const a = `c${x.ctTeam}|${x.map}`;
        const b = `t${x.tTeam}|${x.map}`;
        g[a] = (g[a] ?? 0) + r;
        hh[a] = (hh[a] ?? 0) + i;
        g[b] = (g[b] ?? 0) - r;
        hh[b] = (hh[b] ?? 0) + i;
      }
      for (const k of Object.keys(g)) step(k[0] === "c" ? dc : dt, k.slice(1), g[k], hh[k], o.vMap);
    }
    {
      const g: Record<string, number> = {};
      const hh: Record<string, number> = {};
      for (const x of obs) {
        const nc = x.ctLineup?.length ?? 0;
        const nt = x.tLineup?.length ?? 0;
        if (nc === 0 && nt === 0) continue;
        const [r, i] = resid(x);
        for (const q of x.ctLineup ?? []) {
          g[`c${q}`] = (g[`c${q}`] ?? 0) + r / nc;
          hh[`c${q}`] = (hh[`c${q}`] ?? 0) + i / (nc * nc);
        }
        for (const q of x.tLineup ?? []) {
          g[`t${q}`] = (g[`t${q}`] ?? 0) - r / nt;
          hh[`t${q}`] = (hh[`t${q}`] ?? 0) + i / (nt * nt);
        }
      }
      for (const k of Object.keys(g)) step(k[0] === "c" ? pc : pt, Number(k.slice(1)), g[k], hh[k], o.vPlayer);
    }
    {
      const g: Record<string, number> = {};
      const hh: Record<string, number> = {};
      for (const x of obs) {
        const [r, i] = resid(x);
        g[`c${x.ctTeam}`] = (g[`c${x.ctTeam}`] ?? 0) + r;
        hh[`c${x.ctTeam}`] = (hh[`c${x.ctTeam}`] ?? 0) + i;
        g[`t${x.tTeam}`] = (g[`t${x.tTeam}`] ?? 0) - r;
        hh[`t${x.tTeam}`] = (hh[`t${x.tTeam}`] ?? 0) + i;
      }
      for (const k of Object.keys(g)) step(k[0] === "c" ? tc : tt, Number(k.slice(1)), g[k], hh[k], o.vTeam);
    }
  }

  const ct: Record<string, number> = {};
  const t: Record<string, number> = {};
  for (const [k, v] of Object.entries(dc)) ct[k] = v + tc[Number(k.split("|")[0])];
  for (const [k, v] of Object.entries(dt)) t[k] = v + tt[Number(k.split("|")[0])];
  for (const [team, v] of Object.entries(tc)) ct[`${team}|*`] = v;
  for (const [team, v] of Object.entries(tt)) t[`${team}|*`] = v;
  const lineups = Object.fromEntries(Object.entries(latest).map(([team, v]) => [team, v.lineup]));
  return { mapBias, ct, t, pc, pt, team1Bias: h, lineups };
}

/** +1 om CT-laget är lag 1, −1 om T-laget är det, 0 om okänt. */
function team1Sign(ctTeam: number, tTeam: number, team1: number | undefined): number {
  if (team1 == null) return 0;
  return ctTeam === team1 ? 1 : tTeam === team1 ? -1 : 0;
}

function ability(store: Record<string, number>, team: number, map: string): number {
  return store[`${team}|${map}`] ?? store[`${team}|*`] ?? 0;
}

/**
 * P(CT-laget vinner en köprunda mot T-laget på kartan). `team1` = HLTV:s
 * lag 1 i matchen, för lag 1-fördelen (utelämnad = ingen fördel). `spread`
 * skalar lagskillnaden (se matchSpread); kartans CT-fördel och lag 1-fördelen
 * påverkas inte.
 */
export function roundWinProb(
  model: RatingModel,
  map: string,
  ctTeam: number,
  tTeam: number,
  team1?: number,
  spread = 1,
  /** Spelarläge: femmorna per lag-id. Utelämnat = lagets senaste femma. */
  lineups?: Record<number, number[]>
): number {
  const players =
    model.playerCt && model.playerT
      ? lineupMean(model.playerCt, lineups?.[ctTeam] ?? model.lineups?.[ctTeam]) -
        lineupMean(model.playerT, lineups?.[tTeam] ?? model.lineups?.[tTeam])
      : 0;
  return sigmoid(
    (model.mapBias[map] ?? 0) +
      spread * (ability(model.ct, ctTeam, map) - ability(model.t, tTeam, map) + players) +
      (model.team1Bias ?? 0) * team1Sign(ctTeam, tTeam, team1)
  );
}

/** P(CT-laget vinner pistolrundan). */
export function pistolWinProb(model: RatingModel, ctTeam: number, tTeam: number): number {
  return sigmoid(model.pistolBias + (model.pistol[ctTeam] ?? 0) - (model.pistol[tTeam] ?? 0));
}

/** Rundor bakom lagets värde på kartan (båda sidor). */
export function ratingSample(model: RatingModel, team: number, map: string): number {
  return model.rounds[`${team}|${map}`] ?? 0;
}
