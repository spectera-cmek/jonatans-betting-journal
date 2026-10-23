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
});
