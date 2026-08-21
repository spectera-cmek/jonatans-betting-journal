import { describe, it, expect } from "vitest";
import {
  buildLeagueModel,
  metricValues,
  observationsFor,
  sourceValues,
  projectFixture,
  type ShotMatchRow,
} from "../lib/shotData";

/**
 * Dubbelmöte alla-mot-alla: 4 lag, 12 matcher. Alla producerar exakt
 * ligasnittet — hörnor 5/4, skott 14/12, xG 1,4/1,1 — om inget annat sägs.
 */
function league(overrides: (row: ShotMatchRow, home: string, away: string) => void = () => {}): ShotMatchRow[] {
  const teams = ["a", "b", "c", "d"];
  const rows: ShotMatchRow[] = [];
  let t = Date.UTC(2026, 0, 1);
  for (const home of teams) {
    for (const away of teams) {
      if (home === away) continue;
      t += 86_400_000;
      const row: ShotMatchRow = {
        id: `${home}-${away}`,
        kickoffAt: new Date(t),
        homeTeamId: home,
        awayTeamId: away,
        homeCorners: 5,
        awayCorners: 4,
        homeShots: 14,
        awayShots: 12,
        homeSot: 5,
        awaySot: 4,
        homeXg: 1.4,
        awayXg: 1.1,
      };
      overrides(row, home, away);
      rows.push(row);
    }
  }
  return rows;
}

describe("sourceValues", () => {
  const [row] = league();

  it("reads every signal, including xG", () => {
    expect(sourceValues(row, "corners")).toEqual({ home: 5, away: 4 });
    expect(sourceValues(row, "shots")).toEqual({ home: 14, away: 12 });
    expect(sourceValues(row, "sot")).toEqual({ home: 5, away: 4 });
    expect(sourceValues(row, "xg")).toEqual({ home: 1.4, away: 1.1 });
  });

  it("is null when a signal was never ingested", () => {
    expect(sourceValues({ ...row, homeXg: null }, "xg")).toBeNull();
    expect(metricValues({ ...row, awayCorners: null }, "corners")).toBeNull();
  });
});

describe("observationsFor", () => {
  it("emits two observations per match, mirrored", () => {
    const obs = observationsFor(league().slice(0, 1), "corners");
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({ isHome: true, produced: 5, conceded: 4 });
    expect(obs[1]).toMatchObject({ isHome: false, produced: 4, conceded: 5 });
  });
});

describe("buildLeagueModel", () => {
  it("takes the baseline from the target metric, not the signals", () => {
    // Ratingen får låna styrka från skott, men μ ska vara hörnornas.
    const m = buildLeagueModel(league(), "corners", { signalWeights: { corners: 1, shots: 1 } })!;
    expect(m.baseline.homeMean).toBeCloseTo(5, 10);
    expect(m.baseline.awayMean).toBeCloseTo(4, 10);
  });

  it("rates a perfectly average league at 1.0 whatever the signal mix", () => {
    for (const signalWeights of [undefined, { corners: 1, shots: 1 }, { corners: 1, shots: 1, sot: 1, xg: 1 }]) {
      const m = buildLeagueModel(league(), "corners", { signalWeights })!;
      for (const r of m.ratings.values()) {
        expect(r.attack).toBeCloseTo(1, 6);
        expect(r.defence).toBeCloseTo(1, 6);
      }
    }
  });

  it("ignores other signals when the mix is the metric alone", () => {
    // "a" skjuter dubbelt men tar exakt snittet i hörnor.
    const rows = league((row, home) => {
      if (home === "a") row.homeShots = 28;
      if (row.awayTeamId === "a") row.awayShots = 24;
    });
    const m = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1 } })!;
    expect(m.ratings.get("a")!.attack).toBeCloseTo(1, 6);
  });

  it("lets a strong shot signal lift the corner rating", () => {
    const rows = league((row, home) => {
      if (home === "a") row.homeShots = 28;
      if (row.awayTeamId === "a") row.awayShots = 24;
    });
    const cornersOnly = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1 } })!;
    const withShots = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1, shots: 1 } })!;
    expect(withShots.ratings.get("a")!.attack).toBeGreaterThan(cornersOnly.ratings.get("a")!.attack);
  });

  it("blends geometrically: equal weights on 1.0 and R give √R", () => {
    const rows = league((row, home) => {
      if (home === "a") row.homeShots = 28;
      if (row.awayTeamId === "a") row.awayShots = 24;
    });
    const shotsRating = buildLeagueModel(rows, "shots", { signalWeights: { shots: 1 } })!.ratings.get("a")!.attack;
    const cornersRating = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1 } })!.ratings.get("a")!
      .attack;
    const blended = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1, shots: 1 } })!.ratings.get("a")!
      .attack;
    expect(blended).toBeCloseTo(Math.sqrt(cornersRating * shotsRating), 6);
  });

  it("honours the weights — a heavier signal pulls harder", () => {
    const rows = league((row, home) => {
      if (home === "a") row.homeShots = 28;
      if (row.awayTeamId === "a") row.awayShots = 24;
    });
    const even = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1, shots: 1 } })!;
    const shotHeavy = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1, shots: 3 } })!;
    expect(shotHeavy.ratings.get("a")!.attack).toBeGreaterThan(even.ratings.get("a")!.attack);
  });

  it("skips a signal the league never recorded", () => {
    const rows = league().map((r) => ({ ...r, homeXg: null, awayXg: null }));
    const m = buildLeagueModel(rows, "corners", { signalWeights: { corners: 1, xg: 1 } });
    expect(m).not.toBeNull();
    expect(m!.ratings.get("a")!.attack).toBeCloseTo(1, 6);
  });

  it("is null without enough usable rows", () => {
    expect(buildLeagueModel([], "corners")).toBeNull();
    expect(buildLeagueModel(league().slice(0, 1), "corners")).toBeNull();
  });
});

describe("projectFixture", () => {
  it("returns the league means for an average fixture", () => {
    const m = buildLeagueModel(league(), "corners")!;
    const p = projectFixture(m, "a", "b");
    expect(p.home).toBeCloseTo(5, 4);
    expect(p.away).toBeCloseTo(4, 4);
    expect(p.total).toBeCloseTo(9, 4);
  });

  it("falls back to the league mean for an unknown team", () => {
    const m = buildLeagueModel(league(), "corners")!;
    const p = projectFixture(m, "nykomling", "annan-nykomling");
    expect(p.home).toBeCloseTo(5, 10);
    expect(p.away).toBeCloseTo(4, 10);
  });
});
