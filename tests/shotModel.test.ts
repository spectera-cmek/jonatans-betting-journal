import { describe, it, expect } from "vitest";
import { poissonAtLeast } from "../lib/fairOdds";
import {
  logGamma,
  negBinPmf,
  negBinPmfVector,
  negBinAtLeast,
  tailFromPmf,
  convolvePmf,
  correlatedTotalPmf,
  negBinVariance,
  fitCalibration,
  applyCalibration,
  fitDispersion,
  fitDispersionFromCounts,
  leagueBaseline,
  computeRatings,
  projectMatch,
  lineProbs,
  fairOdds,
  marketProbOver,
  marketConsensus,
  lambdaFromLineProb,
  negBinFamily,
  convolvedFamily,
  blendProb,
  priceLine,
  type TeamMatchObs,
  type LeagueBaseline,
} from "../lib/shotModel";

const HUGE_PHI = 1e12; // ⇒ Poisson

/** Moment ur en pmf-vektor, för att kontrollera att fördelningen stämmer. */
function moments(pmf: number[]) {
  const sum = pmf.reduce((s, p) => s + p, 0);
  const mean = pmf.reduce((s, p, k) => s + p * k, 0);
  const ex2 = pmf.reduce((s, p, k) => s + p * k * k, 0);
  return { sum, mean, variance: ex2 - mean * mean };
}

describe("logGamma", () => {
  it("matches factorials: Γ(n) = (n−1)!", () => {
    expect(logGamma(1)).toBeCloseTo(0, 10); // 0! = 1
    expect(logGamma(2)).toBeCloseTo(0, 10); // 1! = 1
    expect(logGamma(3)).toBeCloseTo(Math.log(2), 10);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
  });

  it("handles the reflection branch: Γ(½) = √π", () => {
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 10);
  });
});

describe("negBinPmf", () => {
  it("is geometric at phi = 1: P(k) = p(1−p)^k", () => {
    // mean 1, phi 1 → p = 1/(1+1) = 0.5
    expect(negBinPmf(0, 1, 1)).toBeCloseTo(0.5, 10);
    expect(negBinPmf(1, 1, 1)).toBeCloseTo(0.25, 10);
    expect(negBinPmf(2, 1, 1)).toBeCloseTo(0.125, 10);
  });

  it("collapses to Poisson as phi → ∞", () => {
    // Poisson(2): P(0) = e^−2, P(1) = 2e^−2
    expect(negBinPmf(0, 2, HUGE_PHI)).toBeCloseTo(Math.exp(-2), 9);
    expect(negBinPmf(1, 2, HUGE_PHI)).toBeCloseTo(2 * Math.exp(-2), 9);
  });

  it("rejects non-integer and negative k", () => {
    expect(negBinPmf(1.5, 2, 3)).toBe(0);
    expect(negBinPmf(-1, 2, 3)).toBe(0);
  });
});

describe("negBinPmfVector", () => {
  it("agrees with the closed form point by point", () => {
    const v = negBinPmfVector(6, 3, 40);
    for (const k of [0, 1, 5, 12, 25]) {
      expect(v[k]).toBeCloseTo(negBinPmf(k, 6, 3), 12);
    }
  });

  it("sums to 1 and reproduces mean and variance = μ + μ²/phi", () => {
    const { sum, mean, variance } = moments(negBinPmfVector(6, 3, 80));
    expect(sum).toBeCloseTo(1, 8);
    expect(mean).toBeCloseTo(6, 6);
    expect(variance).toBeCloseTo(6 + 36 / 3, 5); // 18
  });

  it("gives Poisson moments (variance = mean) at huge phi", () => {
    const { sum, mean, variance } = moments(negBinPmfVector(6, HUGE_PHI, 80));
    expect(sum).toBeCloseTo(1, 10);
    expect(mean).toBeCloseTo(6, 8);
    expect(variance).toBeCloseTo(6, 6);
  });

  it("is overdispersed relative to Poisson — fatter tails", () => {
    const nb = negBinPmfVector(10, 5, 80);
    const po = negBinPmfVector(10, HUGE_PHI, 80);
    expect(tailFromPmf(nb, 18)).toBeGreaterThan(tailFromPmf(po, 18));
  });
});

describe("negBinAtLeast", () => {
  it("agrees with the tail of its own pmf", () => {
    const v = negBinPmfVector(9, 4, 80);
    for (const k of [1, 5, 9, 14]) {
      expect(negBinAtLeast(k, 9, 4)).toBeCloseTo(tailFromPmf(v, k), 8);
    }
  });

  it("matches poissonAtLeast as phi → ∞", () => {
    for (const k of [1, 3, 8, 15]) {
      expect(negBinAtLeast(k, 8, HUGE_PHI)).toBeCloseTo(poissonAtLeast(k, 8), 8);
    }
  });

  it("is 1 at or below k = 0 and decreasing in k", () => {
    expect(negBinAtLeast(0, 5, 2)).toBe(1);
    expect(negBinAtLeast(3, 5, 2)).toBeGreaterThan(negBinAtLeast(4, 5, 2));
  });
});

describe("convolvePmf", () => {
  it("convolves two coin flips into [¼, ½, ¼]", () => {
    const c = convolvePmf([0.5, 0.5], [0.5, 0.5], 4);
    expect(c[0]).toBeCloseTo(0.25, 12);
    expect(c[1]).toBeCloseTo(0.5, 12);
    expect(c[2]).toBeCloseTo(0.25, 12);
    expect(c[3]).toBeCloseTo(0, 12);
  });

  it("preserves total mass and adds the means at realistic dispersion", () => {
    // phi 20 vid μ ≈ 10 ⇒ Var ≈ 15, ungefär vad lagskott faktiskt uppvisar.
    const total = convolvePmf(negBinPmfVector(11, 20, 80), negBinPmfVector(9, 20, 80), 80);
    const { sum, mean } = moments(total);
    expect(sum).toBeCloseTo(1, 9);
    expect(mean).toBeCloseTo(20, 8);
  });

  it("loses only negligible mass to truncation on a heavy tail", () => {
    // phi 4 är kraftigt överdispergerat; svansen bortom MAX_COUNT bär då mätbar
    // men försumbar massa. Dokumenterar gränsen snarare än döljer den.
    const total = convolvePmf(negBinPmfVector(11, 4, 80), negBinPmfVector(9, 4, 80), 80);
    const { sum } = moments(total);
    expect(1 - sum).toBeLessThan(1e-4);
    expect(1 - sum).toBeGreaterThan(0);
  });

  it("sums two Poissons into a Poisson of the summed rate", () => {
    const total = convolvePmf(
      negBinPmfVector(4, HUGE_PHI, 80),
      negBinPmfVector(6, HUGE_PHI, 80),
      80
    );
    const direct = negBinPmfVector(10, HUGE_PHI, 80);
    for (const k of [0, 5, 10, 20]) expect(total[k]).toBeCloseTo(direct[k], 8);
  });
});

describe("correlatedTotalPmf", () => {
  it("matches the independent convolution at rho = 0", () => {
    const corr = correlatedTotalPmf(11, 9, 20, 0);
    const indep = convolvePmf(negBinPmfVector(11, 20), negBinPmfVector(9, 20));
    expect(moments(corr).mean).toBeCloseTo(moments(indep).mean, 4);
    expect(moments(corr).variance).toBeCloseTo(moments(indep).variance, 3);
  });

  it("keeps the mean whatever rho is — correlation moves spread, not level", () => {
    for (const rho of [-0.6, -0.33, 0, 0.4]) {
      expect(moments(correlatedTotalPmf(11, 9, 20, rho)).mean).toBeCloseTo(20, 4);
    }
  });

  it("narrows the total at the measured negative correlation", () => {
    const indep = moments(correlatedTotalPmf(11, 9, 20, 0)).variance;
    const real = moments(correlatedTotalPmf(11, 9, 20, -0.33)).variance;
    expect(real).toBeLessThan(indep);
    // Var = Vh + Va + 2ρ√(Vh·Va) — kontrollera mot formeln.
    const vh = negBinVariance(11, 20);
    const va = negBinVariance(9, 20);
    expect(real).toBeCloseTo(vh + va + 2 * -0.33 * Math.sqrt(vh * va), 2);
  });

  it("widens it at positive correlation", () => {
    expect(moments(correlatedTotalPmf(11, 9, 20, 0.4)).variance).toBeGreaterThan(
      moments(correlatedTotalPmf(11, 9, 20, 0)).variance
    );
  });

  it("falls back to Poisson when the correlation implies underdispersion", () => {
    // Kraftigt negativ korrelation kan pressa variansen under medelvärdet,
    // vilket en negativ binomial inte kan representera.
    const m = moments(correlatedTotalPmf(6, 5, 200, -0.9));
    expect(m.variance).toBeCloseTo(11, 4); // Poisson: Var = medel
    expect(m.mean).toBeCloseTo(11, 4);
  });

  it("shifts the tail — the practical consequence for a high line", () => {
    const indep = correlatedTotalPmf(14.6, 12.6, 17.7, 0);
    const real = correlatedTotalPmf(14.6, 12.6, 17.7, -0.33);
    // Smalare fördelning ⇒ mindre massa långt ut.
    expect(tailFromPmf(real, 38)).toBeLessThan(tailFromPmf(indep, 38));
  });
});

describe("fitCalibration / applyCalibration", () => {
  /** Genererar utfall från en SANN sannolikhet, deterministiskt. */
  function samples(trueFrom: (p: number) => number, n = 4000) {
    const out: Array<{ p: number; hit: number }> = [];
    for (let i = 0; i < n; i++) {
      // Sprid modellens påståenden jämnt över skalan.
      const p = 0.02 + (0.96 * (i % 100)) / 99;
      const truth = trueFrom(p);
      // Deterministiskt "utfall": andelen träffar matchar sanningen exakt.
      out.push({ p, hit: (i / n) % 1 < truth ? 1 : 0 });
    }
    return out;
  }

  it("leaves a well-calibrated model alone: b ≈ 1, a ≈ 0", () => {
    const cal = fitCalibration(samples((p) => p));
    expect(cal.b).toBeCloseTo(1, 1);
    expect(cal.a).toBeCloseTo(0, 1);
  });

  it("detects overconfidence with b < 1", () => {
    // Sanningen är dragen mot 50 % — modellen påstår mer än den vet.
    const cal = fitCalibration(samples((p) => 0.5 + 0.6 * (p - 0.5)));
    expect(cal.b).toBeLessThan(0.95);
  });

  it("pulls extreme probabilities toward 50 % when b < 1", () => {
    const cal = { a: 0, b: 0.6, n: 1000 };
    expect(applyCalibration(0.9, cal)).toBeLessThan(0.9);
    expect(applyCalibration(0.9, cal)).toBeGreaterThan(0.5);
    expect(applyCalibration(0.1, cal)).toBeGreaterThan(0.1);
    expect(applyCalibration(0.5, cal)).toBeCloseTo(0.5, 10);
  });

  it("is monotone and symmetric around 50 %", () => {
    const cal = { a: 0, b: 0.7, n: 1000 };
    const ps = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => applyCalibration(p, cal));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    expect(applyCalibration(0.8, cal) + applyCalibration(0.2, cal)).toBeCloseTo(1, 10);
  });

  it("stays the identity below the minimum sample", () => {
    const cal = fitCalibration([{ p: 0.9, hit: 0 }], 200);
    expect(cal.n).toBeLessThan(200);
    expect(applyCalibration(0.9, cal)).toBeCloseTo(0.9, 10);
  });

  it("clamps b to a sane range so noise cannot invert the model", () => {
    const wild = Array.from({ length: 1000 }, (_, i) => ({ p: i % 2 ? 0.95 : 0.05, hit: i % 2 ? 0 : 1 }));
    const cal = fitCalibration(wild);
    expect(cal.b).toBeGreaterThanOrEqual(0.2);
    expect(cal.b).toBeLessThanOrEqual(1.5);
  });
});

describe("negBinVariance", () => {
  it("is μ + μ²/φ, and μ for Poisson", () => {
    expect(negBinVariance(10, 5)).toBeCloseTo(10 + 100 / 5, 10);
    expect(negBinVariance(10, Infinity)).toBeCloseTo(10, 10);
  });
});

describe("fitDispersion", () => {
  it("recovers phi from the Pearson moment estimator", () => {
    // expected 1 each, obs [0,0,3,1] → χ² = 1+1+4+0 = 6, n = 4, Σμ = 4
    // phi = Σμ / (χ² − n) = 4 / 2 = 2
    const samples = [0, 0, 3, 1].map((observed) => ({ observed, expected: 1 }));
    expect(fitDispersion(samples)).toBeCloseTo(2, 10);
  });

  it("returns Infinity when the data is not overdispersed", () => {
    const perfect = [3, 3, 3, 3].map((observed) => ({ observed, expected: 3 }));
    expect(fitDispersion(perfect)).toBe(Infinity);
  });

  it("needs at least two usable samples", () => {
    expect(fitDispersion([{ observed: 5, expected: 2 }])).toBe(Infinity);
    expect(fitDispersion([])).toBe(Infinity);
  });
});

describe("fitDispersionFromCounts", () => {
  it("uses Var/mean: mean 2, sample var 16/3 → phi = 1.2", () => {
    expect(fitDispersionFromCounts([0, 4, 0, 4])).toBeCloseTo(1.2, 10);
  });

  it("returns Infinity when variance ≤ mean", () => {
    expect(fitDispersionFromCounts([2, 2, 2, 2])).toBe(Infinity);
  });
});

// --- Ratings ---------------------------------------------------------------

/**
 * Dubbelmöte alla-mot-alla där varje lag producerar exakt ligasnittet:
 * 4 lag, 12 matcher, 6 observationer per lag (3 hemma, 3 borta).
 */
function symmetricObs(): TeamMatchObs[] {
  const teams = ["a", "b", "c", "d"];
  const obs: TeamMatchObs[] = [];
  let t = 0;
  for (const home of teams) {
    for (const away of teams) {
      if (home === away) continue;
      t += 86_400_000;
      obs.push({ teamId: home, opponentId: away, isHome: true, kickoffAt: t, produced: 12, conceded: 10 });
      obs.push({ teamId: away, opponentId: home, isHome: false, kickoffAt: t, produced: 10, conceded: 12 });
    }
  }
  return obs;
}

const BASE: LeagueBaseline = { homeMean: 12, awayMean: 10, matches: 20 };

describe("leagueBaseline", () => {
  it("splits the mean by venue", () => {
    const b = leagueBaseline(symmetricObs());
    expect(b?.homeMean).toBeCloseTo(12, 10);
    expect(b?.awayMean).toBeCloseTo(10, 10);
  });

  it("is null without both home and away observations", () => {
    const homeOnly = symmetricObs().filter((o) => o.isHome);
    expect(leagueBaseline(homeOnly)).toBeNull();
  });
});

describe("computeRatings", () => {
  it("gives every team exactly 1.0 in a perfectly average league", () => {
    const r = computeRatings(symmetricObs(), BASE);
    for (const rating of r.values()) {
      expect(rating.attack).toBeCloseTo(1, 10);
      expect(rating.defence).toBeCloseTo(1, 10);
    }
  });

  it("applies shrinkage toward 1.0: one double-volume match → (2+k)/(1+k)", () => {
    // A hemma producerar 24 (2× μ_hemma) och släpper in 10 (= μ_borta).
    const obs: TeamMatchObs[] = [
      { teamId: "a", opponentId: "b", isHome: true, kickoffAt: 1000, produced: 24, conceded: 10 },
      { teamId: "b", opponentId: "a", isHome: false, kickoffAt: 1000, produced: 10, conceded: 24 },
    ];
    const r = computeRatings(obs, BASE, { iterations: 1, shrinkK: 6 });
    expect(r.get("a")!.attack).toBeCloseTo(8 / 7, 10); // (2 + 6) / (1 + 6)
    expect(r.get("a")!.defence).toBeCloseTo(1, 10); // (1 + 6) / (1 + 6)
    expect(r.get("b")!.attack).toBeCloseTo(1, 10);
    expect(r.get("b")!.defence).toBeCloseTo(8 / 7, 10); // släppte in 2× μ_hemma
  });

  it("weights recent matches more: half-life 1 → weights 1 and ½", () => {
    // Senaste matchen 2× snittet, den äldre exakt snittet.
    const obs: TeamMatchObs[] = [
      { teamId: "a", opponentId: "b", isHome: true, kickoffAt: 2000, produced: 24, conceded: 10 },
      { teamId: "a", opponentId: "c", isHome: true, kickoffAt: 1000, produced: 12, conceded: 10 },
    ];
    const r = computeRatings(obs, BASE, { iterations: 1, shrinkK: 6, halfLife: 1 });
    // täljare = 1·2 + 0.5·1 = 2.5, Σw = 1.5 → (2.5 + 6) / (1.5 + 6)
    expect(r.get("a")!.attack).toBeCloseTo(8.5 / 7.5, 10);
    expect(r.get("a")!.weight).toBeCloseTo(1.5, 10);
  });

  it("ignores matches at or after asOf — no leakage into a backtest", () => {
    const obs: TeamMatchObs[] = [
      { teamId: "a", opponentId: "b", isHome: true, kickoffAt: 1000, produced: 24, conceded: 10 },
      { teamId: "a", opponentId: "c", isHome: true, kickoffAt: 5000, produced: 0, conceded: 10 },
    ];
    const r = computeRatings(obs, BASE, { iterations: 1, shrinkK: 6, asOf: 5000 });
    expect(r.get("a")!.matches).toBe(1);
    expect(r.get("a")!.attack).toBeCloseTo(8 / 7, 10); // bara den första matchen räknas
  });

  it("rates a high-volume team above the league and its opponents below", () => {
    // "a" skjuter dubbelt så mycket som snittet i alla sina matcher; motståndarna
    // släpper följaktligen in dubbelt när de möter "a".
    const boosted = symmetricObs().map((o) =>
      o.teamId === "a"
        ? { ...o, produced: o.produced * 2 }
        : o.opponentId === "a"
          ? { ...o, conceded: o.conceded * 2 }
          : o
    );
    const r = computeRatings(boosted, BASE);
    expect(r.get("a")!.attack).toBeGreaterThan(1.25);
    expect(r.get("b")!.attack).toBeLessThan(r.get("a")!.attack);
    expect(r.get("b")!.defence).toBeGreaterThan(1); // släppte in dubbelt mot "a"
  });

  it("keeps a thin sample close to the league mean — shrinkage does its job", () => {
    // Samma dubbla skottvolym, men efter en enda match i stället för sex.
    const one: TeamMatchObs[] = [
      { teamId: "a", opponentId: "b", isHome: true, kickoffAt: 1000, produced: 24, conceded: 10 },
      { teamId: "b", opponentId: "a", isHome: false, kickoffAt: 1000, produced: 10, conceded: 24 },
    ];
    const thin = computeRatings(one, BASE).get("a")!.attack;
    const boosted = symmetricObs().map((o) =>
      o.teamId === "a"
        ? { ...o, produced: o.produced * 2 }
        : o.opponentId === "a"
          ? { ...o, conceded: o.conceded * 2 }
          : o
    );
    const thick = computeRatings(boosted, BASE).get("a")!.attack;
    expect(thin).toBeLessThan(thick); // en match övertygar inte modellen
    expect(thin).toBeLessThan(1.2);
  });

  it("corrects for schedule strength across iterations", () => {
    // Ett lag som möter ett uselt försvar ska inte behålla hela sin råa volym.
    const obs: TeamMatchObs[] = [
      { teamId: "a", opponentId: "weak", isHome: true, kickoffAt: 1000, produced: 24, conceded: 10 },
      { teamId: "weak", opponentId: "a", isHome: false, kickoffAt: 1000, produced: 10, conceded: 24 },
      { teamId: "weak", opponentId: "c", isHome: true, kickoffAt: 2000, produced: 12, conceded: 24 },
      { teamId: "c", opponentId: "weak", isHome: false, kickoffAt: 2000, produced: 24, conceded: 12 },
    ];
    const one = computeRatings(obs, BASE, { iterations: 1 });
    const many = computeRatings(obs, BASE, { iterations: 6 });
    expect(many.get("a")!.attack).toBeLessThan(one.get("a")!.attack);
  });
});

describe("projectMatch", () => {
  it("returns the league means for two neutral teams", () => {
    const p = projectMatch(null, null, BASE);
    expect(p.home).toBeCloseTo(12, 10);
    expect(p.away).toBeCloseTo(10, 10);
    expect(p.total).toBeCloseTo(22, 10);
  });

  it("multiplies attack by the opponent's defence", () => {
    const home = { teamId: "a", attack: 1.25, defence: 0.8, matches: 10, weight: 8 };
    const away = { teamId: "b", attack: 0.9, defence: 1.5, matches: 10, weight: 8 };
    const p = projectMatch(home, away, BASE);
    expect(p.home).toBeCloseTo(12 * 1.25 * 1.5, 10); // 22.5
    expect(p.away).toBeCloseTo(10 * 0.9 * 0.8, 10); // 7.2
  });
});

describe("lineProbs", () => {
  const pmf = [0.1, 0.2, 0.3, 0.4]; // stöd 0…3

  it("has no push on a half line", () => {
    const r = lineProbs(pmf, 1.5); // över ⇔ X ≥ 2
    expect(r.pOver).toBeCloseTo(0.7, 12);
    expect(r.pUnder).toBeCloseTo(0.3, 12);
    expect(r.pPush).toBe(0);
    expect(r.pOverNoPush).toBeCloseTo(0.7, 12);
  });

  it("pushes on a whole line and prices on the conditional", () => {
    const r = lineProbs(pmf, 2); // push ⇔ X = 2, över ⇔ X ≥ 3
    expect(r.pOver).toBeCloseTo(0.4, 12);
    expect(r.pPush).toBeCloseTo(0.3, 12);
    expect(r.pUnder).toBeCloseTo(0.3, 12);
    expect(r.pOverNoPush).toBeCloseTo(0.4 / 0.7, 12);
  });

  it("keeps the three outcomes summing to 1", () => {
    for (const line of [0.5, 1, 1.5, 2, 2.5, 3]) {
      const r = lineProbs(pmf, line);
      expect(r.pOver + r.pUnder + r.pPush).toBeCloseTo(1, 12);
    }
  });
});

describe("fairOdds", () => {
  it("inverts the probability", () => {
    expect(fairOdds(0.5)).toBeCloseTo(2, 12);
    expect(fairOdds(0.25)).toBeCloseTo(4, 12);
  });
});

describe("marketProbOver", () => {
  it("de-vigs a two-sided market proportionally", () => {
    expect(marketProbOver(2, 2)).toBeCloseTo(0.5, 12);
    // 1/1.8 = 0.5556, book = 1.0556 → 0.5263
    expect(marketProbOver(1.8, 2)).toBeCloseTo(1 / 1.8 / (1 / 1.8 + 1 / 2), 12);
  });

  it("falls back to a one-sided de-vig with the assumed margin", () => {
    expect(marketProbOver(2, null, 6)).toBeCloseTo(0.5 / 1.06, 12);
  });

  it("is null without a usable over price", () => {
    expect(marketProbOver(null, 2)).toBeNull();
    expect(marketProbOver(1, 2)).toBeNull();
  });
});

describe("lambdaFromLineProb", () => {
  it("round-trips: λ → P(över) → λ", () => {
    for (const [lambda, line] of [
      [10, 9.5],
      [10, 12.5],
      [5.5, 4.5],
    ] as const) {
      const p = lineProbs(negBinPmfVector(lambda, 13), line).pOverNoPush;
      expect(lambdaFromLineProb(line, p, negBinFamily(13))!).toBeCloseTo(lambda, 4);
    }
  });

  it("is increasing in the over probability", () => {
    const lo = lambdaFromLineProb(9.5, 0.4, negBinFamily(13))!;
    const hi = lambdaFromLineProb(9.5, 0.6, negBinFamily(13))!;
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("marketConsensus", () => {
  const OPTS = { pmfFor: negBinFamily(13) };

  it("prefers a sharp book when one priced the metric", () => {
    const r = marketConsensus(
      [
        { bookmaker: "bet365", line: 9.5, overOdds: 5, underOdds: 1.2 },
        { bookmaker: "pinnacle", line: 9.5, overOdds: 2, underOdds: 2 },
      ],
      9.5,
      { ...OPTS, preferBooks: ["pinnacle"] }
    )!;
    expect(r.books).toEqual(["pinnacle"]);
    expect(r.p).toBeCloseTo(0.5, 6); // Pinnacle 2.00/2.00 → 0.5 på sin egen linje
    expect(r.twoSided).toBe(true);
  });

  it("pools books that quote DIFFERENT lines, via implied λ", () => {
    // Två böcker på olika linjer men samma implicita λ = 11 ska ge exakt λ 11,
    // och därmed samma P(över) som en enskild bok på λ 11 skulle ge.
    const pA = lineProbs(negBinPmfVector(11, 13), 9.5).pOverNoPush;
    const pB = lineProbs(negBinPmfVector(11, 13), 13.5).pOverNoPush;
    const r = marketConsensus(
      [
        { bookmaker: "bet365", line: 9.5, overOdds: 1 / pA, underOdds: 1 / (1 - pA) },
        { bookmaker: "betmgm-uk", line: 13.5, overOdds: 1 / pB, underOdds: 1 / (1 - pB) },
      ],
      11.5,
      OPTS
    )!;
    expect(r.books).toEqual(["bet365", "betmgm-uk"]);
    expect(r.lambda).toBeCloseTo(11, 3);
    expect(r.p).toBeCloseTo(lineProbs(negBinPmfVector(11, 13), 11.5).pOverNoPush, 4);
  });

  it("averages the implied λ when the books disagree", () => {
    const p10 = lineProbs(negBinPmfVector(10, 13), 9.5).pOverNoPush;
    const p12 = lineProbs(negBinPmfVector(12, 13), 9.5).pOverNoPush;
    const r = marketConsensus(
      [
        { bookmaker: "bet365", line: 9.5, overOdds: 1 / p10, underOdds: 1 / (1 - p10) },
        { bookmaker: "betmgm-uk", line: 9.5, overOdds: 1 / p12, underOdds: 1 / (1 - p12) },
      ],
      9.5,
      OPTS
    )!;
    expect(r.lambda).toBeCloseTo(11, 3);
  });

  it("gives each bookmaker one vote, however many lines it quotes", () => {
    // Paddy Power kvoterar fyra linjer som alla implicerar λ 8; bet365 en som
    // implicerar λ 12. Konsensus ska bli 10, inte (4·8 + 12)/5 = 8,8.
    const q = (bookmaker: string, line: number, lambda: number) => {
      const p = lineProbs(negBinPmfVector(lambda, 13), line).pOverNoPush;
      return { bookmaker, line, overOdds: 1 / p, underOdds: 1 / (1 - p) };
    };
    const r = marketConsensus(
      [
        q("paddy-power", 6.5, 8),
        q("paddy-power", 7.5, 8),
        q("paddy-power", 8.5, 8),
        q("paddy-power", 9.5, 8),
        q("bet365", 11.5, 12),
      ],
      9.5,
      OPTS
    )!;
    expect(r.lambda).toBeCloseTo(10, 2);
    expect(r.books.sort()).toEqual(["bet365", "paddy-power"]);
  });

  it("averages a book's own lines before it votes", () => {
    const q = (bookmaker: string, line: number, lambda: number) => {
      const p = lineProbs(negBinPmfVector(lambda, 13), line).pOverNoPush;
      return { bookmaker, line, overOdds: 1 / p, underOdds: 1 / (1 - p) };
    };
    // bet365 säger 9 på en linje och 11 på en annan → dess röst är 10.
    const r = marketConsensus([q("bet365", 8.5, 9), q("bet365", 10.5, 11)], 9.5, OPTS)!;
    expect(r.lambda).toBeCloseTo(10, 2);
    expect(r.books).toEqual(["bet365"]);
  });

  it("ignores one-sided books when any two-sided price exists", () => {
    const r = marketConsensus(
      [
        { bookmaker: "bet365", line: 9.5, overOdds: 2, underOdds: 2 },
        { bookmaker: "paddy-power", line: 9.5, overOdds: 1.5, underOdds: null },
      ],
      9.5,
      OPTS
    )!;
    expect(r.books).toEqual(["bet365"]);
    expect(r.twoSided).toBe(true);
  });

  it("falls back to one-sided de-vig and flags it as weaker", () => {
    const r = marketConsensus(
      [{ bookmaker: "bet365", line: 9.5, overOdds: 2, underOdds: null }],
      9.5,
      { ...OPTS, marginPct: 6 }
    )!;
    expect(r.twoSided).toBe(false);
    expect(r.p).toBeCloseTo(0.5 / 1.06, 4);
  });

  it("is null when nothing prices the metric", () => {
    expect(marketConsensus([], 9.5, OPTS)).toBeNull();
    expect(
      marketConsensus([{ bookmaker: "bet365", line: 9.5, overOdds: null, underOdds: 2 }], 9.5, OPTS)
    ).toBeNull();
  });
});

describe("blendProb", () => {
  it("is the model at w = 1 and the market at w = 0", () => {
    expect(blendProb(0.6, 0.4, 1)).toBeCloseTo(0.6, 10);
    expect(blendProb(0.6, 0.4, 0)).toBeCloseTo(0.4, 10);
    expect(blendProb(0.6, 0.4, 0.5)).toBeCloseTo(0.5, 10);
  });

  it("moves monotonically toward the model as w rises", () => {
    const ws = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const ps = ws.map((w) => blendProb(0.7, 0.3, w));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
  });

  it("falls back to the model when the market is missing", () => {
    expect(blendProb(0.62, null, 0.35)).toBeCloseTo(0.62, 10);
  });
});

describe("priceLine", () => {
  const baseInput = {
    metric: "corners" as const,
    side: "match" as const,
    line: 9.5,
    lambda: 10,
    dispersion: 12,
  };

  it("prices fair odds consistently with the blended probability", () => {
    const r = priceLine({ ...baseInput, books: [], blendW: 1 });
    expect(r.pMarket).toBeNull();
    expect(r.pFinal).toBeCloseTo(r.pModel, 12);
    expect(r.fairOverOdds * r.pFinal).toBeCloseTo(1, 10);
    expect(r.fairUnderOdds * (1 - r.pFinal)).toBeCloseTo(1, 10);
  });

  it("shows no edge against a book priced exactly at fair", () => {
    const pure = priceLine({ ...baseInput, books: [], blendW: 1 });
    const r = priceLine({
      ...baseInput,
      blendW: 1,
      books: [
        {
          bookmaker: "bet365",
          overOdds: 1 / pure.pFinal,
          underOdds: 1 / (1 - pure.pFinal),
        },
      ],
    });
    expect(r.edge).toBeCloseTo(0, 9);
  });

  it("takes the over and reports a positive edge on a generous over price", () => {
    const pure = priceLine({ ...baseInput, books: [], blendW: 1 });
    const generous = (1 / pure.pFinal) * 1.1; // 10 % över fair
    const r = priceLine({
      ...baseInput,
      blendW: 1,
      books: [{ bookmaker: "bet365", overOdds: generous, underOdds: 1.2 }],
    });
    expect(r.bestSide).toBe("over");
    expect(r.bestBook).toBe("bet365");
    expect(r.edge).toBeCloseTo(0.1, 6);
  });

  it("takes the under when that is the value side", () => {
    const pure = priceLine({ ...baseInput, books: [], blendW: 1 });
    const generousUnder = (1 / (1 - pure.pFinal)) * 1.15;
    const r = priceLine({
      ...baseInput,
      blendW: 1,
      books: [{ bookmaker: "bet365", overOdds: 1.05, underOdds: generousUnder }],
    });
    expect(r.bestSide).toBe("under");
    expect(r.edge).toBeCloseTo(0.15, 6);
  });

  it("uses the sharp book as the market reference, in priority order", () => {
    const r = priceLine({
      ...baseInput,
      blendW: 0,
      books: [
        { bookmaker: "bet365", overOdds: 5, underOdds: 1.2 },
        { bookmaker: "pinnacle", overOdds: 2, underOdds: 2 },
      ],
    });
    // blendW 0 ⇒ pFinal är rent marknadens, och Pinnacle 2.0/2.0 avviggar till 0.5
    expect(r.pMarket).toBeCloseTo(0.5, 10);
    expect(r.pFinal).toBeCloseTo(0.5, 10);
    // Bästa över-priset är ändå bet365 5.00 → edge = 5·0.5 − 1 = 1.5
    expect(r.bestBook).toBe("bet365");
    expect(r.edge).toBeCloseTo(1.5, 10);
  });

  it("prefers the exchange over Pinnacle as the sharp reference", () => {
    const r = priceLine({
      ...baseInput,
      blendW: 0,
      books: [
        { bookmaker: "pinnacle", overOdds: 2, underOdds: 2 },
        { bookmaker: "betfair-exchange", overOdds: 4, underOdds: 4 / 3 },
      ],
    });
    expect(r.pMarket).toBeCloseTo(0.25, 10); // börsen, inte Pinnacle
  });

  it("reports the push probability on a whole line", () => {
    const r = priceLine({ ...baseInput, line: 10, books: [], blendW: 1 });
    expect(r.pPush).toBeGreaterThan(0);
    expect(r.pPush).toBeCloseTo(negBinPmf(10, 10, 12), 10);
  });

  it("prices on an explicit pmf when one is given", () => {
    // Matchtotalen: två lag à λ 5, faltade. Att bara summera λ och behandla
    // summan som EN negativ binomial ger en annan — och felaktig — fördelning.
    const convolved = convolvePmf(negBinPmfVector(5, 12), negBinPmfVector(5, 12));
    const exact = priceLine({ ...baseInput, lambda: 10, books: [], blendW: 1, pmf: convolved });
    const naive = priceLine({ ...baseInput, lambda: 10, books: [], blendW: 1 });
    expect(exact.pModel).not.toBeCloseTo(naive.pModel, 4);
  });

  it("the convolution is narrower than one negative binomial of the same mean", () => {
    // Var(NB(5,12)) = 5 + 25/12 ≈ 7.08 per lag → 14.17 för summan,
    // mot Var(NB(10,12)) = 10 + 100/12 ≈ 18.33 för den naiva varianten.
    const convolved = convolvePmf(negBinPmfVector(5, 12), negBinPmfVector(5, 12));
    const single = negBinPmfVector(10, 12);
    expect(moments(convolved).mean).toBeCloseTo(moments(single).mean, 6);
    expect(moments(convolved).variance).toBeCloseTo(2 * (5 + 25 / 12), 5);
    expect(moments(convolved).variance).toBeLessThan(moments(single).variance);
  });

  it("gives the narrower distribution less mass far out in the tail", () => {
    const convolved = convolvePmf(negBinPmfVector(5, 12), negBinPmfVector(5, 12));
    const far = { ...baseInput, lambda: 10, line: 16.5, books: [], blendW: 1 };
    const exact = priceLine({ ...far, pmf: convolved });
    const naive = priceLine(far);
    expect(exact.pModel).toBeLessThan(naive.pModel);
  });

  it("has no best price and zero edge without any book", () => {
    const r = priceLine({ ...baseInput, books: [] });
    expect(r.bestBook).toBeNull();
    expect(r.bestSide).toBeNull();
    expect(r.bestOdds).toBeNull();
    expect(r.edge).toBe(0);
  });
});
