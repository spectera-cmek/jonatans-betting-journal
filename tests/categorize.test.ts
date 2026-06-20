import { describe, it, expect } from "vitest";
import { normalizeMarket, inferScope, categorizeDetail } from "../lib/categorize";

describe("normalizeMarket — detailed splits", () => {
  it("separates 'Skott på mål' from plain 'Skott'", () => {
    expect(normalizeMarket("Skott på mål")).toBe("Skott på mål");
    expect(normalizeMarket("Saka skott på mål")).toBe("Skott på mål");
    expect(normalizeMarket("Shots on goal")).toBe("Skott på mål");
    expect(normalizeMarket("Bridges över 13.5 skott")).toBe("Skott");
  });
  it("recognises the new safe categories", () => {
    expect(normalizeMarket("Antal räddningar")).toBe("Räddningar");
    expect(normalizeMarket("Frikast gjorda")).toBe("Frikast");
    expect(normalizeMarket("Antal ess")).toBe("Ess");
  });
  it("keeps existing categories intact", () => {
    expect(normalizeMarket("Över 9.5 hörnor")).toBe("Hörnor");
    expect(normalizeMarket("Jokic över 11.5 returer")).toBe("Returer");
  });
});

describe("inferScope", () => {
  it("treats per-player categories as player", () => {
    expect(inferScope("Jokic över 11.5 returer", "Returer")).toBe("player");
    expect(inferScope("Trae Young 7+ assists", "Assists")).toBe("player");
  });
  it("reads a leading name + line on ambiguous stats as a player line", () => {
    expect(inferScope("Saka 1+ skott på mål", "Skott på mål", ["Arsenal", "Chelsea"])).toBe("player");
  });
  it("reads a leading over/under on ambiguous stats as a match total", () => {
    expect(inferScope("Över 9.5 hörnor", "Hörnor")).toBe("match");
  });
  it("treats match-outcome categories as match even when a team is named", () => {
    expect(inferScope("Arsenal", "Matchvinnare", ["Arsenal", "Chelsea"])).toBe("match");
    expect(inferScope("Över 2.5 mål", "Totalt")).toBe("match");
  });
  it("spots a named team on a team-level prop", () => {
    expect(inferScope("Arsenal över 4.5 hörnor", "Hörnor", ["Arsenal", "Chelsea"])).toBe("team");
  });
  it("returns null when nothing is conclusive", () => {
    expect(inferScope("", "Övrigt")).toBeNull();
  });
});

describe("categorizeDetail", () => {
  it("derives category + scope from selection and event", () => {
    expect(categorizeDetail("Saka 1+ skott på mål", "Arsenal vs Chelsea")).toEqual({
      marketCategory: "Skott på mål",
      marketScope: "player",
    });
    expect(categorizeDetail("Jokic över 11.5 returer", "Nuggets @ Lakers")).toEqual({
      marketCategory: "Returer",
      marketScope: "player",
    });
  });
  it("falls back to the first leg's market for imports without a selection", () => {
    expect(categorizeDetail("", "Arsenal vs Chelsea", [{ market: "Skott på mål" }]).marketCategory).toBe(
      "Skott på mål"
    );
  });
});
