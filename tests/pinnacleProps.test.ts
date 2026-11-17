import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parsePinnacleProps, pinPropPlayer, type PinPropMarket, type PinPropMatchup } from "../lib/nba/pinnacleProps";

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pinnacle-props.json"), "utf8")) as {
  matchups: PinPropMatchup[];
  markets: PinPropMarket[];
};

describe("Pinnacles spelarprops (arcadia)", () => {
  it("läser spelarnamnet ur beskrivningen", () => {
    expect(pinPropPlayer("Kyle Kuzma Total Rebounds")).toBe("Kyle Kuzma");
    expect(pinPropPlayer("Anthony Davis Total Pts & Rebs & Asts")).toBe("Anthony Davis");
    expect(pinPropPlayer("Winning Margin Range")).toBeNull();
  });

  it("tolkar props med stat, linje, decimalodds och maxinsats — och hoppar över annat", () => {
    const lines = parsePinnacleProps(fx.matchups, fx.markets);
    expect(lines.map((l) => [l.playerName, l.stat, l.line])).toEqual([
      ["Bam Adebayo", "pts", 17.5],
      ["Aaron Gordon", "fg3", 1.5],
      ["Anthony Davis", "pra", 36.5],
    ]);
    const bam = lines[0];
    // −119 → 1,840, −111 → 1,901
    expect(bam.over).toBeCloseTo(1 + 100 / 119, 3);
    expect(bam.under).toBeCloseTo(1 + 100 / 111, 3);
    expect(bam.maxStake).toBeGreaterThan(0);
    expect(bam.home).toBeTruthy();
    expect(bam.away).toBeTruthy();
    expect(Number.isFinite(bam.start)).toBe(true);
  });

  it("stängda marknader och liveprops räknas inte", () => {
    const closed = fx.markets.map((k) => ({ ...k, status: "closed" }));
    expect(parsePinnacleProps(fx.matchups, closed)).toHaveLength(0);
    const live = fx.matchups.map((m) => ({ ...m, isLive: true }));
    expect(parsePinnacleProps(live, fx.markets)).toHaveLength(0);
  });
});
