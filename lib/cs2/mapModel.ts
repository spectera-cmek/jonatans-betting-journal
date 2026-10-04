// En karta, runda för runda — exakt dynamisk programmering i stället för
// simulering, så att samma indata alltid ger samma tal och testerna kan
// kontrollera summor och symmetri exakt.
//
// Format (CS2): MR12, först till 13, sidbyte efter 12 rundor. Vid 12–12
// övertid i perioder om sex rundor (MR3): först till fyra i perioden, byte
// efter tre rundor, 3–3 ger en ny period. Lagen behåller andra halvlekens
// sida i första övertidshalvan.
//
// Rundorna är inte oberoende: runda 1 och 13 är pistolrundor, och laget som
// vinner pistolen vinner oftast även de två följande (ekonomin). Det fångas
// med två konverteringssannolikheter. Därutöver en kartvis formeffekt: ett
// lag som har en bra dag har det i alla rundor, vilket gör fördelningen av
// slutresultat bredare än oberoende rundor ger (Gauss–Hermite, 5 punkter).

import { logit } from "./ratings";

export interface MapInputs {
  /** P(A vinner en köprunda som CT). */
  pCtA: number;
  /** P(B vinner en köprunda som CT). */
  pCtB: number;
  /** P(A vinner pistolen som CT) och P(B vinner pistolen som CT). */
  pistolCtA: number;
  pistolCtB: number;
  conv2: number;
  conv3: number;
  /** P(A börjar som CT). */
  pAStartsCt: number;
  /** Kartvis formeffekt, standardavvikelse på logit-skala. */
  sigma?: number;
}

export interface MapOutcome {
  aReg: number;
  bReg: number;
  aOt: number;
  bOt: number;
  p: number;
}

export interface MapDistribution {
  outcomes: MapOutcome[];
  pAWin: number;
  pOt: number;
  expRounds: number;
  /** P(totala rundor = n), index = n. */
  roundsPmf: number[];
}

export const DEFAULT_SIGMA = 0.3;
const MAX_OT_PERIODS = 6;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const shift = (p: number, d: number) => (d === 0 ? p : sigmoid(logit(p) + d));

// Gauss–Hermite (fysikernas vikter), 5 punkter.
const GH_X = [-2.0201828705, -0.9585724646, 0, 0.9585724646, 2.0201828705];
const GH_W = [0.0199532421, 0.3936193232, 0.9453087205, 0.3936193232, 0.0199532421];

type Acc = Map<string, number>;
const add = (acc: Acc, key: string, p: number) => acc.set(key, (acc.get(key) ?? 0) + p);

/**
 * Ordinarie tid för fast startsida och fasta sannolikheter. Returnerar
 * slutställningar (13–x eller 12–12) med sannolikhet.
 */
function regulation(aStartsCt: boolean, pr: Required<Omit<MapInputs, "pAStartsCt" | "sigma">>, delta: number): Acc {
  // Tillstånd: a, b, s — s: 0 inget, 1/2 = A vann pistol/pistol+r2, 3/4 = B.
  let states: Acc = new Map([["0,0,0", 1]]);
  const finals: Acc = new Map();
  for (let r = 0; r < 24; r++) {
    const next: Acc = new Map();
    const half = r < 12 ? 0 : 1;
    const k = r % 12;
    const aCt = half === 0 ? aStartsCt : !aStartsCt;
    for (const [key, p] of states) {
      const [a, b, s] = key.split(",").map(Number);
      let pA: number;
      if (k === 0) pA = aCt ? pr.pistolCtA : 1 - pr.pistolCtB;
      else if (k === 1 && s === 1) pA = pr.conv2;
      else if (k === 1 && s === 3) pA = 1 - pr.conv2;
      else if (k === 2 && s === 2) pA = pr.conv3;
      else if (k === 2 && s === 4) pA = 1 - pr.conv3;
      else pA = aCt ? pr.pCtA : 1 - pr.pCtB;
      pA = shift(pA, delta);

      for (const [aw, pp] of [
        [true, pA],
        [false, 1 - pA],
      ] as const) {
        if (pp <= 0) continue;
        const na = a + (aw ? 1 : 0);
        const nb = b + (aw ? 0 : 1);
        let ns = 0;
        if (k === 0) ns = aw ? 1 : 3;
        else if (k === 1 && s === 1 && aw) ns = 2;
        else if (k === 1 && s === 3 && !aw) ns = 4;
        const prob = p * pp;
        if (na === 13 || nb === 13) add(finals, `${na},${nb}`, prob);
        else if (na === 12 && nb === 12) add(finals, "12,12", prob);
        else add(next, `${na},${nb},${ns}`, prob);
      }
    }
    states = next;
  }
  return finals;
}

/** En övertidsperiod: fördelning av (a, b) i perioden, inklusive 3–3. */
function otPeriod(aCtFirst: boolean, pCtA: number, pCtB: number, delta: number): Acc {
  let states: Acc = new Map([["0,0", 1]]);
  const finals: Acc = new Map();
  for (let r = 0; r < 6; r++) {
    const aCt = r < 3 ? aCtFirst : !aCtFirst;
    const pA = shift(aCt ? pCtA : 1 - pCtB, delta);
    const next: Acc = new Map();
    for (const [key, p] of states) {
      const [a, b] = key.split(",").map(Number);
      for (const [aw, pp] of [
        [true, pA],
        [false, 1 - pA],
      ] as const) {
        const na = a + (aw ? 1 : 0);
        const nb = b + (aw ? 0 : 1);
        const prob = p * pp;
        if (na === 4 || nb === 4 || (na === 3 && nb === 3)) add(finals, `${na},${nb}`, prob);
        else add(next, `${na},${nb}`, prob);
      }
    }
    states = next;
  }
  return finals;
}

function singleRun(inp: MapInputs, aStartsCt: boolean, delta: number, out: Acc, weight: number) {
  const pr = { pCtA: inp.pCtA, pCtB: inp.pCtB, pistolCtA: inp.pistolCtA, pistolCtB: inp.pistolCtB, conv2: inp.conv2, conv3: inp.conv3 };
  const reg = regulation(aStartsCt, pr, delta);
  // Andra halvlekens sida behålls i första övertidshalvan.
  const aCtInSecondHalf = !aStartsCt;
  const period = otPeriod(aCtInSecondHalf, inp.pCtA, inp.pCtB, delta);
  const tie = period.get("3,3") ?? 0;
  for (const [key, p] of reg) {
    const [a, b] = key.split(",").map(Number);
    if (!(a === 12 && b === 12)) {
      add(out, `${a},${b},0,0`, p * weight);
      continue;
    }
    // Övertid: k perioder med 3–3 före den avgörande.
    let carry = p * weight;
    for (let k = 0; k < MAX_OT_PERIODS && carry > 1e-12; k++) {
      for (const [pk, pp] of period) {
        if (pk === "3,3") continue;
        const [oa, ob] = pk.split(",").map(Number);
        add(out, `12,12,${oa + 3 * k},${ob + 3 * k}`, carry * pp);
      }
      carry *= tie;
    }
    // Sista resten (osannolikt lång övertid) fördelas lika.
    if (carry > 0) {
      const k = MAX_OT_PERIODS;
      add(out, `12,12,${4 + 3 * k},${3 + 3 * k}`, carry / 2);
      add(out, `12,12,${3 + 3 * k},${4 + 3 * k}`, carry / 2);
    }
  }
}

export function mapDistribution(inp: MapInputs): MapDistribution {
  const sigma = inp.sigma ?? DEFAULT_SIGMA;
  const acc: Acc = new Map();
  const starts: Array<[boolean, number]> = [
    [true, inp.pAStartsCt],
    [false, 1 - inp.pAStartsCt],
  ];
  const nodes = sigma > 0 ? GH_X.map((x, i) => [Math.SQRT2 * sigma * x, GH_W[i] / Math.sqrt(Math.PI)] as const) : [[0, 1] as const];
  for (const [start, ps] of starts) {
    if (ps <= 0) continue;
    for (const [delta, wn] of nodes) singleRun(inp, start, delta, acc, ps * wn);
  }

  const outcomes: MapOutcome[] = [];
  let pAWin = 0,
    pOt = 0,
    exp = 0,
    total = 0;
  const roundsPmf: number[] = [];
  for (const [key, p] of acc) {
    const [aReg, bReg, aOt, bOt] = key.split(",").map(Number);
    outcomes.push({ aReg, bReg, aOt, bOt, p });
    total += p;
    const n = aReg + bReg + aOt + bOt;
    roundsPmf[n] = (roundsPmf[n] ?? 0) + p;
    exp += n * p;
    if (aReg + aOt > bReg + bOt) pAWin += p;
    if (aOt + bOt > 0) pOt += p;
  }
  for (let i = 0; i < roundsPmf.length; i++) roundsPmf[i] = (roundsPmf[i] ?? 0) / total;
  return {
    outcomes: outcomes.map((o) => ({ ...o, p: o.p / total })),
    pAWin: pAWin / total,
    pOt: pOt / total,
    expRounds: exp / total,
    roundsPmf,
  };
}

/** Samma karta ur B:s perspektiv. */
export function flipDistribution(d: MapDistribution): MapDistribution {
  return {
    outcomes: d.outcomes.map((o) => ({ aReg: o.bReg, bReg: o.aReg, aOt: o.bOt, bOt: o.aOt, p: o.p })),
    pAWin: 1 - d.pAWin,
    pOt: d.pOt,
    expRounds: d.expRounds,
    roundsPmf: d.roundsPmf,
  };
}

/** P(A:s rundmarginal + handikapp > 0), med push på heltal. */
export function handicapProbs(d: MapDistribution, aLine: number, includeOt = true): { pCover: number; pPush: number } {
  let pCover = 0,
    pPush = 0;
  for (const o of d.outcomes) {
    const margin = o.aReg - o.bReg + (includeOt ? o.aOt - o.bOt : 0);
    const v = margin + aLine;
    if (Math.abs(v) < 1e-9) pPush += o.p;
    else if (v > 0) pCover += o.p;
  }
  return { pCover, pPush };
}

/** Rundor som pmf, med eller utan övertid. */
export function roundsPmf(d: MapDistribution, includeOt: boolean): number[] {
  if (includeOt) return d.roundsPmf;
  const out: number[] = new Array(25).fill(0);
  for (const o of d.outcomes) out[o.aReg + o.bReg] += o.p;
  return out;
}
