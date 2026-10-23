import { describe, it, expect } from "vitest";
import { parseHomeAway } from "../lib/eventLink";

describe("parseHomeAway", () => {
  it("parses @ as away @ home", () => {
    expect(parseHomeAway("PHI Phillies @ CIN Reds")).toEqual({
      home: "CIN Reds",
      away: "PHI Phillies",
    });
  });
  it("parses vs as home vs away", () => {
    expect(parseHomeAway("Arsenal vs Chelsea")).toEqual({
      home: "Arsenal",
      away: "Chelsea",
    });
  });

  it("bindestreck med mellanslag, men bara en gång", () => {
    expect(parseHomeAway("IFK Goteborg - Vasteras SK FK")).toEqual({ home: "IFK Goteborg", away: "Vasteras SK FK" });
    expect(parseHomeAway("Al-Hilal - Al-Nassr")).toEqual({ home: "Al-Hilal", away: "Al-Nassr" });
    expect(parseHomeAway("A - B - C")).toBeNull();
    expect(parseHomeAway("Saint-Etienne")).toBeNull();
  });
});
