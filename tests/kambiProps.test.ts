import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { kambiPropStat, parseKambiProps } from "../lib/nba/kambiProps";

// Riktigt svar från Kambi (Unibet SE, Pistons–76ers 2026-11-05).
const fx = JSON.parse(fs.readFileSync("tests/fixtures/kambi-props.json", "utf8"));

describe("Kambi-props", () => {
  it("känner igen Kambis kriterier, men inte trappstegsmarknader eller kombinationer", () => {
    expect(kambiPropStat("Points scored by the player - Including Overtime")).toBe("pts");
    expect(kambiPropStat("3-point field goals made by the player - Including Overtime")).toBe("fg3");
    expect(kambiPropStat("Points, rebounds & assists by the player - Including Overtime")).toBe("pra");
    expect(kambiPropStat("10+ Points Scored By The Player - Including Overtime")).toBeNull();
    expect(kambiPropStat("Points & Rebounds by the player - Including Overtime")).toBeNull();
    expect(kambiPropStat("To record a double-double - Including Overtime")).toBeNull();
  });

  it("läser spelare, linje och över/under ur ett riktigt svar", () => {
    const lines = parseKambiProps(fx, fx.eventId);
    expect(lines.length).toBeGreaterThan(10);
    const huerter = lines.find((l) => l.playerName === "Kevin Huerter" && l.stat === "fg3")!;
    expect(huerter).toMatchObject({ line: 1.5, over: 2.6, under: 1.45 });
    // Poänglinjer är riktiga poänglinjer, inte trepoängarnas 0,5–3,5.
    const pts = lines.filter((l) => l.stat === "pts");
    expect(pts.length).toBeGreaterThan(0);
    expect(Math.min(...pts.map((l) => l.line))).toBeGreaterThan(4.5);
    expect(lines.every((l) => l.over > 1 && l.under > 1)).toBe(true);
    // Spel från en annan match sorteras bort.
    expect(parseKambiProps({ betOffers: fx.betOffers.map((b: object) => ({ ...b, eventId: 1 })) }, fx.eventId)).toHaveLength(0);
  });
});
