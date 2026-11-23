// Pick'em för en Majors Swiss-etapp: formatregler, parning, simulering,
// poängräkning och optimerare.
//
// Ren logik, ingen databas och ingen nätverkstrafik — den delen bor i
// scripts/cs2/pickem-*.ts. Allt här är testbart utan omvärld.
//
// Se docs/superpowers/specs/2026-11-24-cs2-major-pickem-simulator-design.md.

/** Ett lags slutfacit i Swiss-etappen. */
export type Outcome =
  /** 3 vinster, 0 förluster. */
  | "3-0"
  /** Avancerade med 1–2 förluster. */
  | "adv"
  /** 0 vinster, 3 förluster. */
  | "0-3"
  /** Utslagen på 1-3 eller 2-3. */
  | "out";

/**
 * Är matchen bo3?
 *
 * Valves regel: bo1 överallt utom när avancering eller elimination står på
 * spel. Ett lag på 2 vinster kan avancera med en seger, ett lag på 2 förluster
 * kan slås ut med en förlust — båda ger bo3. `Cs2Match.format` kan inte
 * användas för detta; HLTV-skrapet sätter ett standardvärde.
 */
export function isBo3(wins: number, losses: number): boolean {
  return wins === 2 || losses === 2;
}

/** Ett lag i Swiss-etappen. Seed skiljer lika buchholz vid parning. */
export interface SwissTeam {
  id: number;
  seed: number;
}

/** Nyckel för ett spelat möte, oberoende av vem som stod först. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Buchholz: summan av motståndarnas (vinster − förluster). Måttet som skiljer
 * lag med samma facit i Swiss-parningen — har du mött tyngre motstånd möter du
 * lättare nästa gång.
 */
export function buchholz(record: Map<number, { w: number; l: number }>, opponents: number[]): number {
  let sum = 0;
  for (const id of opponents) {
    const r = record.get(id);
    if (r) sum += r.w - r.l;
  }
  return sum;
}

/**
 * Parar en facitgrupp: sortera på buchholz fallande, därefter seed stigande,
 * och ställ högsta mot lägsta (1 mot n, 2 mot n−1, …).
 *
 * Vid omatch byts motståndaren mot ett annat pars motståndare. Går ingen
 * bytessekvens hem behålls den ursprungliga parningen — en omatch är bättre än
 * ett undantag mitt i 200 000 simuleringar.
 */
export function pairGroup(
  group: Array<{ id: number; buchholz: number; seed: number }>,
  played: Set<string>
): Array<[number, number]> {
  const sorted = [...group].sort((a, b) => b.buchholz - a.buchholz || a.seed - b.seed);
  const half = Math.floor(sorted.length / 2);
  const top = sorted.slice(0, half).map((t) => t.id);
  // Lägsta möter högsta: andra halvan baklänges.
  const bottom = sorted.slice(half).reverse().map((t) => t.id);

  for (let i = 0; i < top.length; i++) {
    if (!played.has(pairKey(top[i], bottom[i]))) continue;
    // Leta ett byte som löser både det här paret och det man byter med.
    for (let j = 0; j < bottom.length; j++) {
      if (j === i) continue;
      if (played.has(pairKey(top[i], bottom[j]))) continue;
      if (played.has(pairKey(top[j], bottom[i]))) continue;
      [bottom[i], bottom[j]] = [bottom[j], bottom[i]];
      break;
    }
  }

  return top.map((id, i) => [id, bottom[i]] as [number, number]);
}

/**
 * Simulerar en hel Swiss-etapp: 16 lag, fem ronder, topp 8 avancerar.
 *
 * Rond 1 använder den kända lottningen och är alltid bo1. Rond 2–5 grupperar
 * de lag som varken nått 3 vinster eller 3 förluster på facit, parar varje
 * grupp med buchholz och seed, och väljer format ur `isBo3`.
 *
 * `pWin(a, b, format)` är P(a vinner serien). `rng` ska ge [0, 1).
 */
export function simulateSwiss(
  teams: SwissTeam[],
  round1: Array<[number, number]>,
  pWin: (a: number, b: number, format: "bo1" | "bo3") => number,
  rng: () => number
): Map<number, Outcome> {
  const record = new Map<number, { w: number; l: number }>();
  const opponents = new Map<number, number[]>();
  for (const t of teams) {
    record.set(t.id, { w: 0, l: 0 });
    opponents.set(t.id, []);
  }
  const played = new Set<string>();

  const play = (a: number, b: number, format: "bo1" | "bo3") => {
    const aWon = rng() < pWin(a, b, format);
    const ra = record.get(a)!;
    const rb = record.get(b)!;
    if (aWon) {
      ra.w++;
      rb.l++;
    } else {
      ra.l++;
      rb.w++;
    }
    opponents.get(a)!.push(b);
    opponents.get(b)!.push(a);
    played.add(pairKey(a, b));
  };

  for (const [a, b] of round1) play(a, b, "bo1");

  for (let round = 2; round <= 5; round++) {
    // Grupperna snapshottas före rondens matcher, så buchholz speglar läget
    // vid parningen och inte halvspelade ronder.
    const groups = new Map<string, Array<{ id: number; buchholz: number; seed: number }>>();
    for (const t of teams) {
      const r = record.get(t.id)!;
      if (r.w >= 3 || r.l >= 3) continue;
      const key = `${r.w}-${r.l}`;
      const group = groups.get(key) ?? [];
      group.push({ id: t.id, buchholz: buchholz(record, opponents.get(t.id)!), seed: t.seed });
      groups.set(key, group);
    }
    if (groups.size === 0) break;
    for (const [key, group] of groups) {
      const [w, l] = key.split("-").map(Number);
      const format = isBo3(w, l) ? "bo3" : "bo1";
      for (const [a, b] of pairGroup(group, played)) play(a, b, format);
    }
  }

  const out = new Map<number, Outcome>();
  for (const t of teams) {
    const r = record.get(t.id)!;
    out.set(
      t.id,
      r.w === 3 && r.l === 0 ? "3-0" : r.w === 3 ? "adv" : r.l === 3 && r.w === 0 ? "0-3" : "out"
    );
  }
  return out;
}

/**
 * De tio valen i en Swiss-etapp: 2 lag på 3-0, 6 lag som avancerar på 3-1
 * eller 3-2, och 2 lag på 0-3.
 */
export interface PickSet {
  threeZero: number[];
  advance: number[];
  zeroThree: number[];
}

/**
 * Antal rätt i en uppsättning val mot ett facit.
 *
 * Slotten är strikta: ett lag lagt på 3-0 som går 3-1 är fel, och ett 3-0-lag
 * räknas aldrig som ett avancerings-val. Valve säger inte uttryckligen vad som
 * gäller för det senare; det här är den strikta tolkningen.
 */
export function scorePicks(picks: PickSet, outcomes: Map<number, Outcome>): number {
  let hits = 0;
  for (const id of picks.threeZero) if (outcomes.get(id) === "3-0") hits++;
  for (const id of picks.advance) if (outcomes.get(id) === "adv") hits++;
  for (const id of picks.zeroThree) if (outcomes.get(id) === "0-3") hits++;
  return hits;
}

/** Utfallskod i `OutcomeTable.codes`. */
const CODE: Record<Outcome, number> = { "3-0": 0, adv: 1, "0-3": 2, out: 3 };

/** Vilken kod varje slot vill se. */
const SLOT_CODE = { threeZero: 0, advance: 1, zeroThree: 2 } as const;

const SLOTS = ["threeZero", "advance", "zeroThree"] as const;

/**
 * Alla simuleringars utfall, både som marginaler per lag och som rå matris.
 *
 * `codes[sim * teams.length + i]` är lag `teams[i]`:s utfall i den
 * simuleringen. Matrisen behövs för att P(≥5 rätt) måste räknas över
 * simuleringarna — marginalerna kan inte svara på det, eftersom valen slår in
 * tillsammans.
 */
export interface OutcomeTable {
  teams: number[];
  p30: Map<number, number>;
  pAdv: Map<number, number>;
  p03: Map<number, number>;
  codes: Uint8Array;
  sims: number;
}

export function tally(sims: Array<Map<number, Outcome>>, teams: number[]): OutcomeTable {
  const n = sims.length;
  const t = teams.length;
  const codes = new Uint8Array(n * t);
  const c30 = new Array<number>(t).fill(0);
  const cAdv = new Array<number>(t).fill(0);
  const c03 = new Array<number>(t).fill(0);

  for (let s = 0; s < n; s++) {
    const sim = sims[s];
    for (let i = 0; i < t; i++) {
      const o = sim.get(teams[i]) ?? "out";
      const code = CODE[o];
      codes[s * t + i] = code;
      if (code === 0) c30[i]++;
      else if (code === 1) cAdv[i]++;
      else if (code === 2) c03[i]++;
    }
  }

  const p30 = new Map<number, number>();
  const pAdv = new Map<number, number>();
  const p03 = new Map<number, number>();
  for (let i = 0; i < t; i++) {
    p30.set(teams[i], n ? c30[i] / n : 0);
    pAdv.set(teams[i], n ? cAdv[i] / n : 0);
    p03.set(teams[i], n ? c03[i] / n : 0);
  }
  return { teams, p30, pAdv, p03, codes, sims: n };
}

/** Kolumnindex och önskad kod för varje val, platt och i typade vektorer. */
function flatten(table: OutcomeTable, picks: PickSet): { col: Int32Array; want: Uint8Array } {
  const index = new Map(table.teams.map((id, i) => [id, i]));
  const col: number[] = [];
  const want: number[] = [];
  for (const slot of SLOTS) {
    for (const id of picks[slot]) {
      const i = index.get(id);
      if (i == null) continue;
      col.push(i);
      want.push(SLOT_CODE[slot]);
    }
  }
  return { col: Int32Array.from(col), want: Uint8Array.from(want) };
}

/** P(minst `atLeast` av valen rätt), räknad över simuleringarna. */
export function pHitAtLeast(table: OutcomeTable, picks: PickSet, atLeast: number): number {
  const { col, want } = flatten(table, picks);
  const t = table.teams.length;
  const n = table.sims;
  if (!n) return 0;
  let hits = 0;
  for (let s = 0; s < n; s++) {
    const off = s * t;
    let right = 0;
    for (let k = 0; k < col.length; k++) if (table.codes[off + col[k]] === want[k]) right++;
    if (right >= atLeast) hits++;
  }
  return hits / n;
}

/** Förväntat antal rätt — summan av valens marginalsannolikheter. */
export function expectedHits(table: OutcomeTable, picks: PickSet): number {
  let sum = 0;
  for (const id of picks.threeZero) sum += table.p30.get(id) ?? 0;
  for (const id of picks.advance) sum += table.pAdv.get(id) ?? 0;
  for (const id of picks.zeroThree) sum += table.p03.get(id) ?? 0;
  return sum;
}

/** Topp 2 på P(3-0), topp 2 på P(0-3) bland återstående, topp 6 på P(3-1/3-2). */
export function greedyPicks(table: OutcomeTable): PickSet {
  const taken = new Set<number>();
  const pick = (n: number, p: Map<number, number>): number[] => {
    const out = table.teams
      .filter((id) => !taken.has(id))
      .sort((a, b) => (p.get(b) ?? 0) - (p.get(a) ?? 0))
      .slice(0, n);
    for (const id of out) taken.add(id);
    return out;
  };
  const threeZero = pick(2, table.p30);
  const zeroThree = pick(2, table.p03);
  const advance = pick(6, table.pAdv);
  return { threeZero, advance, zeroThree };
}

const clonePicks = (p: PickSet): PickSet => ({
  threeZero: [...p.threeZero],
  advance: [...p.advance],
  zeroThree: [...p.zeroThree],
});

/**
 * Valen som maximerar P(minst `atLeast` rätt).
 *
 * Tröskeln är poängen: Diamond-utmaningen kräver 5 av 10, och mot en tröskel
 * vill man ha val som slår in tillsammans — inte de tio var för sig bästa.
 * Därför optimeras P(≥n) och inte förväntat antal rätt.
 *
 * Brantaste klättring över två sorters drag: byt ett valt lag mot ett ovalt i
 * samma slot, eller byt plats på två valda lag i olika slots. Startar från det
 * giriga EV-valet plus tre slumpstarter.
 */
export function optimizePicks(
  table: OutcomeTable,
  atLeast: number,
  rng: () => number
): { picks: PickSet; pHit: number; expected: number } {
  const climb = (start: PickSet): { picks: PickSet; pHit: number } => {
    let cur = clonePicks(start);
    let curP = pHitAtLeast(table, cur, atLeast);
    for (;;) {
      let bestP = curP;
      let best: PickSet | null = null;
      const inUse = new Set([...cur.threeZero, ...cur.advance, ...cur.zeroThree]);
      const free = table.teams.filter((id) => !inUse.has(id));

      for (const slot of SLOTS) {
        for (let i = 0; i < cur[slot].length; i++) {
          for (const id of free) {
            const cand = clonePicks(cur);
            cand[slot][i] = id;
            const p = pHitAtLeast(table, cand, atLeast);
            if (p > bestP + 1e-12) {
              bestP = p;
              best = cand;
            }
          }
        }
      }

      for (let a = 0; a < SLOTS.length; a++) {
        for (let b = a + 1; b < SLOTS.length; b++) {
          for (let i = 0; i < cur[SLOTS[a]].length; i++) {
            for (let j = 0; j < cur[SLOTS[b]].length; j++) {
              const cand = clonePicks(cur);
              cand[SLOTS[a]][i] = cur[SLOTS[b]][j];
              cand[SLOTS[b]][j] = cur[SLOTS[a]][i];
              const p = pHitAtLeast(table, cand, atLeast);
              if (p > bestP + 1e-12) {
                bestP = p;
                best = cand;
              }
            }
          }
        }
      }

      if (!best) return { picks: cur, pHit: curP };
      cur = best;
      curP = bestP;
    }
  };

  let best = climb(greedyPicks(table));
  for (let restart = 0; restart < 3; restart++) {
    const shuffled = [...table.teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const got = climb({
      threeZero: shuffled.slice(0, 2),
      advance: shuffled.slice(2, 8),
      zeroThree: shuffled.slice(8, 10),
    });
    if (got.pHit > best.pHit) best = got;
  }
  return { picks: best.picks, pHit: best.pHit, expected: expectedHits(table, best.picks) };
}
