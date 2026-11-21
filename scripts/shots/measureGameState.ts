/**
 * Mäter hur matchens ställning styr skott, hörnor, fouls och kort — och vad det
 * betyder för korrelationen mellan benen i en bet builder.
 *
 * Läser bara Sofascore-cachen på disk (.cache/sofascore), inga nätanrop. Cachen
 * har statistik per halvlek (1ST/2ND) och pausresultat, så två saker går att mäta:
 *
 *   A. Matchtillstånd: tar laget som ligger under i paus en större andel av andra
 *      halvlekens hörnor/skott än ett lika starkt lag i en jämn match? Och blir
 *      det fler eller färre hörnor/skott/kort totalt när någon leder?
 *   B. Bet builder-korrelation: φ (= ρ i /fairodds jointProb) mellan binära ben,
 *      rått och inom styrkeskikt. Rått φ blandar ihop lagstyrka med matchmanus;
 *      i en bet builder har bolagets ben-priser redan styrkan i sig, så det är
 *      φ inom skikt som ska in i ρ-reglaget.
 *
 * Styrka = lagets snitt av xG-skillnad (målskillnad när xG saknas) i säsongens
 * övriga matcher (leave-one-out). Det är en mätning, inte en backtest — LOO får
 * använda senare matcher.
 *
 *   npm run shots:gamestate
 *   npm run shots:gamestate -- --cache "C:/…/.cache/sofascore" --strata 5 --boot 2000
 */
import fs from "node:fs";
import path from "node:path";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const CACHE = argValue("--cache") ?? process.env.SOFASCORE_CACHE_DIR ?? ".cache/sofascore";
const STRATA = Number(argValue("--strata") ?? 5);
const BOOT = Number(argValue("--boot") ?? 2000);
/** Minst så många andra matcher i säsongen för att styrkan ska räknas. */
const MIN_OTHER = 4;

const LEAGUES: Record<number, string> = { 17: "Premier League", 40: "Allsvenskan", 679: "Europa League", 8: "LaLiga" };

type Pair = [number, number];
interface Half {
  corners: Pair;
  shots: Pair;
  sot: Pair;
  fouls: Pair;
  cards: Pair; // gula + röda
}
interface Match {
  id: number;
  league: string;
  seasonKey: string;
  home: number;
  away: number;
  ht: Pair;
  ft: Pair;
  all: Half;
  h1: Half;
  h2: Half;
  xg: Pair | null;
  /** Hemmalagets styrka minus bortalagets (LOO), i mål per match. */
  sup: number;
}

// ---------------------------------------------------------------------------
// Inläsning
// ---------------------------------------------------------------------------

interface SofaItem {
  key: string;
  homeValue?: number;
  awayValue?: number;
}
interface SofaPeriod {
  period: string;
  groups: { statisticsItems: SofaItem[] }[];
}

function readHalf(p: SofaPeriod | undefined): Half | null {
  if (!p) return null;
  const v = new Map<string, Pair>();
  for (const g of p.groups) for (const i of g.statisticsItems) {
    if (!v.has(i.key) && typeof i.homeValue === "number" && typeof i.awayValue === "number") v.set(i.key, [i.homeValue, i.awayValue]);
  }
  const need = (k: string) => v.get(k);
  const opt = (k: string): Pair => v.get(k) ?? [0, 0];
  const corners = need("cornerKicks");
  const shots = need("totalShotsOnGoal");
  if (!corners || !shots) return null;
  const y = opt("yellowCards");
  const r = opt("redCards");
  return { corners, shots, sot: opt("shotsOnGoal"), fouls: opt("fouls"), cards: [y[0] + r[0], y[1] + r[1]] };
}

function readXg(p: SofaPeriod | undefined): Pair | null {
  if (!p) return null;
  for (const g of p.groups) for (const i of g.statisticsItems) {
    if (i.key === "expectedGoals" && typeof i.homeValue === "number" && typeof i.awayValue === "number") return [i.homeValue, i.awayValue];
  }
  return null;
}

function load(): Omit<Match, "sup">[] {
  const files = fs.readdirSync(CACHE);
  const events = new Map<number, any>();
  for (const f of files.filter((f) => /_events_(last|next)_/.test(f))) {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));
    for (const e of j.events ?? []) {
      if (e.status?.type !== "finished") continue;
      const ut = e.tournament?.uniqueTournament?.id;
      if (!(ut in LEAGUES)) continue;
      // Dubbelmöten (kval, playoff, utslagning) spelas mot sammanlagt resultat,
      // så matchens egen ställning är inte det tillstånd lagen spelar efter.
      if (e.roundInfo?.cupRoundType != null || e.roundInfo?.name != null) continue;
      events.set(e.id, e);
    }
  }
  const out: Omit<Match, "sup">[] = [];
  for (const f of files.filter((f) => /^event_\d+_statistics/.test(f))) {
    const id = Number(f.split("_")[1]);
    const e = events.get(id);
    if (!e) continue;
    const j = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));
    const periods: SofaPeriod[] = j.statistics ?? [];
    const by = (p: string) => periods.find((x) => x.period === p);
    const all = readHalf(by("ALL"));
    const h1 = readHalf(by("1ST"));
    const h2 = readHalf(by("2ND"));
    const hs = e.homeScore ?? {};
    const as = e.awayScore ?? {};
    const ftH = hs.normaltime ?? hs.current;
    const ftA = as.normaltime ?? as.current;
    if (!all || !h1 || !h2 || typeof hs.period1 !== "number" || typeof as.period1 !== "number") continue;
    if (typeof ftH !== "number" || typeof ftA !== "number") continue;
    out.push({
      id,
      league: LEAGUES[e.tournament.uniqueTournament.id],
      seasonKey: `${e.tournament.uniqueTournament.id}_${e.season?.id}`,
      home: e.homeTeam.id,
      away: e.awayTeam.id,
      ht: [hs.period1, as.period1],
      ft: [ftH, ftA],
      all,
      h1,
      h2,
      xg: readXg(by("ALL")),
    });
  }
  return out;
}

/** Leave-one-out-styrka per lag och säsong; matcher där endera laget har för få andra matcher faller bort. */
function withStrength(raw: Omit<Match, "sup">[]): Match[] {
  const dom = (m: Omit<Match, "sup">) => (m.xg ? m.xg[0] - m.xg[1] : m.ft[0] - m.ft[1]);
  const acc = new Map<string, { sum: number; n: number }>();
  const add = (k: string, x: number) => {
    const a = acc.get(k) ?? { sum: 0, n: 0 };
    a.sum += x;
    a.n += 1;
    acc.set(k, a);
  };
  for (const m of raw) {
    add(`${m.seasonKey}:${m.home}`, dom(m));
    add(`${m.seasonKey}:${m.away}`, -dom(m));
  }
  const loo = (k: string, own: number) => {
    const a = acc.get(k)!;
    return a.n - 1 >= MIN_OTHER ? (a.sum - own) / (a.n - 1) : null;
  };
  const out: Match[] = [];
  for (const m of raw) {
    const sH = loo(`${m.seasonKey}:${m.home}`, dom(m));
    const sA = loo(`${m.seasonKey}:${m.away}`, -dom(m));
    if (sH == null || sA == null) continue;
    out.push({ ...m, sup: sH - sA });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statistik
// ---------------------------------------------------------------------------

/** OLS med HC1-robusta standardfel. */
function ols(X: number[][], y: number[]): { beta: number[]; se: number[] } {
  const n = X.length;
  const k = X[0].length;
  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) {
    xty[a] += X[i][a] * y[i];
    for (let b = 0; b < k; b++) xtx[a][b] += X[i][a] * X[i][b];
  }
  const inv = invert(xtx);
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    const e = y[i] - X[i].reduce((s, v, j) => s + v * beta[j], 0);
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += e * e * X[i][a] * X[i][b];
  }
  const cov = mul(mul(inv, meat), inv);
  const se = cov.map((row, a) => Math.sqrt((row[a] * n) / (n - k)));
  return { beta, se };
}

function mul(A: number[][], B: number[][]): number[][] {
  return A.map((row) => B[0].map((_, j) => row.reduce((s, v, t) => s + v * B[t][j], 0)));
}

function invert(M: number[][]): number[][] {
  const k = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) throw new Error("Singulär matris i OLS");
    for (let j = 0; j < 2 * k; j++) A[c][j] /= d;
    for (let r = 0; r < k; r++) if (r !== c) {
      const f = A[r][c];
      for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row) => row.slice(k));
}

function phi(a: boolean[], b: boolean[]): number | null {
  const n = a.length;
  if (n < 10) return null;
  let na = 0, nb = 0, nab = 0;
  for (let i = 0; i < n; i++) {
    if (a[i]) na++;
    if (b[i]) nb++;
    if (a[i] && b[i]) nab++;
  }
  const pa = na / n, pb = nb / n, pab = nab / n;
  const d = Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
  return d > 0 ? (pab - pa * pb) / d : null;
}

/** Skiktnummer 0..STRATA-1 efter kvantiler av `key`. */
function strataOf(keys: number[]): number[] {
  const sorted = [...keys].sort((x, y) => x - y);
  const cuts = Array.from({ length: STRATA - 1 }, (_, i) => sorted[Math.floor(((i + 1) * sorted.length) / STRATA)]);
  return keys.map((k) => cuts.filter((c) => k >= c).length);
}

/** n-viktat medel av φ inom skikt. */
function stratifiedPhi(a: boolean[], b: boolean[], s: number[], idx?: number[]): number | null {
  const rows = idx ?? a.map((_, i) => i);
  let num = 0, den = 0;
  for (let k = 0; k < STRATA; k++) {
    const r = rows.filter((i) => s[i] === k);
    const p = phi(r.map((i) => a[i]), r.map((i) => b[i]));
    if (p == null) continue;
    num += p * r.length;
    den += r.length;
  }
  return den > 0 ? num / den : null;
}

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap-KI (95 %) för φ inom skikt; drar om matcher inom varje skikt. */
function bootCi(a: boolean[], b: boolean[], s: number[]): [number, number] {
  const rand = rng(20261121);
  const groups = Array.from({ length: STRATA }, (_, k) => s.map((v, i) => (v === k ? i : -1)).filter((i) => i >= 0));
  const est: number[] = [];
  for (let r = 0; r < BOOT; r++) {
    const idx: number[] = [];
    for (const g of groups) for (let j = 0; j < g.length; j++) idx.push(g[Math.floor(rand() * g.length)]);
    const p = stratifiedPhi(a, b, s, idx);
    if (p != null) est.push(p);
  }
  est.sort((x, y) => x - y);
  return [est[Math.floor(0.025 * est.length)], est[Math.floor(0.975 * est.length)]];
}

/** x,5-linjen där P(över) ligger närmast 50 %. */
function pickLine(values: number[]): number {
  let best = 0.5, bestGap = Infinity;
  const max = Math.max(...values);
  for (let k = 0; k <= max; k++) {
    const line = k + 0.5;
    const p = values.filter((v) => v > line).length / values.length;
    if (Math.abs(p - 0.5) < bestGap) {
      bestGap = Math.abs(p - 0.5);
      best = line;
    }
  }
  return best;
}

const f2 = (x: number) => x.toFixed(2).replace(".", ",").replace(/^(-?)0,/, "$10,");
const f1 = (x: number) => x.toFixed(1).replace(".", ",");
const sgn = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d).replace(".", ",")}`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

// ---------------------------------------------------------------------------
// Del A — matchtillstånd i paus → andra halvlek
// ---------------------------------------------------------------------------

type StateKey = "-2" | "-1" | "0" | "+1" | "+2";
const stateOf = (m: number): StateKey => (m <= -2 ? "-2" : m === -1 ? "-1" : m === 0 ? "0" : m === 1 ? "+1" : "+2");
const STATE_LABEL: Record<StateKey, string> = { "-2": "under 2+", "-1": "under 1", "0": "lika", "+1": "leder 1", "+2": "leder 2+" };

function partA(ms: Match[]) {
  console.log("\n══ A. Pausställning → andra halvlek ══");
  console.log("Lagperspektiv (varje match ger två rader): andel av hörnor/skott i 1:a resp. 2:a halvlek.\n");

  for (const metric of ["corners", "shots"] as const) {
    const rows: Record<StateKey, { n: number; s1: number; s2: number }> = {
      "-2": { n: 0, s1: 0, s2: 0 }, "-1": { n: 0, s1: 0, s2: 0 }, "0": { n: 0, s1: 0, s2: 0 }, "+1": { n: 0, s1: 0, s2: 0 }, "+2": { n: 0, s1: 0, s2: 0 },
    };
    for (const m of ms) {
      const t1 = m.h1[metric][0] + m.h1[metric][1];
      const t2 = m.h2[metric][0] + m.h2[metric][1];
      if (t1 === 0 || t2 === 0) continue;
      for (const side of [0, 1] as const) {
        const st = stateOf(side === 0 ? m.ht[0] - m.ht[1] : m.ht[1] - m.ht[0]);
        rows[st].n++;
        rows[st].s1 += m.h1[metric][side] / t1;
        rows[st].s2 += m.h2[metric][side] / t2;
      }
    }
    console.log(`  ${metric === "corners" ? "Hörnor" : "Skott"}   ${pad("i paus", 9)} ${lpad("n", 5)} ${lpad("andel 1H", 9)} ${lpad("andel 2H", 9)} ${lpad("skillnad", 9)}`);
    for (const k of ["-2", "-1", "0", "+1", "+2"] as StateKey[]) {
      const r = rows[k];
      if (!r.n) continue;
      const a1 = (100 * r.s1) / r.n, a2 = (100 * r.s2) / r.n;
      console.log(`           ${pad(STATE_LABEL[k], 9)} ${lpad(String(r.n), 5)} ${lpad(f1(a1) + " %", 9)} ${lpad(f1(a2) + " %", 9)} ${lpad(sgn(a2 - a1, 1) + " pe", 9)}`);
    }
    console.log("");
  }

  // Regression: hemmalagets andel i 2H ~ styrka + pausläge (+ andel 1H).
  console.log("  Kontrollerat för förmatchstyrka (OLS, hemmaperspektiv, en rad per match, HC1-SE).");
  console.log("  Effekt i procentenheter av 2:a halvlekens andel, mot 'lika i paus':\n");
  console.log(`  ${pad("", 24)} ${lpad("under 2+", 13)} ${lpad("under 1", 13)} ${lpad("leder 1", 13)} ${lpad("leder 2+", 13)}`);
  for (const metric of ["corners", "shots"] as const) {
    for (const ctrl1H of [false, true]) {
      const X: number[][] = [];
      const y: number[] = [];
      for (const m of ms) {
        const t1 = m.h1[metric][0] + m.h1[metric][1];
        const t2 = m.h2[metric][0] + m.h2[metric][1];
        if (t2 === 0 || (ctrl1H && t1 === 0)) continue;
        const st = stateOf(m.ht[0] - m.ht[1]);
        const row = [1, m.sup, +(st === "-2"), +(st === "-1"), +(st === "+1"), +(st === "+2")];
        if (ctrl1H) row.push(m.h1[metric][0] / t1);
        X.push(row);
        y.push(m.h2[metric][0] / t2);
      }
      const { beta, se } = ols(X, y);
      const cell = (j: number) => `${sgn(100 * beta[j], 1)} ±${f1(196 * se[j])}`;
      const label = `${metric === "corners" ? "Hörnor" : "Skott"}${ctrl1H ? " (+ andel 1H)" : ""}`;
      console.log(`  ${pad(label, 24)} ${lpad(cell(2), 13)} ${lpad(cell(3), 13)} ${lpad(cell(4), 13)} ${lpad(cell(5), 13)}`);
    }
  }

  // Totaler i 2H ~ totaler 1H + |styrkeskillnad| + |marginal i paus|.
  console.log("\n  Totalt i 2:a halvlek (båda lagen) när någon leder i paus, mot 'lika i paus'.");
  console.log("  Kontrollerat för samma mått i 1:a halvlek och |styrkeskillnad|. ±1,96·SE.\n");
  console.log(`  ${pad("", 10)} ${lpad("snitt 2H lika", 14)} ${lpad("leder med 1", 15)} ${lpad("leder med 2+", 15)}`);
  for (const metric of ["corners", "shots", "sot", "fouls", "cards"] as const) {
    const X: number[][] = [];
    const y: number[] = [];
    let base = 0, nBase = 0;
    for (const m of ms) {
      const t1 = m.h1[metric][0] + m.h1[metric][1];
      const t2 = m.h2[metric][0] + m.h2[metric][1];
      const mg = Math.abs(m.ht[0] - m.ht[1]);
      X.push([1, t1, Math.abs(m.sup), +(mg === 1), +(mg >= 2)]);
      y.push(t2);
      if (mg === 0) { base += t2; nBase++; }
    }
    const { beta, se } = ols(X, y);
    const name = { corners: "Hörnor", shots: "Skott", sot: "Skott på mål", fouls: "Fouls", cards: "Kort" }[metric];
    const cell = (j: number) => `${sgn(beta[j], 2)} ±${f2(1.96 * se[j])}`;
    console.log(`  ${pad(name, 10)} ${lpad(f2(base / nBase), 14)} ${lpad(cell(3), 15)} ${lpad(cell(4), 15)}`);
  }
}

// ---------------------------------------------------------------------------
// Del B — φ mellan bet builder-ben
// ---------------------------------------------------------------------------

function partB(ms: Match[]) {
  console.log("\n══ B. Korrelation mellan ben (φ = ρ i /fairodds) ══");
  // Hemmafördel i samma enhet som styrkan: snittets xG-/målskillnad hemma.
  const homeAdv = ms.reduce((s, m) => s + (m.xg ? m.xg[0] - m.xg[1] : m.ft[0] - m.ft[1]), 0) / ms.length;
  console.log(`Favorit = högst LOO-styrka inklusive hemmafördel (${f2(homeAdv)} mål/match). Skikt = ${STRATA} kvantiler av |styrkeskillnad|.\n`);

  const fav = ms.map((m) => (m.sup + homeAdv >= 0 ? 0 : 1));
  const s = strataOf(ms.map((m) => Math.abs(m.sup + homeAdv)));
  const val = (m: Match, metric: keyof Half, side: number) => m.all[metric][side];
  const favCorners = ms.map((m, i) => val(m, "corners", fav[i]));
  const dogCorners = ms.map((m, i) => val(m, "corners", 1 - fav[i]));
  const favShots = ms.map((m, i) => val(m, "shots", fav[i]));
  const dogShots = ms.map((m, i) => val(m, "shots", 1 - fav[i]));
  const totCorners = ms.map((m) => m.all.corners[0] + m.all.corners[1]);
  const totShots = ms.map((m) => m.all.shots[0] + m.all.shots[1]);
  const totCards = ms.map((m) => m.all.cards[0] + m.all.cards[1]);
  const L = {
    favC: pickLine(favCorners), dogC: pickLine(dogCorners), favS: pickLine(favShots), dogS: pickLine(dogShots),
    totC: pickLine(totCorners), totS: pickLine(totShots), totK: pickLine(totCards),
  };
  const over = (xs: number[], line: number) => xs.map((x) => x > line);
  const favWin = ms.map((m, i) => m.ft[fav[i]] > m.ft[1 - fav[i]]);
  const dogNotLose = favWin.map((w) => !w);
  const draw = ms.map((m) => m.ft[0] === m.ft[1]);
  const o25 = ms.map((m) => m.ft[0] + m.ft[1] > 2.5);
  const btts = ms.map((m) => m.ft[0] > 0 && m.ft[1] > 0);
  const kc = (l: number) => f1(l);

  const pairs: [string, boolean[], boolean[]][] = [
    [`Favoriten vinner × underdogens hörnor Ö${kc(L.dogC)}`, favWin, over(dogCorners, L.dogC)],
    [`Favoriten vinner × favoritens hörnor Ö${kc(L.favC)}`, favWin, over(favCorners, L.favC)],
    [`Favoriten vinner × hörnor totalt Ö${kc(L.totC)}`, favWin, over(totCorners, L.totC)],
    [`Favoriten vinner × underdogens skott Ö${kc(L.dogS)}`, favWin, over(dogShots, L.dogS)],
    [`Favoriten vinner × favoritens skott Ö${kc(L.favS)}`, favWin, over(favShots, L.favS)],
    [`Favoriten vinner × kort totalt Ö${kc(L.totK)}`, favWin, over(totCards, L.totK)],
    [`Underdogen tar poäng × kort totalt Ö${kc(L.totK)}`, dogNotLose, over(totCards, L.totK)],
    [`Oavgjort × kort totalt Ö${kc(L.totK)}`, draw, over(totCards, L.totK)],
    [`Över 2,5 mål × hörnor totalt Ö${kc(L.totC)}`, o25, over(totCorners, L.totC)],
    [`Över 2,5 mål × skott totalt Ö${kc(L.totS)}`, o25, over(totShots, L.totS)],
    [`Över 2,5 mål × kort totalt Ö${kc(L.totK)}`, o25, over(totCards, L.totK)],
    [`Båda gör mål × hörnor totalt Ö${kc(L.totC)}`, btts, over(totCorners, L.totC)],
    [`Favoritens skott Ö${kc(L.favS)} × favoritens hörnor Ö${kc(L.favC)}`, over(favShots, L.favS), over(favCorners, L.favC)],
    [`Underdogens skott Ö${kc(L.dogS)} × underdogens hörnor Ö${kc(L.dogC)}`, over(dogShots, L.dogS), over(dogCorners, L.dogC)],
  ];

  const leagues = [...new Set(ms.map((m) => m.league))].sort();
  const W = 52;
  console.log(`  ${pad("Ben A × ben B", W)} ${lpad("P(A)", 5)} ${lpad("P(B)", 5)} ${lpad("φ rått", 7)} ${lpad("φ i skikt", 10)} ${lpad("95 % KI", 14)}  ${leagues.map((l) => lpad(l.split(" ")[0], 10)).join(" ")}`);
  for (const [label, a, b] of pairs) {
    const pa = a.filter(Boolean).length / a.length;
    const pb = b.filter(Boolean).length / b.length;
    const raw = phi(a, b)!;
    const st = stratifiedPhi(a, b, s)!;
    const [lo, hi] = bootCi(a, b, s);
    const perLeague = leagues.map((l) => {
      const idx = ms.map((m, i) => (m.league === l ? i : -1)).filter((i) => i >= 0);
      const p = stratifiedPhi(a, b, s, idx);
      return lpad(p == null ? "–" : sgn(p), 10);
    });
    console.log(
      `  ${pad(label, W)} ${lpad(Math.round(pa * 100) + "%", 5)} ${lpad(Math.round(pb * 100) + "%", 5)} ${lpad(sgn(raw), 7)} ${lpad(sgn(st), 10)} ${lpad(`[${sgn(lo)}, ${sgn(hi)}]`, 14)}  ${perLeague.join(" ")}`
    );
  }
  console.log(`\n  Matcher per liga: ${leagues.map((l) => `${l} ${ms.filter((m) => m.league === l).length}`).join(", ")}.`);
}

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(CACHE)) {
    console.error(`Hittar ingen Sofascore-cache i ${CACHE}. Ange --cache <mapp> (huvudmappens .cache/sofascore).`);
    process.exit(1);
  }
  const raw = load();
  const ms = withStrength(raw);
  const xgShare = ms.filter((m) => m.xg).length / ms.length;
  console.log(`Sofascore-cache: ${raw.length} ligamatcher med halvleksstatistik, ${ms.length} med styrka för båda lagen (xG i ${Math.round(xgShare * 100)} %).`);
  partA(ms);
  partB(ms);
}

main();
