// Monte Carlo-simulering av en NBA-match, possession för possession.
//
// Varje lag beskrivs av en offensiv profil (andel turnovers, straffsituationer,
// 3PA och 2PA per "play", träffprocent och OREB%) som byggts ihop av
// spelarnas takter viktade med minuterna och justerats mot motståndarens
// försvar. En possession är en eller flera plays: en miss kan ge offensiv
// retur och ett nytt försök. Oavgjort efter 48 minuter → förlängning.
//
// Slumpen är seedad (mulberry32), så samma indata ger samma svar.

import type { OffenseProfile } from "./ratings";

export interface TeamSimInput extends OffenseProfile {
  /** Logit-tillägg på 2P% och 3P% (hemmaplan, back-to-back). */
  shotLogit: number;
}

export interface GameSimInput {
  home: TeamSimInput;
  away: TeamSimInput;
  /** Förväntade possessions per lag på 48 minuter. */
  possMean: number;
  possSd: number;
  /** Lagets egen dagsform, σ på träff-logit. */
  nightSigma: number;
  /** Matchens gemensamma dagsform för båda lagen. */
  sharedSigma?: number;
  /** Logit per 10 poängs ledning som laget i ledning tappar. */
  rubberBand?: number;
  ftsPerTrip: number;
  sims: number;
  seed?: number;
}

export interface SimResult {
  home: Int16Array;
  away: Int16Array;
  /** Antal matcher som gick till förlängning. */
  overtimes: number;
  sims: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface Prepared {
  cTov: number;
  cFt: number;
  c3: number;
  l2: number;
  l3: number;
  ft: number;
  oreb: number;
}

export function prepare(t: TeamSimInput): Prepared {
  const sum = t.pTov + t.pFt + t.p3 + t.p2 || 1;
  const cTov = t.pTov / sum;
  const cFt = cTov + t.pFt / sum;
  const c3 = cFt + t.p3 / sum;
  return {
    cTov,
    cFt,
    c3,
    l2: logit(clamp(t.pct2)) + t.shotLogit,
    l3: logit(clamp(t.pct3)) + t.shotLogit,
    ft: clamp(t.ftPct),
    oreb: clamp(t.orebPct),
  };
}

const clamp = (p: number) => Math.min(0.99, Math.max(0.01, p));

/** Poäng på en possession; offensiv retur ger en ny play i samma possession. */
function possession(t: Prepared, pct2: number, pct3: number, pThree: number, rand: () => number): number {
  for (let guard = 0; guard < 8; guard++) {
    const r = rand();
    if (r < t.cTov) return 0;
    if (r < t.cFt) {
      const shots = rand() < pThree ? 3 : 2;
      let pts = 0;
      for (let s = 0; s < shots; s++) if (rand() < t.ft) pts++;
      return pts;
    }
    if (r < t.c3) {
      if (rand() < pct3) return 3;
    } else if (rand() < pct2) return 2;
    if (rand() >= t.oreb) return 0;
  }
  return 0;
}

/** Förväntade poäng per possession, inklusive offensiva returer. */
export function expectedPpp(t: Prepared, pct2: number, pct3: number, ftsPerTrip: number): number {
  const pFt = t.cFt - t.cTov;
  const p3 = t.c3 - t.cFt;
  const p2 = 1 - t.c3;
  const direct = pFt * ftsPerTrip * t.ft + p3 * 3 * pct3 + p2 * 2 * pct2;
  const again = t.oreb * (p3 * (1 - pct3) + p2 * (1 - pct2));
  return direct / Math.max(0.05, 1 - again);
}

/**
 * Spelar `n` possessions var för lagen, omväxlande. Matchbilden påverkar:
 * laget som leder mer än väntat tappar lite effektivitet och laget som ligger
 * efter hämtar in (avslappning, garbage time, fouling) — rubberBand logit per
 * 10 poängs avvikelse från förväntad ledning. Avvikelsen mäts mot den
 * förväntade ledningen, så favoritens förväntade marginal ändras inte; bara
 * spridningen krymper, som den gör i riktiga NBA-matcher.
 */
function playPeriod(
  n: number,
  H: Prepared,
  A: Prepared,
  sh: number,
  sa: number,
  start: [number, number],
  rb: number,
  pThree: number,
  ftsPerTrip: number,
  rand: () => number
): [number, number] {
  let hp = start[0];
  let ap = start[1];
  const h2 = H.l2 + sh;
  const h3 = H.l3 + sh;
  const a2 = A.l2 + sa;
  const a3 = A.l3 + sa;
  const drift = rb ? expectedPpp(H, sigmoid(h2), sigmoid(h3), ftsPerTrip) - expectedPpp(A, sigmoid(a2), sigmoid(a3), ftsPerTrip) : 0;
  const lead0 = hp - ap;
  for (let i = 0; i < n; i++) {
    if (rb) {
      const dev = Math.max(-25, Math.min(25, hp - ap - lead0 - drift * i));
      const adj = (rb * dev) / 10;
      hp += possession(H, sigmoid(h2 - adj), sigmoid(h3 - adj), pThree, rand);
      ap += possession(A, sigmoid(a2 + adj), sigmoid(a3 + adj), pThree, rand);
    } else {
      hp += possession(H, sigmoid(h2), sigmoid(h3), pThree, rand);
      ap += possession(A, sigmoid(a2), sigmoid(a3), pThree, rand);
    }
  }
  return [hp, ap];
}

export function simulateGame(input: GameSimInput): SimResult {
  const rand = mulberry32(input.seed ?? 12345);
  const H = prepare(input.home);
  const A = prepare(input.away);
  // Straffsituation med 2 eller 3 skott så att snittet blir ftsPerTrip.
  const pThree = Math.min(1, Math.max(0, input.ftsPerTrip - 2));
  const rb = input.rubberBand ?? 0;
  const n = input.sims;
  const home = new Int16Array(n);
  const away = new Int16Array(n);
  let overtimes = 0;
  const otMean = (input.possMean * 5) / 48;
  for (let s = 0; s < n; s++) {
    // Dagsform: egen för varje lag plus en gemensam för matchen (domare, tempo, skytte).
    const shared = input.sharedSigma ? normal(rand) * input.sharedSigma : 0;
    const eh = shared + (input.nightSigma ? normal(rand) * input.nightSigma : 0);
    const ea = shared + (input.nightSigma ? normal(rand) * input.nightSigma : 0);
    // Lagen turas om att ha bollen, så båda får lika många possessions.
    const poss = Math.max(70, Math.round(input.possMean + normal(rand) * input.possSd));
    let [hp, ap] = playPeriod(poss, H, A, eh, ea, [0, 0], rb, pThree, input.ftsPerTrip, rand);
    let ot = 0;
    while (hp === ap && ot < 6) {
      ot++;
      const op = Math.max(6, Math.round(otMean + normal(rand) * 1.2));
      [hp, ap] = playPeriod(op, H, A, eh, ea, [hp, ap], rb, pThree, input.ftsPerTrip, rand);
    }
    if (hp === ap) hp += rand() < 0.5 ? 1 : -1;
    if (ot) overtimes++;
    home[s] = hp;
    away[s] = ap;
  }
  return { home, away, overtimes, sims: n };
}

export interface SimSummary {
  homeMean: number;
  awayMean: number;
  marginMean: number;
  totalMean: number;
  marginSd: number;
  totalSd: number;
  pHomeWin: number;
  otRate: number;
}

export function summarize(r: SimResult): SimSummary {
  const n = r.sims;
  let sh = 0;
  let sa = 0;
  let sm = 0;
  let smm = 0;
  let st = 0;
  let stt = 0;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const h = r.home[i];
    const a = r.away[i];
    sh += h;
    sa += a;
    const m = h - a;
    const t = h + a;
    sm += m;
    smm += m * m;
    st += t;
    stt += t * t;
    if (m > 0) wins++;
  }
  const mm = sm / n;
  const tm = st / n;
  return {
    homeMean: sh / n,
    awayMean: sa / n,
    marginMean: mm,
    totalMean: tm,
    marginSd: Math.sqrt(Math.max(0, smm / n - mm * mm)),
    totalSd: Math.sqrt(Math.max(0, stt / n - tm * tm)),
    pHomeWin: wins / n,
    otRate: r.overtimes / n,
  };
}

/** P(hemma täcker linjen) betingat på ingen push, och P(push). line = hemmalagets handicap. */
export function spreadProb(r: SimResult, line: number): { p: number; push: number } {
  let cover = 0;
  let push = 0;
  for (let i = 0; i < r.sims; i++) {
    const x = r.home[i] - r.away[i] + line;
    if (x > 0) cover++;
    else if (x === 0) push++;
  }
  const live = r.sims - push;
  return { p: live ? cover / live : 0.5, push: push / r.sims };
}

/** P(över) betingat på ingen push, och P(push). */
export function totalProb(r: SimResult, line: number): { p: number; push: number } {
  let over = 0;
  let push = 0;
  for (let i = 0; i < r.sims; i++) {
    const t = r.home[i] + r.away[i];
    if (t > line) over++;
    else if (t === line) push++;
  }
  const live = r.sims - push;
  return { p: live ? over / live : 0.5, push: push / r.sims };
}

export function moneylineProb(r: SimResult): number {
  let w = 0;
  for (let i = 0; i < r.sims; i++) if (r.home[i] > r.away[i]) w++;
  return w / r.sims;
}
