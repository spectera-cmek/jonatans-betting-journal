import { describe, it, expect } from "vitest";
import { gradeBet, inferSelection } from "../lib/grading";

describe("gradeBet h2h", () => {
  it("home win", () => {
    expect(gradeBet({ market: "h2h", selectionSide: "home" }, { homeScore: 2, awayScore: 1 })).toBe("win");
    expect(gradeBet({ market: "h2h", selectionSide: "home" }, { homeScore: 0, awayScore: 1 })).toBe("loss");
  });
  it("away win", () => {
    expect(gradeBet({ market: "h2h", selectionSide: "away" }, { homeScore: 1, awayScore: 2 })).toBe("win");
  });
  it("draw selection", () => {
    expect(gradeBet({ market: "h2h", selectionSide: "draw" }, { homeScore: 1, awayScore: 1 })).toBe("win");
    expect(gradeBet({ market: "h2h", selectionSide: "draw" }, { homeScore: 2, awayScore: 1 })).toBe("loss");
  });
  it("home bet loses on a draw (no draw refund in h2h 2-way logic)", () => {
    expect(gradeBet({ market: "h2h", selectionSide: "home" }, { homeScore: 1, awayScore: 1 })).toBe("loss");
  });
});

describe("gradeBet totals", () => {
  it("over wins when total exceeds line", () => {
    expect(gradeBet({ market: "totals", selectionSide: "over", line: 2.5 }, { homeScore: 2, awayScore: 1 })).toBe("win");
  });
  it("over loses when total is under line", () => {
    expect(gradeBet({ market: "totals", selectionSide: "over", line: 2.5 }, { homeScore: 1, awayScore: 1 })).toBe("loss");
  });
  it("under wins when total below line", () => {
    expect(gradeBet({ market: "totals", selectionSide: "under", line: 2.5 }, { homeScore: 1, awayScore: 1 })).toBe("win");
  });
  it("exact line on a whole number is a push", () => {
    expect(gradeBet({ market: "totals", selectionSide: "over", line: 3 }, { homeScore: 2, awayScore: 1 })).toBe("push");
    expect(gradeBet({ market: "totals", selectionSide: "under", line: 3 }, { homeScore: 2, awayScore: 1 })).toBe("push");
  });
});

describe("gradeBet spreads", () => {
  it("half line never pushes", () => {
    // home -0.5, home wins by 1 -> covers
    expect(gradeBet({ market: "spreads", selectionSide: "home", line: -0.5 }, { homeScore: 1, awayScore: 0 })).toBe("win");
    // home -1.5, home wins by 1 -> does not cover
    expect(gradeBet({ market: "spreads", selectionSide: "home", line: -1.5 }, { homeScore: 1, awayScore: 0 })).toBe("loss");
  });
  it("whole line can push", () => {
    // home -1, home wins by exactly 1 -> push
    expect(gradeBet({ market: "spreads", selectionSide: "home", line: -1 }, { homeScore: 1, awayScore: 0 })).toBe("push");
  });
  it("away handicap", () => {
    // away +1.5, away loses by 1 -> covers
    expect(gradeBet({ market: "spreads", selectionSide: "away", line: 1.5 }, { homeScore: 2, awayScore: 1 })).toBe("win");
  });
});

describe("gradeBet manual fallthrough", () => {
  it("returns null for other markets", () => {
    expect(gradeBet({ market: "other", selectionSide: "home" }, { homeScore: 1, awayScore: 0 })).toBeNull();
  });
  it("returns null for missing line on totals", () => {
    expect(gradeBet({ market: "totals", selectionSide: "over" }, { homeScore: 1, awayScore: 0 })).toBeNull();
  });
});

describe("inferSelection", () => {
  it("detects over/under", () => {
    expect(inferSelection("Over 2.5")).toEqual({ market: "totals", side: "over", line: 2.5 });
    expect(inferSelection("u 1.5")).toEqual({ market: "totals", side: "under", line: 1.5 });
  });
  it("detects draw", () => {
    expect(inferSelection("Draw")).toEqual({ market: "h2h", side: "draw" });
  });
  it("matches team names to sides", () => {
    expect(inferSelection("Arsenal", "Arsenal", "Chelsea")).toEqual({ market: "h2h", side: "home" });
    expect(inferSelection("Chelsea", "Arsenal", "Chelsea")).toEqual({ market: "h2h", side: "away" });
  });
  it("returns empty when nothing matches", () => {
    expect(inferSelection("BTTS Yes")).toEqual({});
  });
});
