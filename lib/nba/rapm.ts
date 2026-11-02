// RAPM — regularized adjusted plus-minus: varje spelares påverkan på lagets
// anfall och försvar, i poäng per 100 possessions, ur stintarna.
//
// Varje stint ger två observationer (hemmalagets anfall mot bortalagets
// försvar, och tvärtom):
//   100·poäng/possessions − liga ∓ hemma/2  =  Σ O(anfallets fem)  −  Σ D(försvarets fem)
// O > 0: laget gör fler poäng med spelaren på planen. D > 0: motståndarna gör
// färre. Systemet löses med viktad ridge-regression (vikten = possessions ×
// färskhet), så att spelare med lite speltid dras mot 0 = ligasnitt. Lösaren
// är konjugerad gradient på normalekvationerna — inga matrisbibliotek behövs.

export interface StintRow {
  /** Matchstart i ms. */
  t: number;
  homeIds: number[];
  awayIds: number[];
  homePts: number;
  awayPts: number;
  poss: number;
}

export interface PlayerImpact {
  /** Poäng per 100 possessions laget gör mer med spelaren på planen. */
  off: number;
  /** Poäng per 100 possessions motståndarna gör mindre. */
  def: number;
  /** Possessions bakom skattningen (oviktade). */
  poss: number;
}

export interface RapmParams {
  /** Ridge i possessions: hur mycket data som krävs innan en spelare får en egen siffra. */
  lambda: number;
  /** Halveringstid i dagar — äldre stintar väger mindre. */
  halfLifeDays: number;
  /** Hemmafördel i poäng per 100 (marginal). */
  homeRtg: number;
  /** Stintar med färre possessions hoppas över (brus). */
  minPoss: number;
  /** Max antal CG-iterationer. */
  iterations: number;
}

export const DEFAULT_RAPM: RapmParams = { lambda: 3000, halfLifeDays: 365, homeRtg: 1.6, minPoss: 1, iterations: 200 };

export interface RapmFit {
  players: Map<number, PlayerImpact>;
  /** Ligans poäng per 100 possessions i underlaget. */
  ortg: number;
  stints: number;
}

/** Löser RAPM med stintar före asOf. */
export function fitRapm(rows: StintRow[], asOf: number, p: RapmParams = DEFAULT_RAPM): RapmFit {
  // Index: spelare → kolumn. O-kolumner först, sedan D.
  const idx = new Map<number, number>();
  const ids: number[] = [];
  const use: StintRow[] = [];
  const weights: number[] = [];
  const possTot = new Map<number, number>();
  let wSum = 0;
  let ptsW = 0;
  for (const r of rows) {
    if (r.t >= asOf || r.poss < p.minPoss || r.homeIds.length !== 5 || r.awayIds.length !== 5) continue;
    const w = r.poss * Math.pow(0.5, (asOf - r.t) / 864e5 / p.halfLifeDays);
    if (!(w > 0)) continue;
    use.push(r);
    weights.push(w);
    wSum += 2 * w;
    ptsW += w * ((100 * r.homePts) / r.poss + (100 * r.awayPts) / r.poss);
    for (const id of [...r.homeIds, ...r.awayIds]) {
      if (!idx.has(id)) {
        idx.set(id, ids.length);
        ids.push(id);
      }
      possTot.set(id, (possTot.get(id) ?? 0) + r.poss);
    }
  }
  const n = ids.length;
  const players = new Map<number, PlayerImpact>();
  if (!use.length) return { players, ortg: 112, stints: 0 };
  const lg = ptsW / wSum;
  const hca = p.homeRtg / 2;

  // Observationer: (anfallets 5 kolumner, försvarets 5, y, w).
  const obsOff: Int32Array[] = [];
  const obsDef: Int32Array[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  use.forEach((r, i) => {
    const w = weights[i];
    const h = Int32Array.from(r.homeIds.map((id) => idx.get(id)!));
    const a = Int32Array.from(r.awayIds.map((id) => idx.get(id)!));
    obsOff.push(h, a);
    obsDef.push(a, h);
    ys.push((100 * r.homePts) / r.poss - lg - hca, (100 * r.awayPts) / r.poss - lg + hca);
    ws.push(w, w);
  });

  // β = [O(0..n-1), D(0..n-1)]; prediktion = Σ O(off) − Σ D(def).
  const m = 2 * n;
  const predict = (beta: Float64Array, k: number) => {
    let s = 0;
    const o = obsOff[k];
    const d = obsDef[k];
    for (let j = 0; j < 5; j++) s += beta[o[j]] - beta[n + d[j]];
    return s;
  };
  // A·v = Xᵀ W X v + λ v
  const applyA = (v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let k = 0; k < ys.length; k++) {
      const xv = predict(v, k) * ws[k];
      const o = obsOff[k];
      const d = obsDef[k];
      for (let j = 0; j < 5; j++) {
        out[o[j]] += xv;
        out[n + d[j]] -= xv;
      }
    }
    for (let i = 0; i < m; i++) out[i] += p.lambda * v[i];
  };
  // b = Xᵀ W y
  const b = new Float64Array(m);
  for (let k = 0; k < ys.length; k++) {
    const wy = ws[k] * ys[k];
    const o = obsOff[k];
    const d = obsDef[k];
    for (let j = 0; j < 5; j++) {
      b[o[j]] += wy;
      b[n + d[j]] -= wy;
    }
  }
  // Konjugerad gradient.
  const x = new Float64Array(m);
  const r = Float64Array.from(b);
  const dir = Float64Array.from(b);
  const Ad = new Float64Array(m);
  let rr = dot(r, r);
  const tol = 1e-10 * Math.max(1, rr);
  for (let it = 0; it < p.iterations && rr > tol; it++) {
    applyA(dir, Ad);
    const alpha = rr / dot(dir, Ad);
    for (let i = 0; i < m; i++) {
      x[i] += alpha * dir[i];
      r[i] -= alpha * Ad[i];
    }
    const rrNew = dot(r, r);
    const beta = rrNew / rr;
    rr = rrNew;
    for (let i = 0; i < m; i++) dir[i] = r[i] + beta * dir[i];
  }
  ids.forEach((id, i) => players.set(id, { off: x[i], def: x[n + i], poss: possTot.get(id) ?? 0 }));
  return { players, ortg: lg, stints: use.length };
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface LineupMinutes {
  playerId: number;
  minutes: number;
}

/**
 * Hur mycket kvällens uppställning skiljer sig från den normala, i poäng per
 * 100 possessions: (anfall, försvar). Minuterna / 48 = andel av matchen
 * spelaren står på planen; fem spelare åt gången.
 */
export function lineupImpact(fit: RapmFit, today: LineupMinutes[], base: LineupMinutes[]): { off: number; def: number } {
  const sum = (l: LineupMinutes[], k: "off" | "def") => l.reduce((s, e) => s + (Math.max(0, e.minutes) / 48) * (fit.players.get(e.playerId)?.[k] ?? 0), 0);
  return { off: sum(today, "off") - sum(base, "off"), def: sum(today, "def") - sum(base, "def") };
}
