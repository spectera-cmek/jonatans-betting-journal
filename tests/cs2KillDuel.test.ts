import { describe, it, expect } from "vitest";
import { killDuelProbs } from "../lib/cs2/killModel";
import { mapDistribution, type MapInputs } from "../lib/cs2/mapModel";
import { projectionActual, overResult } from "../lib/cs2/settle";
import { validateLine } from "../lib/cs2/lineInput";
import { matchPlayer, skipReason } from "../lib/cs2/propsMatch";

const even: MapInputs = { pCtA: 0.53, pCtB: 0.53, pistolCtA: 0.5, pistolCtB: 0.5, conv2: 0.8, conv3: 0.7, pAStartsCt: 0.5, sigma: 0.3 };
const rates = (kw: number, kl: number) => ({ kw, kl, hs: 0.45, rounds: 500 });

describe("killDuelProbs", () => {
  const d = mapDistribution(even);

  it("lika spelare: hälften var efter push", () => {
    const r = killDuelProbs({ rates: rates(0.9, 0.4), side: 1 }, { rates: rates(0.9, 0.4), side: 1 }, d, true);
    expect(r.pPush).toBeGreaterThan(0.03);
    expect(r.pWin).toBeCloseTo((1 - r.pPush) / 2, 5);
  });

  it("bättre spelare vinner oftare, handikapp ändrar det", () => {
    const strong = { rates: rates(1.1, 0.5), side: 1 as const };
    const weak = { rates: rates(0.8, 0.35), side: 2 as const };
    const base = killDuelProbs(strong, weak, d, true);
    expect(base.pWin).toBeGreaterThan(1 - base.pWin - base.pPush);
    // Halv linje: ingen push. -1.5 gör det svårare, +1.5 lättare.
    const minus = killDuelProbs(strong, weak, d, true, -1.5);
    const plus = killDuelProbs(strong, weak, d, true, 1.5);
    expect(minus.pPush).toBe(0);
    expect(minus.pWin).toBeLessThan(base.pWin);
    expect(plus.pWin).toBeGreaterThan(base.pWin + base.pPush);
  });

  it("samma kartförlopp: motståndare drar åt var sitt håll", () => {
    // Två identiska spelare i olika lag på en jämn karta — symmetriskt.
    const a = killDuelProbs({ rates: rates(0.9, 0.4), side: 1 }, { rates: rates(0.9, 0.4), side: 2 }, d, true);
    const b = killDuelProbs({ rates: rates(0.9, 0.4), side: 2 }, { rates: rates(0.9, 0.4), side: 1 }, d, true);
    expect(a.pWin).toBeCloseTo(b.pWin, 5);
    expect(a.pWin + a.pPush + b.pWin).toBeCloseTo(1, 5);
  });
});

describe("killduell i facit", () => {
  const match = {
    status: "finished",
    team1Id: 10,
    team2Id: 20,
    winnerId: 10,
    maps: [
      {
        mapNumber: 1,
        team1Id: 10,
        team1Rounds: 13,
        team2Rounds: 9,
        winnerId: 10,
        roundHistory: [],
        stats: [
          { playerId: 1, side: "all", kills: 20, headshots: 9 },
          { playerId: 2, side: "all", kills: 17, headshots: 6 },
          { playerId: 3, side: "all", kills: 20, headshots: 8 },
        ],
      },
    ],
  };
  const duel = (playerId: number, player2Id: number, scope = "map1", line: number | null = null) => ({ market: "kill_duel", scope, playerId, player2Id, teamId: null, line });

  it("skillnaden i kills avgör, lika är push", () => {
    expect(projectionActual(duel(1, 2), match)).toBe(3);
    expect(overResult("kill_duel", null, 3)).toBe(1);
    expect(projectionActual(duel(2, 1), match)).toBe(-3);
    expect(overResult("kill_duel", null, -3)).toBe(0);
    expect(projectionActual(duel(1, 3), match)).toBe(0);
    expect(overResult("kill_duel", null, 0)).toBe(0.5);
    expect(projectionActual(duel(1, 2, "map1", -3.5), match)).toBe(-0.5);
  });

  it("saknad spelare eller ospelad karta avgörs inte än", () => {
    expect(projectionActual(duel(1, 99), match)).toBeUndefined();
    expect(projectionActual(duel(1, 2, "map2"), match)).toBeUndefined();
  });
});

describe("killduell: validering och skärmdump", () => {
  const base = { matchId: 1, market: "kill_duel", scope: "map1", playerId: 101, player2Id: 201, overOdds: 1.8, underOdds: 2.0 };

  it("kräver två olika spelare på en karta", () => {
    const ok = validateLine(base);
    expect(typeof ok === "string" ? ok : ok.player2Id).toBe(201);
    expect(validateLine({ ...base, player2Id: null })).toBe("Duellen kräver två spelare");
    expect(validateLine({ ...base, player2Id: 101 })).toBe("Duellen kräver två olika spelare");
    expect(validateLine({ ...base, scope: "maps12" })).toBe("Duellen gäller en karta");
    // Andra marknader sparar aldrig spelare 2.
    const kills = validateLine({ ...base, market: "kills", line: 18.5 });
    expect(typeof kills === "string" ? kills : kills.player2Id).toBeNull();
  });

  it("nickarna från Betssons och Coolbets duellrutor kopplas till trupperna", () => {
    const squad = ["donk", "zont1x", "sh1ro", "magixx", "tN1R", "XANTARES", "woxic", "Wicadia", "Jimpphat", "kyxsan"].map((nickname, i) => ({ id: i + 1, nickname }));
    expect(matchPlayer("Zont1X", squad)).toBe(2);
    expect(matchPlayer("tN1R", squad)).toBe(5);
    expect(matchPlayer("Wicadia", squad)).toBe(8);
    expect(matchPlayer("sh1ro", squad)).toBe(3);
  });

  it("skärmdumpsraden kräver båda spelarna", () => {
    const row = { market: "kill_duel", scope: "map1", playerId: 1, player2Id: 2, teamId: null, line: null, overOdds: 1.8, underOdds: 2 };
    expect(skipReason(row)).toBeNull();
    expect(skipReason({ ...row, player2Id: null })).toBe("spelare 2 hittades inte i trupperna");
    expect(skipReason({ ...row, player2Id: 1 })).toBe("samma spelare på båda sidor");
    expect(skipReason({ ...row, scope: "match" })).toBe("duellen gäller bara en karta");
  });
});
