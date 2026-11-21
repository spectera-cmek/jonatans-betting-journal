/**
 * Håller disciplinvaktens regler på spel som kom EFTER att de togs fram?
 * Läser bara — skriver ingenting till databasen, och ändrar inte vakten.
 *
 *   npm run discipline:holdout
 *   npm run discipline:holdout -- --cutoffs 2026-03-21,2026-05-21 --iter 400 --seed 7
 *   npm run discipline:holdout -- --variants P1,V2   # bara vissa regelvarianter
 *   npm run discipline:holdout -- --detail            # varje regel, före och efter
 *   npm run discipline:holdout -- --json out.json     # allt som JSON
 *   npm run discipline:holdout -- --keep-placeholders # behåll odds 1,01 som produktionen
 *
 * För varje brytpunkt T tas en regeluppsättning fram per variant, bara ur spel
 * före T och med `deriveDisciplineRules` och dess standardvärden (365 d,
 * minSettled 40, maxShare 0,35, minRelZ 2) där inget annat sägs. Alla varianter
 * slår på `leaks: true`: sedan 2026-11-21 tar vakten inte fram minusregler alls
 * (den här mätningen är skälet), men skriptet ska kunna se om de börjar hålla.
 *   P1  vakten fram till 2026-11-21: minAbsZ 1, `now = T`.
 *   P2  som P1 men minAbsZ 2.
 *   V1  P1:s regler, men bara de som pekar åt samma håll i BÅDA halvåren av
 *       fönstret var för sig (minst 20 avgjorda i varje halvår).
 *   V2  kontroll på data regeln inte valdes ur: reglerna tas fram på det äldre
 *       halvåret (T − 365 d till T − 182 d, `sinceDays` 183) och behålls bara om
 *       det nyare halvåret (T − 182 d till T) bekräftar dem med z ≥ 1 åt regelns
 *       håll (minst 20 avgjorda).
 *   V2S som V2, men det räcker att det nyare halvåret går åt rätt håll (z > 0).
 *   V3  som V2, men de äldre 2/3 väljer och de senaste 122 dagarna bekräftar.
 *   V3S som V3 med z > 0.
 * "Åt samma håll" mäts som vakten mäter regeln: abs-regler med no-edge-z
 * (lib/variance) och vinstens tecken, relativa läckor mot resten av dimensionen.
 *
 * Sedan mäts samma segment på spel från T till idag: antal avgjorda, ROI och z
 * med samma kod (`edgeSegmentCandidates`, `varianceByKey`). En regel "höll":
 *   tecknet     pos-segmentet gick plus / neg-segmentet gick minus efteråt
 *               (relativa läckor: gick sämre än resten).
 *   mot resten  segmentet gick bättre (pos) / sämre (neg) än resten av sin
 *               dimension efteråt. Oberoende av om journalen totalt går plus:
 *               går allt +8 % håller abs-pos-regler "gratis" på tecknet och
 *               abs-neg-regler faller, utan att segmentet säger något.
 * och vaktens nytta mäts som ROI efteråt på spel som minst en neg-regel hade
 * varnat för, mot alla andra spel.
 *
 * Allt mäts också i påhittade världar där segmenten inte betyder något, så att
 * siffrorna kan jämföras med vad slumpen ger. Varje avgjort spel (riktiga odds)
 * dras om som vinst med p = (1+m)/odds, vilket ger spelet förväntad ROI m men
 * behåller dess egen varians:
 *   N0  m = hela poolens ROI — inget segment är bättre än något annat.
 *   N1  m = oddsbandets ROI — oddsbanden är verkliga och stabila, inget annat
 *       är det. "Slumpa om utfallen inom oddsband", fast utan att ett spel på
 *       odds 5 får träffprocenten från ett på odds 50 (5.00+ är brett).
 * Poolen är spelen från T − 365 d till idag, alltså båda sidor av T. Varje
 * påhittad värld mäts med alla varianter.
 *
 * Klockan är vaktens egen (eventAt ?? placedAt ?? createdAt), inte placedAt:
 * ett spel som lades före T på en match efter T hade inget utfall vid T.
 * Skriptet skriver ut hur många spel som skulle byta sida med placedAt.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { deriveDisciplineRules, type DisciplineRule } from "../lib/disciplineRules";
import { EDGE_DIMENSIONS, edgeSegmentCandidates, type EdgeBetInput } from "../lib/edge";
import { varianceByKey } from "../lib/variance";
import { countsForWinRate, hasRealOdds, settledProfit, type Outcome } from "../lib/betting";

const DAY_MS = 864e5;
const FICTIVE_TAG = "FIKTIV 2026-06-11";
const PLACEHOLDER_ODDS = 1.01;
const WINDOW_DAYS = 365;
/** Det nyare halvåret i V1/V2; det äldre är resten av fönstret. */
const NEWER_HALF_DAYS = 182;
/** Avgjorda spel ett halvår måste ha för att kunna bekräfta en regel. */
const MIN_HALF_SETTLED = 20;
/** z åt regelns håll som det nyare halvåret måste visa i V2. */
const CONFIRM_Z = 1;
const MODES = ["N0", "N1"] as const;
type NullMode = (typeof MODES)[number];

const VARIANTS = {
  P1: "vakten t.o.m. 2026-11-21, minAbsZ 1",
  P2: "minAbsZ 2",
  V1: "P1 + samma håll i båda halvåren",
  V2: "äldre halvår väljer, nyare bekräftar",
  V2S: "äldre halvår väljer, nyare går åt samma håll (z > 0)",
  V3: "äldre 2/3 väljer, senaste 1/3 bekräftar",
  V3S: "äldre 2/3 väljer, senaste 1/3 går åt samma håll (z > 0)",
} as const;
type VariantId = keyof typeof VARIANTS;

/**
 * Bekräftelsevarianterna: reglerna tas fram på den äldre delen av fönstret och
 * behålls om de senaste `newerDays` dagarna visar z ≥ `minZ` åt regelns håll
 * (minZ 0 = bara åt rätt håll, z > 0).
 */
const CONFIRM: Partial<Record<VariantId, { newerDays: number; minZ: number }>> = {
  V2: { newerDays: NEWER_HALF_DAYS, minZ: CONFIRM_Z },
  V2S: { newerDays: NEWER_HALF_DAYS, minZ: 0 },
  V3: { newerDays: 122, minZ: CONFIRM_Z },
  V3S: { newerDays: 122, minZ: 0 },
};

/* ------------------------------ argument ---------------------------------- */

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
const hasFlag = (flag: string) => process.argv.includes(flag);

const CUTOFFS = (argValue("--cutoffs") ?? "2026-03-21,2026-05-21,2026-07-21,2026-09-09")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const VARIANT_IDS = (argValue("--variants") ?? Object.keys(VARIANTS).join(","))
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean) as VariantId[];
for (const v of VARIANT_IDS) if (!(v in VARIANTS)) throw new Error(`Okänd variant: ${v}`);
const ITER = Number(argValue("--iter") ?? 300);
const SEED = Number(argValue("--seed") ?? 20261121);
const USERNAME = argValue("--user") ?? "jonatan";
const JSON_OUT = argValue("--json");
const DETAIL = hasFlag("--detail");
const KEEP_PLACEHOLDERS = hasFlag("--keep-placeholders");

/* ------------------------------- typer ------------------------------------ */

interface Bet extends EdgeBetInput {
  id: string;
  t: number;
  /** Segmentnyckel per dimension, null = dimensionen gäller inte spelet. */
  keys: Record<string, string | null>;
  band: string | null;
}

interface RuleEval {
  dim: string;
  key: string;
  basis: "edge" | "rest";
  tone: "pos" | "neg";
  train: { settled: number; roiPct: number | null; z: number | null; restRoiPct?: number | null };
  /** z = no-edge-z (lib/variance) för abs-regler, z för skillnaden mot resten för relativa. */
  test: { settled: number; roiPct: number | null; z: number | null; restRoiPct: number | null; restZ: number | null };
  /** Tecknet höll. null = inga avgjorda spel efteråt. */
  held: boolean | null;
  /** Gick åt regelns håll jämfört med resten av dimensionen. */
  heldRest: boolean | null;
  /** Testets z (samma som `test.z`) i regelns riktning: > 0 = åt samma håll. */
  signedZ: number | null;
  /** z för skillnaden mot resten, i regelns riktning. */
  signedRestZ: number | null;
}

interface Split {
  settled: number;
  stake: number;
  profit: number;
  roiPct: number | null;
}

interface WorldStats {
  nRules: number;
  nAbsPos: number;
  nAbsNeg: number;
  nRel: number;
  /** Regler som hade minst ett avgjort spel efteråt. */
  evaluable: number;
  heldShare: number | null;
  heldByType: { absPos: number | null; absNeg: number | null; rel: number | null };
  heldRestShare: number | null;
  meanSignedZ: number | null;
  meanSignedRestZ: number | null;
  warned: Split; // efteråt: spel som minst en neg-regel hade varnat för
  unwarned: Split; // efteråt: alla andra avgjorda spel
  /** Andel av de avgjorda spelen efteråt som fick en varning. */
  warnedShare: number | null;
  diffPp: number | null; // warned.roi − unwarned.roi, procentenheter
  diffZ: number | null;
  edgeTagged: Split; // efteråt: spel som minst en pos-regel pekade ut
  edgeOther: Split;
  rules: RuleEval[];
}

/* ------------------------------ slump ------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ statistik --------------------------------- */

/** Samma estimator som `roiStats` i lib/disciplineRules (den är inte exporterad). */
function roiStats(bets: EdgeBetInput[]): { roi: number; variance: number; profit: number; stake: number } | null {
  let stake = 0;
  let profit = 0;
  for (const b of bets) {
    stake += b.stakeUnits;
    profit += settledProfit(b);
  }
  if (!(stake > 0)) return null;
  const roi = profit / stake;
  let ss = 0;
  for (const b of bets) ss += (settledProfit(b) - roi * b.stakeUnits) ** 2;
  return { roi, variance: ss / (stake * stake), profit, stake };
}

/** ROI-skillnaden segment − resten, z som vaktens relativa test. */
function diffStats(seg: EdgeBetInput[], rest: EdgeBetInput[]) {
  const a = roiStats(seg);
  const o = roiStats(rest);
  if (!a || !o) return { a, o, diff: null as number | null, z: null as number | null };
  const se = Math.sqrt(a.variance + o.variance);
  return { a, o, diff: a.roi - o.roi, z: se > 0 ? (a.roi - o.roi) / se : null };
}

function split(bets: EdgeBetInput[]): Split {
  let stake = 0;
  let profit = 0;
  for (const b of bets) {
    stake += b.stakeUnits;
    profit += settledProfit(b);
  }
  return { settled: bets.length, stake, profit, roiPct: stake > 0 ? (profit / stake) * 100 : null };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

interface Dist {
  mean: number;
  p5: number;
  p95: number;
  /** Världar där måttet fanns (t.ex. minst en regel med avgjorda spel efteråt). */
  n: number;
}

function dist(values: (number | null)[]): Dist {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  const mean = v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
  return { mean, p5: quantile(v, 0.05), p95: quantile(v, 0.95), n: v.length };
}

/** Andel slumpvärldar minst lika bra (≥) eller lika dåliga (≤) som det verkliga utfallet. */
function tail(values: (number | null)[], x: number | null, dir: "ge" | "le"): number | null {
  const v = values.filter((y): y is number => y != null && Number.isFinite(y));
  if (x == null || !v.length) return null;
  return v.filter((y) => (dir === "ge" ? y >= x - 1e-12 : y <= x + 1e-12)).length / v.length;
}

/* ------------------------------- data ------------------------------------- */

const prisma = new PrismaClient();

async function loadBets(): Promise<{ bets: Bet[]; excluded: Record<string, number> }> {
  const user = await prisma.user.findFirstOrThrow({ where: { username: USERNAME }, select: { id: true } });
  const [rows, fictive, fictiveLoose] = await Promise.all([
    prisma.bet.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        selection: true,
        sport: true,
        market: true,
        marketCategory: true,
        betType: true,
        odds: true,
        stakeUnits: true,
        outcome: true,
        profitUnits: true,
        eventAt: true,
        placedAt: true,
        createdAt: true,
      },
    }),
    prisma.bet.findMany({ where: { userId: user.id, notes: { contains: FICTIVE_TAG } }, select: { id: true } }),
    prisma.bet.count({ where: { userId: user.id, notes: { contains: "FIKTIV" } } }),
  ]);
  const fictiveIds = new Set(fictive.map((r) => r.id));
  const marketDim = EDGE_DIMENSIONS.find((d) => d.dim === "Marknad")!;
  let placeholders = 0;
  const bets: Bet[] = [];
  for (const r of rows) {
    if (fictiveIds.has(r.id)) continue;
    if (r.odds === PLACEHOLDER_ODDS) {
      placeholders++;
      if (!KEEP_PLACEHOLDERS) continue;
    }
    const b: Bet = {
      id: r.id,
      selection: r.selection,
      sport: r.sport,
      market: r.market,
      marketCategory: r.marketCategory,
      betType: r.betType,
      odds: r.odds,
      stakeUnits: r.stakeUnits,
      outcome: r.outcome as Outcome,
      profitUnits: r.profitUnits,
      eventAt: r.eventAt,
      placedAt: r.placedAt,
      createdAt: r.createdAt,
      t: +(r.eventAt ?? r.placedAt ?? r.createdAt),
      keys: {},
      band: null,
    };
    // Marknadsnyckeln går genom betCategory() (textregler) och är det dyra i
    // varje anrop. Att skriva in svaret i marketCategory ger exakt samma nyckel
    // (keyOf läser `marketCategory || betCategory(...)`), bara en gång.
    const mk = marketDim.keyOf(b);
    if (mk) b.marketCategory = mk;
    for (const d of EDGE_DIMENSIONS) {
      b.keys[d.dim] = d.include && !d.include(b) ? null : d.keyOf(b) ?? d.fallback;
    }
    b.band = b.keys["Odds"];
    bets.push(b);
  }
  return {
    bets,
    excluded: {
      fictive: fictiveIds.size,
      fictiveLooseTag: fictiveLoose,
      placeholders: KEEP_PLACEHOLDERS ? 0 : placeholders,
    },
  };
}

/* ------------------------------ mätning ----------------------------------- */

const share = (xs: (boolean | null)[]) => {
  const e = xs.filter((x): x is boolean => x != null);
  return e.length ? e.filter(Boolean).length / e.length : null;
};
const mean = (xs: (number | null)[]) => {
  const e = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return e.length ? e.reduce((s, x) => s + x, 0) / e.length : null;
};

/** Hur reglernas segment gick på `test`. Ordningen i `rules` följer `rules`. */
function evaluate(rules: DisciplineRule[], test: Bet[]): WorldStats {
  const settled = test.filter((b) => b.outcome !== "pending");

  // Exakt samma segmentering och z som när reglerna togs fram, nu på eftersidan.
  const segByKey = new Map<string, { settled: number; profitUnits: number; roiPct: number | null }>();
  for (const s of edgeSegmentCandidates(test, 1)) segByKey.set(`${s.dim}:${s.key}`, s);
  const zByKey = new Map<string, number>();
  for (const d of EDGE_DIMENSIONS) {
    const source = d.include ? test.filter((b) => d.include!(b)) : test;
    for (const v of varianceByKey(source, (b) => d.keyOf(b as EdgeBetInput) ?? d.fallback, 1)) {
      if (v.z != null) zByKey.set(`${d.dim}:${v.key}`, v.z);
    }
  }

  const evals: RuleEval[] = [];
  for (const r of rules) {
    const basis = r.basis === "rest" ? "rest" : "edge";
    const train = { settled: r.settled, roiPct: r.roiPct, z: r.z, restRoiPct: r.restRoiPct };
    // Segmentet mot resten av dimensionen, som vaktens relativa test gör det.
    const source = settled.filter((b) => b.keys[r.dim] != null);
    const segBets = source.filter((b) => b.keys[r.dim] === r.key);
    const restBets = source.filter((b) => b.keys[r.dim] !== r.key);
    const vs = diffStats(segBets, restBets);
    const dirRest = r.tone === "pos" ? 1 : -1;
    const heldRest = vs.diff == null || segBets.length === 0 ? null : dirRest * vs.diff > 0;
    const signedRestZ = vs.z == null ? null : dirRest * vs.z;
    const restRoiPct = vs.o ? vs.o.roi * 100 : null;

    if (basis === "rest") {
      evals.push({
        dim: r.dim,
        key: r.key,
        basis,
        tone: r.tone,
        train,
        test: { settled: segBets.length, roiPct: vs.a ? vs.a.roi * 100 : null, z: vs.z, restRoiPct, restZ: vs.z },
        held: heldRest,
        heldRest,
        signedZ: signedRestZ,
        signedRestZ,
      });
    } else {
      const seg = segByKey.get(`${r.dim}:${r.key}`);
      const z = zByKey.get(`${r.dim}:${r.key}`) ?? null;
      const n = seg?.settled ?? 0;
      evals.push({
        dim: r.dim,
        key: r.key,
        basis,
        tone: r.tone,
        train,
        test: { settled: n, roiPct: seg?.roiPct ?? null, z, restRoiPct, restZ: vs.z },
        held: n > 0 && seg ? (r.tone === "pos" ? seg.profitUnits > 0 : seg.profitUnits < 0) : null,
        heldRest,
        signedZ: z == null ? null : r.tone === "pos" ? z : -z,
        signedRestZ,
      });
    }
  }

  // Vaktens matchning: ett spel varnas om någon av dess dimensionsnycklar har
  // en neg-regel (lib/discipline evaluateBet, utan antal-spel-per-match-delen).
  const negKeys = new Set(rules.filter((r) => r.tone === "neg").map((r) => `${r.dim}:${r.key}`));
  const posKeys = new Set(rules.filter((r) => r.tone === "pos").map((r) => `${r.dim}:${r.key}`));
  const hits = (b: Bet, keys: Set<string>) =>
    EDGE_DIMENSIONS.some((d) => b.keys[d.dim] != null && keys.has(`${d.dim}:${b.keys[d.dim]}`));
  const warned = settled.filter((b) => hits(b, negKeys));
  const unwarned = settled.filter((b) => !hits(b, negKeys));
  const edgeTagged = settled.filter((b) => hits(b, posKeys));
  const edgeOther = settled.filter((b) => !hits(b, posKeys));
  const wd = diffStats(warned, unwarned);

  const of = (pred: (e: RuleEval) => boolean) => share(evals.filter(pred).map((e) => e.held));
  return {
    nRules: rules.length,
    nAbsPos: evals.filter((e) => e.basis === "edge" && e.tone === "pos").length,
    nAbsNeg: evals.filter((e) => e.basis === "edge" && e.tone === "neg").length,
    nRel: evals.filter((e) => e.basis === "rest").length,
    evaluable: evals.filter((e) => e.held != null).length,
    heldShare: share(evals.map((e) => e.held)),
    heldByType: {
      absPos: of((e) => e.basis === "edge" && e.tone === "pos"),
      absNeg: of((e) => e.basis === "edge" && e.tone === "neg"),
      rel: of((e) => e.basis === "rest"),
    },
    heldRestShare: share(evals.map((e) => e.heldRest)),
    meanSignedZ: mean(evals.filter((e) => e.held != null).map((e) => e.signedZ)),
    meanSignedRestZ: mean(evals.filter((e) => e.heldRest != null).map((e) => e.signedRestZ)),
    warned: split(warned),
    unwarned: split(unwarned),
    warnedShare: settled.length ? warned.length / settled.length : null,
    diffPp: wd.diff == null ? null : wd.diff * 100,
    diffZ: wd.z,
    edgeTagged: split(edgeTagged),
    edgeOther: split(edgeOther),
    rules: evals,
  };
}

/** Varje variants regeluppsättning vid brytpunkten, bara ur spel före den. */
function buildRuleSets(all: Bet[], cutoff: number): Record<VariantId, DisciplineRule[]> {
  const train = all.filter((b) => b.t < cutoff);
  const mid = cutoff - NEWER_HALF_DAYS * DAY_MS;
  const windowFrom = cutoff - WINDOW_DAYS * DAY_MS;
  const older = train.filter((b) => b.t >= windowFrom && b.t < mid);
  const newer = train.filter((b) => b.t >= mid);

  const p1 = deriveDisciplineRules(train, { now: cutoff, minAbsZ: 1, leaks: true }).rules;
  const want = new Set(VARIANT_IDS);
  const sets = { P1: p1 } as Record<VariantId, DisciplineRule[]>;

  if (want.has("P2")) sets.P2 = deriveDisciplineRules(train, { now: cutoff, minAbsZ: 2, leaks: true }).rules;

  if (want.has("V1")) {
    const inOlder = evaluate(p1, older).rules;
    const inNewer = evaluate(p1, newer).rules;
    const ok = (e: RuleEval) => e.test.settled >= MIN_HALF_SETTLED && e.held === true;
    sets.V1 = p1.filter((_, i) => ok(inOlder[i]) && ok(inNewer[i]));
  }

  for (const [id, c] of Object.entries(CONFIRM) as [VariantId, { newerDays: number; minZ: number }][]) {
    if (!want.has(id)) continue;
    const split = cutoff - c.newerDays * DAY_MS;
    const picked = deriveDisciplineRules(
      train.filter((b) => b.t < split),
      { now: split, sinceDays: WINDOW_DAYS - c.newerDays, minAbsZ: 1, leaks: true }
    ).rules;
    const check = evaluate(
      picked,
      train.filter((b) => b.t >= split)
    ).rules;
    sets[id] = picked.filter((_, i) => {
      const z = check[i].signedZ;
      return check[i].test.settled >= MIN_HALF_SETTLED && z != null && z > 0 && z >= c.minZ;
    });
  }
  return sets;
}

function measureAll(all: Bet[], cutoff: number, now: number): Record<VariantId, WorldStats> {
  const sets = buildRuleSets(all, cutoff);
  const test = all.filter((b) => b.t >= cutoff && b.t <= now);
  const out = {} as Record<VariantId, WorldStats>;
  for (const v of VARIANT_IDS) out[v] = evaluate(sets[v], test);
  return out;
}

/* --------------------------- påhittade världar ---------------------------- */

/**
 * Drar om varje avgjort spel med riktiga odds i poolen som vinst/förlust med
 * p = (1+m)/odds. Push/void/cashout och odds 1,01 lämnas som de är.
 */
function makeWorld(all: Bet[], poolFrom: number, now: number, mode: NullMode, rng: () => number): Bet[] {
  const inPool = (b: Bet) => b.t >= poolFrom && b.t <= now && countsForWinRate(b.outcome) && hasRealOdds(b);
  const groupOf = (b: Bet) => (mode === "N1" ? b.band ?? "?" : "all");
  const acc = new Map<string, { stake: number; profit: number }>();
  for (const b of all) {
    if (!inPool(b)) continue;
    const a = acc.get(groupOf(b)) ?? { stake: 0, profit: 0 };
    a.stake += b.stakeUnits;
    a.profit += settledProfit(b);
    acc.set(groupOf(b), a);
  }
  const level = new Map<string, number>();
  for (const [k, a] of acc) level.set(k, a.stake > 0 ? a.profit / a.stake : 0);
  return all.map((b) => {
    if (!inPool(b)) return b;
    const m = level.get(groupOf(b)) ?? 0;
    const p = Math.min(0.999, Math.max(0, (1 + m) / b.odds));
    const outcome: Outcome = rng() < p ? "win" : "loss";
    return { ...b, outcome, profitUnits: null };
  });
}

/* ------------------------------ utskrift ---------------------------------- */

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const f1 = (x: number | null | undefined, sign = false) =>
  !fin(x) ? "–" : `${sign && x > 0 ? "+" : ""}${x.toFixed(1)}`.replace("-", "−");
const f2 = (x: number | null | undefined, sign = false) =>
  !fin(x) ? "–" : `${sign && x > 0 ? "+" : ""}${x.toFixed(2)}`.replace("-", "−");
const pct = (x: number | null | undefined) => (!fin(x) ? "–" : `${Math.round(x * 100)} %`);
const band = (d: Dist, fmt: (x: number) => string) => `${fmt(d.mean)} [${fmt(d.p5)}–${fmt(d.p95)}]`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

function printDetail(s: WorldStats) {
  if (!s.rules.length) {
    console.log("    (inga regler)");
    return;
  }
  console.log(
    "    " +
      [
        pad("dim", 8),
        pad("segment", 22),
        pad("typ", 8),
        lpad("n före", 7),
        lpad("ROI före", 13),
        lpad("z före", 7),
        lpad("n efter", 8),
        lpad("ROI efter", 9),
        lpad("z efter", 8),
        lpad("resten", 7),
        lpad("z mot rest", 11),
        "tecken  mot rest",
      ].join(" ")
  );
  for (const r of s.rules) {
    const typ = r.basis === "rest" ? "neg/rest" : r.tone;
    const before =
      r.basis === "rest" ? `${f1(r.train.roiPct, true)} | ${f1(r.train.restRoiPct ?? null, true)}` : f1(r.train.roiPct, true);
    const yn = (x: boolean | null) => (x == null ? "–" : x ? "ja" : "nej");
    console.log(
      "    " +
        [
          pad(r.dim, 8),
          pad(r.key, 22),
          pad(typ, 8),
          lpad(String(r.train.settled), 7),
          lpad(before, 13),
          lpad(f2(r.train.z, true), 7),
          lpad(String(r.test.settled), 8),
          lpad(f1(r.test.roiPct, true), 9),
          lpad(r.basis === "rest" ? "" : f2(r.test.z, true), 8),
          lpad(f1(r.test.restRoiPct, true), 7),
          lpad(f2(r.test.restZ, true), 11),
          `${pad(yn(r.held), 7)} ${yn(r.heldRest)}`,
        ].join(" ")
    );
  }
}

/* -------------------------------- main ------------------------------------ */

async function main() {
  const t0 = Date.now();
  const now = Date.now();
  const { bets, excluded } = await loadBets();
  console.log(
    `Spel: ${bets.length} (${USERNAME}). Uteslutna: ${excluded.fictive} med "${FICTIVE_TAG}"` +
      ` (taggen "FIKTIV" ensam: ${excluded.fictiveLooseTag}), ${excluded.placeholders} med odds 1,01` +
      `${KEEP_PLACEHOLDERS ? " (behållna, --keep-placeholders)" : ""}.`
  );
  console.log(`Påhittade världar: ${ITER} per brytpunkt och nollmodell, seed ${SEED}.`);
  console.log(`Varianter: ${VARIANT_IDS.map((v) => `${v} = ${VARIANTS[v]}`).join("; ")}.`);

  const out: Record<string, unknown>[] = [];
  const tableA: string[] = [];
  const tableB: string[] = [];

  for (const c of CUTOFFS) {
    const cutoff = Date.parse(`${c}T00:00:00Z`);
    if (!Number.isFinite(cutoff)) throw new Error(`Ogiltig brytpunkt: ${c}`);
    const poolFrom = cutoff - WINDOW_DAYS * DAY_MS;
    const trainN = bets.filter((b) => b.t >= poolFrom && b.t < cutoff && b.outcome !== "pending").length;
    const testN = bets.filter((b) => b.t >= cutoff && b.t <= now && b.outcome !== "pending").length;
    const crossings = bets.filter((b) => b.placedAt && (+new Date(b.placedAt) < cutoff) !== (b.t < cutoff)).length;
    console.log(
      `\n=== Brytpunkt ${c}: ${trainN} avgjorda i året före, ${testN} avgjorda efter` +
        ` (${crossings} spel byter sida om placedAt används i stället) ===`
    );

    const real = measureAll(bets, cutoff, now);

    // Samma påhittade värld mäts med alla varianter.
    const nulls = new Map<string, WorldStats[]>();
    for (const mode of MODES) {
      const rng = mulberry32((SEED ^ Math.round(cutoff / DAY_MS) ^ (mode === "N1" ? 0x5bd1e995 : 0)) >>> 0);
      for (let i = 0; i < ITER; i++) {
        const world = makeWorld(bets, poolFrom, now, mode, rng);
        const res = measureAll(world, cutoff, now);
        for (const v of VARIANT_IDS) {
          res[v].rules = [];
          const k = `${mode}:${v}`;
          if (!nulls.has(k)) nulls.set(k, []);
          nulls.get(k)!.push(res[v]);
        }
      }
    }

    for (const v of VARIANT_IDS) {
      const r = real[v];
      const N = (mode: NullMode) => nulls.get(`${mode}:${v}`)!;
      const D = (mode: NullMode, pick: (s: WorldStats) => number | null) => dist(N(mode).map(pick));
      const T = (mode: NullMode, pick: (s: WorldStats) => number | null, x: number | null, dir: "ge" | "le") =>
        tail(N(mode).map(pick), x, dir);

      const nr = (s: WorldStats) => s.nRules;
      const held = (s: WorldStats) => s.heldShare;
      const heldPos = (s: WorldStats) => s.heldByType.absPos;
      const heldNeg = (s: WorldStats) => s.heldByType.absNeg;
      const heldRel = (s: WorldStats) => s.heldByType.rel;
      const heldRest = (s: WorldStats) => s.heldRestShare;
      const msz = (s: WorldStats) => s.meanSignedRestZ;
      const diff = (s: WorldStats) => s.diffPp;
      const wsh = (s: WorldStats) => s.warnedShare;
      const p1 = (x: number) => f1(x);
      const pp = (x: number) => f1(x, true);
      const zz = (x: number) => f2(x, true);

      console.log(`\n-- ${v}: ${VARIANTS[v]} --`);
      console.log(
        `  Regler: ${r.nRules} (abs pos ${r.nAbsPos}, abs neg ${r.nAbsNeg}, rel neg ${r.nRel}),` +
          ` ${r.evaluable} med avgjorda spel efteråt.  Slump: N0 ${band(D("N0", nr), p1)}, N1 ${band(D("N1", nr), p1)};` +
          ` ≥ verkligt i N0 ${pct(T("N0", nr, r.nRules, "ge"))} av världarna`
      );
      console.log(
        `  Höll tecknet: ${pct(r.heldShare)} — abs pos ${pct(r.heldByType.absPos)}, abs neg ${pct(r.heldByType.absNeg)},` +
          ` rel ${pct(r.heldByType.rel)}.`
      );
      for (const mode of MODES) {
        console.log(
          `    Slump ${mode}: ${band(D(mode, held), pct)} — abs pos ${pct(D(mode, heldPos).mean)}, abs neg ${pct(
            D(mode, heldNeg).mean
          )}, rel ${pct(D(mode, heldRel).mean)};  ≥ verkligt i ${pct(T(mode, held, r.heldShare, "ge"))} av världarna`
        );
      }
      console.log(
        `  Höll mot resten: ${pct(r.heldRestShare)}, medel-z mot resten i regelns riktning ${f2(r.meanSignedRestZ, true)}.` +
          `  Slump: N0 ${band(D("N0", heldRest), pct)} / z ${band(D("N0", msz), zz)},` +
          ` N1 ${band(D("N1", heldRest), pct)} / z ${band(D("N1", msz), zz)}`
      );
      const warnedStakePct = (r.warned.stake / Math.max(1e-9, r.warned.stake + r.unwarned.stake)) * 100;
      console.log(
        `  ROI efteråt: varnade ${f1(r.warned.roiPct, true)} % (${r.warned.settled} spel = ${pct(r.warnedShare)},` +
          ` ${f1(warnedStakePct)} % av insatsen) mot övriga ${f1(r.unwarned.roiPct, true)} % (${r.unwarned.settled})` +
          ` → ${f1(r.diffPp, true)} pe, z ${f2(r.diffZ, true)}.`
      );
      console.log(
        `    Slump, skillnad i pe: N0 ${band(D("N0", diff), pp)}, N1 ${band(D("N1", diff), pp)};` +
          ` ≤ verkligt i N0 ${pct(T("N0", diff, r.diffPp, "le"))}, N1 ${pct(T("N1", diff, r.diffPp, "le"))} av världarna` +
          ` (världar utan varningar: N0 ${ITER - D("N0", diff).n}, N1 ${ITER - D("N1", diff).n});` +
          ` varnad andel i slump N0 ${pct(D("N0", wsh).mean)}`
      );
      console.log(
        `  ROI efteråt, pos-utpekade: ${f1(r.edgeTagged.roiPct, true)} % (${r.edgeTagged.settled})` +
          ` mot övriga ${f1(r.edgeOther.roiPct, true)} % (${r.edgeOther.settled})`
      );
      if (DETAIL) printDetail(r);

      tableA.push(
        `| ${c} | ${v} | ${r.nRules} (${r.nAbsPos}/${r.nAbsNeg}/${r.nRel}) | ${f1(D("N0", nr).mean)} / ${f1(D("N1", nr).mean)} | ` +
          `${pct(r.heldShare)} | ${pct(D("N0", held).mean)} / ${pct(D("N1", held).mean)} | ` +
          `${pct(r.heldRestShare)} | ${pct(D("N0", heldRest).mean)} / ${pct(D("N1", heldRest).mean)} |`
      );
      tableB.push(
        `| ${c} | ${v} | ${pct(r.warnedShare)} | ${f1(r.warned.roiPct, true)} % (${r.warned.settled}) | ` +
          `${f1(r.unwarned.roiPct, true)} % (${r.unwarned.settled}) | ` +
          `${f1(r.diffPp, true)} (z ${f2(r.diffZ, true)}) | ${band(D("N0", diff), pp)} | ${band(D("N1", diff), pp)} |`
      );

      out.push({
        cutoff: c,
        variant: v,
        variantLabel: VARIANTS[v],
        trainSettled: trainN,
        testSettled: testN,
        real: r,
        null: Object.fromEntries(
          MODES.map((mode) => [
            mode,
            {
              nRules: D(mode, nr),
              heldShare: D(mode, held),
              heldAbsPos: D(mode, heldPos),
              heldAbsNeg: D(mode, heldNeg),
              heldRel: D(mode, heldRel),
              heldRestShare: D(mode, heldRest),
              meanSignedRestZ: D(mode, msz),
              warnedShare: D(mode, wsh),
              diffPp: D(mode, diff),
              pRulesGE: T(mode, nr, r.nRules, "ge"),
              pHeldGE: T(mode, held, r.heldShare, "ge"),
              pHeldRestGE: T(mode, heldRest, r.heldRestShare, "ge"),
              pDiffLE: T(mode, diff, r.diffPp, "le"),
            },
          ])
        ),
      });
    }
  }

  console.log("\n=== Sammanfattning: höll reglerna? (slump = medel över påhittade världar) ===");
  console.log(
    "| brytpunkt | variant | regler (pos/neg/rel) | slump N0 / N1: regler | höll tecknet | slump N0 / N1 | höll mot resten | slump N0 / N1 |"
  );
  console.log("|---|---|---|---|---|---|---|---|");
  for (const line of tableA) console.log(line);
  console.log("\n=== Sammanfattning: ROI efteråt, spel vakten hade varnat för mot övriga ===");
  console.log("| brytpunkt | variant | varnad andel | varnade | övriga | skillnad pe | slump N0 [5–95] | slump N1 [5–95] |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const line of tableB) console.log(line);

  if (JSON_OUT) {
    const fs = await import("node:fs");
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify(
        { generatedAt: new Date(now).toISOString(), iter: ITER, seed: SEED, variants: VARIANTS, excluded, results: out },
        null,
        2
      )
    );
    console.log(`\nJSON: ${JSON_OUT}`);
  }
  console.log(`\nKlart på ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
