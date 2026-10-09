import { describe, it, expect } from "vitest";
import { lineupChange, type LineupMapRow } from "../lib/cs2/lineup";
import { matchLineups } from "../lib/cs2/matchup";

// Tio kartor med samma femma; spelare 1 är stjärnan (25 kills per karta).
function rows(players: number[], maps = 10): LineupMapRow[] {
  const out: LineupMapRow[] = [];
  for (let m = 0; m < maps; m++)
    for (const p of players) out.push({ mapId: m, playedAt: new Date(2026, 9, 1 + m), playerId: p, nickname: `p${p}`, kills: p === 1 ? 25 : 15 });
  return out;
}
const lineup = (ids: number[]) => ids.map((id) => ({ playerId: id, nickname: `p${id}` }));

describe("laguppställning", () => {
  it("ingen ändring → ingen varning", () => {
    expect(lineupChange(7, rows([1, 2, 3, 4, 5]), lineup([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("saknad stjärna med kill-andel och stand-in utan historik", () => {
    const c = lineupChange(7, rows([1, 2, 3, 4, 5]), lineup([9, 2, 3, 4, 5]))!;
    expect(c.out).toHaveLength(1);
    expect(c.out[0].playerId).toBe(1);
    expect(c.out[0].killShare).toBeCloseTo(25 / 85, 5);
    expect(c.in).toEqual([{ playerId: 9, nickname: "p9", mapsWithTeam: 0 }]);
    expect(c.basis).toBe(10);
  });

  it("truppen (inte matchens uppställning) rapporterar inte nya spelare", () => {
    const c = lineupChange(7, rows([1, 2, 3, 4, 5]), lineup([2, 3, 4, 5, 6]), { reportNew: false })!;
    expect(c.out.map((p) => p.playerId)).toEqual([1]);
    expect(c.in).toEqual([]);
    expect(lineupChange(7, rows([1, 2, 3, 4, 5]), lineup([1, 2, 3, 4, 5, 6]), { reportNew: false })).toBeNull();
  });

  it("för lite historik → ingen bedömning", () => {
    expect(lineupChange(7, rows([1, 2, 3, 4, 5], 2), lineup([9, 2, 3, 4, 5]))).toBeNull();
  });

  it("läser matchsidans uppställningar bara när båda lagen har fem spelare", () => {
    const five = (base: number) => [0, 1, 2, 3, 4].map((i) => ({ id: base + i, nickname: `n${base + i}` }));
    const raw = [{ teamId: 10, players: five(100) }, { teamId: 20, players: five(200) }];
    expect(matchLineups(raw, [10, 20])!.map((l) => l.players[0].id)).toEqual([100, 200]);
    expect(matchLineups([raw[0]], [10, 20])).toBeNull();
    expect(matchLineups([raw[0], { teamId: 20, players: five(200).slice(0, 3) }], [10, 20])).toBeNull();
    expect(matchLineups(null, [10, 20])).toBeNull();
  });
});
