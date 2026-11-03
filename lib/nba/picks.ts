// Picks i poäng: modellens linje mot marknadens, som "Model line −7,2 mot
// Vegas −6,5 → pick −6,5 (0,7)". Används av den låsta live-picken och av
// backtesten, så att båda räknar likadant.

export type PickMarket = "spread" | "total";
export type PickResult = "W" | "L" | "P";

/** Edge-hinkar i poäng som facit delas upp i. */
export const EDGE_BUCKETS = [0, 3, 6] as const;

/** Break-even vid odds 1,91 (−110). */
export const BREAK_EVEN_110 = 1 / 1.909;

/**
 * Modellens linje. Spread: hemmalagets handicap (−7,2 = hemma vinner med 7,2).
 * Total: förväntad total.
 */
export function modelLine(market: PickMarket, homeMean: number, awayMean: number): number {
  const x = market === "spread" ? awayMean - homeMean : homeMean + awayMean;
  return Math.round(x * 10) / 10;
}

/** Sida och edge i poäng. Sida 1 = hemma/över. */
export function pickFromLine(market: PickMarket, model: number, line: number): { side: 1 | 2; edgePts: number } {
  const edgePts = Math.round(Math.abs(model - line) * 10) / 10;
  // Spread: lägre (mer negativ) modellinje = hemma starkare än marknaden tror.
  const side: 1 | 2 = market === "spread" ? (model < line ? 1 : 2) : model > line ? 1 : 2;
  return { side, edgePts };
}

export function gradePick(market: PickMarket, side: 1 | 2, line: number, homeScore: number, awayScore: number): PickResult {
  const x = market === "spread" ? homeScore - awayScore + line : homeScore + awayScore - line;
  if (x === 0) return "P";
  const side1Won = x > 0;
  return side1Won === (side === 1) ? "W" : "L";
}

/**
 * Closing line value i poäng: hur mycket bättre siffran vi låste var än
 * stängningen. Positivt = marknaden rörde sig mot oss.
 */
export function clvPoints(market: PickMarket, side: 1 | 2, locked: number, closing: number): number {
  const d = market === "spread" ? (side === 1 ? locked - closing : closing - locked) : side === 1 ? closing - locked : locked - closing;
  return Math.round(d * 10) / 10;
}

export interface GradedPick {
  edgePts: number;
  /** 1 = hemma/över, 2 = borta/under. */
  side?: 1 | 2;
  result: PickResult;
  /** Priset på vår sida, för ROI. Saknas det räknas −110. */
  price?: number | null;
  clv?: number | null;
  /** CLV för en slumpad sida på samma linjer (snittet av sida 1 och 2 på bästa linjen) — jämförelse för `clv`. */
  base?: number | null;
}

export interface BucketRecord {
  minEdge: number;
  w: number;
  l: number;
  p: number;
  /** Träffprocent utan pushar. */
  hit: number | null;
  /** Vinst per satsad enhet. */
  roi: number | null;
  /** Snitt-CLV i poäng. */
  clv: number | null;
  /** Andel picks där linjen rörde sig mot oss (CLV > 0) bland de som rörde sig. */
  clvBeat: number | null;
}

export function bucketRecords(picks: GradedPick[]): BucketRecord[] {
  return EDGE_BUCKETS.map((minEdge) => {
    const l = picks.filter((x) => x.edgePts >= minEdge);
    let w = 0;
    let lo = 0;
    let pu = 0;
    let profit = 0;
    let clvSum = 0;
    let clvN = 0;
    let beat = 0;
    let moved = 0;
    for (const x of l) {
      const price = x.price && x.price > 1 ? x.price : 1.909;
      if (x.result === "W") {
        w++;
        profit += price - 1;
      } else if (x.result === "L") {
        lo++;
        profit -= 1;
      } else pu++;
      if (x.clv != null) {
        clvSum += x.clv;
        clvN++;
        if (x.clv !== 0) {
          moved++;
          if (x.clv > 0) beat++;
        }
      }
    }
    return {
      minEdge,
      w,
      l: lo,
      p: pu,
      hit: w + lo ? w / (w + lo) : null,
      roi: l.length ? profit / l.length : null,
      clv: clvN ? clvSum / clvN : null,
      clvBeat: moved ? beat / moved : null,
    };
  });
}

export interface ClvSide {
  n: number;
  clv: number | null;
  beat: number | null;
}

/** CLV för en grupp picks: snitt och andel som slog stängningen bland de som rörde sig. */
function clvSide(xs: number[]): ClvSide {
  const moved = xs.filter((x) => x !== 0);
  return {
    n: xs.length,
    clv: xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null,
    beat: moved.length ? moved.filter((x) => x > 0).length / moved.length : null,
  };
}

export interface ClvCheck {
  /** Modellens picks, per sida. */
  side1: ClvSide;
  side2: ClvSide;
  /** Att alltid spela sida 1 (hemma/över) — visar om linjen bara driver åt ett håll. */
  always1: ClvSide;
  /** CLV för en slumpad sida på samma linjer: vad linjeshopping och drift ger utan modell. */
  base: number | null;
  /** Modellens CLV utöver `base`, i poäng. Det här är modellens bidrag. */
  skill: number | null;
  /** `skill` delat med sitt medelfel. Över 2 är svårt att få av slump. */
  t: number | null;
}

/**
 * Är CLV:n skicklighet, eller bara drift och linjeshopping? Om linjerna i snitt
 * stiger och modellen mest spelar över, eller om bästa linjen bland flera bolag
 * väljs, blir CLV:n positiv utan att modellen vet något. Därför jämförs varje
 * pick med en slumpad sida på samma linjer (`base`).
 */
export function clvCheck(picks: GradedPick[], always1: number[]): ClvCheck {
  const withClv = picks.filter((x) => x.clv != null);
  const with1 = withClv.filter((x) => x.side === 1).map((x) => x.clv!);
  const with2 = withClv.filter((x) => x.side === 2).map((x) => x.clv!);
  const paired = withClv.filter((x) => x.base != null);
  const diffs = paired.map((x) => x.clv! - x.base!);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  const skill = mean(diffs);
  let t: number | null = null;
  if (diffs.length > 2 && skill != null) {
    const sd = Math.sqrt(diffs.reduce((a, x) => a + (x - skill) ** 2, 0) / (diffs.length - 1));
    t = sd > 0 ? skill / (sd / Math.sqrt(diffs.length)) : null;
  }
  return { side1: clvSide(with1), side2: clvSide(with2), always1: clvSide(always1), base: mean(paired.map((x) => x.base!)), skill, t };
}
