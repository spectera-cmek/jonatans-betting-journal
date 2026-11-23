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
