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
}

/** Standard, valda med walk-forward-backtest på HLTV-data (se backtest.ts). */
export const DEFAULT_ROUND_DISPERSION = 4;
export const DEFAULT_TAU_TEAM1 = 0.2;

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
  w: number
): SideObs[] {
  const { team1CtRounds: a, team1TRounds: b, team2CtRounds: c, team2TRounds: d } = m;
  if (a == null || b == null || c == null || d == null) return [];
  const out: SideObs[] = [];
  const team1 = m.team1Id;
  if (a + d > 0) out.push({ map: m.mapName, ctTeam: m.team1Id, tTeam: m.team2Id, ctWins: a, rounds: a + d, w, team1 });
  if (c + b > 0) out.push({ map: m.mapName, ctTeam: m.team2Id, tTeam: m.team1Id, ctWins: c, rounds: c + b, w, team1 });
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
 * lag 1 i matchen, för lag 1-fördelen (utelämnad = ingen fördel).
 */
export function roundWinProb(model: RatingModel, map: string, ctTeam: number, tTeam: number, team1?: number): number {
  return sigmoid(
    (model.mapBias[map] ?? 0) +
      ability(model.ct, ctTeam, map) -
      ability(model.t, tTeam, map) +
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
