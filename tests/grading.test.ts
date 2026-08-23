import { describe, it, expect } from "vitest";
import { gradeBet, inferSelection, resolveGradingMarket, doubleChancePick } from "../lib/grading";

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

describe("resolveGradingMarket", () => {
  // The case that motivates the resolver: a corners line is stored with the
  // grading enum "totals", so the enum alone would grade it against goals.
  it("lets the category override the grading enum", () => {
    expect(
      resolveGradingMarket({ market: "totals", marketCategory: "Hörnor", line: 9.5 })
    ).toBe("corners");
    expect(
      resolveGradingMarket({ market: "totals", marketCategory: "Kort & fouls", line: 3.5 })
    ).toBe("cards");
  });

  it("keeps the enum when the category agrees", () => {
    expect(resolveGradingMarket({ market: "totals", marketCategory: "Totalt" })).toBe("totals");
    expect(resolveGradingMarket({ market: "h2h", marketCategory: "Matchvinnare" })).toBe("h2h");
  });

  it("falls back to the selection text when there is no category", () => {
    expect(resolveGradingMarket({ market: "other", selection: "Båda lagen gör mål - Ja" })).toBe("btts");
    expect(resolveGradingMarket({ market: "other", selection: "1X" })).toBe("double_chance");
  });

  it("is null for a market it cannot place", () => {
    expect(resolveGradingMarket({ market: "other", selection: "Salah först att göra mål" })).toBeNull();
  });

  it("splits half-time bets by whether they carry a line", () => {
    expect(resolveGradingMarket({ market: "totals", marketCategory: "Halvlek", line: 1.5 })).toBe(
      "first_half_totals"
    );
    expect(resolveGradingMarket({ market: "h2h", marketCategory: "Halvlek" })).toBe("first_half_h2h");
  });
});

describe("gradeBet BTTS", () => {
  const yes = { market: "other", marketCategory: "BTTS", selection: "Ja" };
  const no = { market: "other", marketCategory: "BTTS", selection: "Nej" };

  it("grades both-scored", () => {
    expect(gradeBet(yes, { homeScore: 1, awayScore: 2 })).toBe("win");
    expect(gradeBet(no, { homeScore: 1, awayScore: 2 })).toBe("loss");
  });

  it("grades a clean sheet", () => {
    expect(gradeBet(yes, { homeScore: 3, awayScore: 0 })).toBe("loss");
    expect(gradeBet(no, { homeScore: 3, awayScore: 0 })).toBe("win");
  });

  it("accepts over/under as the yes/no side", () => {
    expect(
      gradeBet({ market: "other", marketCategory: "BTTS", selectionSide: "over" }, { homeScore: 1, awayScore: 1 })
    ).toBe("win");
  });

  // An ambiguous label is left alone rather than guessed at.
  it("is null when the side cannot be read", () => {
    expect(
      gradeBet({ market: "other", marketCategory: "BTTS", selection: "Båda lagen" }, { homeScore: 1, awayScore: 1 })
    ).toBeNull();
  });
});

describe("doubleChancePick", () => {
  it("reads the shorthand", () => {
    expect(doubleChancePick("1X")).toBe("1X");
    expect(doubleChancePick("X2")).toBe("X2");
    expect(doubleChancePick("12")).toBe("12");
  });

  it("reads Swedish prose", () => {
    expect(doubleChancePick("Hemma eller oavgjort")).toBe("1X");
    expect(doubleChancePick("Borta eller oavgjort")).toBe("X2");
    expect(doubleChancePick("Hemma eller borta")).toBe("12");
  });

  // "Arsenal" alone is a plain match winner, not a double chance.
  it("does not invent a pick from a single side", () => {
    expect(doubleChancePick("Hemma")).toBeNull();
    expect(doubleChancePick("Arsenal")).toBeNull();
    expect(doubleChancePick("")).toBeNull();
  });
});

describe("gradeBet double chance", () => {
  const dc = (selection: string) => ({ market: "other", marketCategory: "Dubbelchans", selection });

  it("1X wins on a home win and on a draw", () => {
    expect(gradeBet(dc("1X"), { homeScore: 2, awayScore: 0 })).toBe("win");
    expect(gradeBet(dc("1X"), { homeScore: 1, awayScore: 1 })).toBe("win");
    expect(gradeBet(dc("1X"), { homeScore: 0, awayScore: 1 })).toBe("loss");
  });

  it("12 loses only on a draw", () => {
    expect(gradeBet(dc("12"), { homeScore: 2, awayScore: 0 })).toBe("win");
    expect(gradeBet(dc("12"), { homeScore: 0, awayScore: 2 })).toBe("win");
    expect(gradeBet(dc("12"), { homeScore: 1, awayScore: 1 })).toBe("loss");
  });
});

describe("gradeBet draw no bet", () => {
  const dnb = (side: string) => ({
    market: "h2h",
    marketCategory: "Draw No Bet",
    selectionSide: side,
  });

  it("returns the stake on a draw", () => {
    expect(gradeBet(dnb("home"), { homeScore: 1, awayScore: 1 })).toBe("void");
  });

  it("otherwise grades like a winner market", () => {
    expect(gradeBet(dnb("home"), { homeScore: 2, awayScore: 1 })).toBe("win");
    expect(gradeBet(dnb("away"), { homeScore: 2, awayScore: 1 })).toBe("loss");
  });
});

describe("gradeBet corners and cards", () => {
  const corners = { market: "totals", marketCategory: "Hörnor", selectionSide: "over", line: 9.5 };

  it("grades against the corner count, not the goals", () => {
    expect(gradeBet(corners, { homeScore: 0, awayScore: 0, homeCorners: 6, awayCorners: 5 })).toBe("win");
    expect(gradeBet(corners, { homeScore: 5, awayScore: 5, homeCorners: 4, awayCorners: 3 })).toBe("loss");
  });

  it("pushes on an exact whole line", () => {
    expect(
      gradeBet(
        { market: "totals", marketCategory: "Hörnor", selectionSide: "under", line: 10 },
        { homeScore: 0, awayScore: 0, homeCorners: 6, awayCorners: 4 }
      )
    ).toBe("push");
  });

  // A missing statistic must never be read as zero — that would settle every
  // "under" as a winner the moment the stats provider was unavailable.
  it("is null when the statistic is missing", () => {
    expect(gradeBet(corners, { homeScore: 1, awayScore: 1 })).toBeNull();
    expect(gradeBet(corners, { homeScore: 1, awayScore: 1, homeCorners: 6, awayCorners: null })).toBeNull();
  });

  it("grades cards the same way", () => {
    expect(
      gradeBet(
        { market: "totals", marketCategory: "Kort & fouls", selectionSide: "over", line: 3.5 },
        { homeScore: 0, awayScore: 0, homeCards: 2, awayCards: 3 }
      )
    ).toBe("win");
  });
});

describe("gradeBet first half", () => {
  it("grades a half-time winner off the half score", () => {
    expect(
      gradeBet(
        { market: "h2h", marketCategory: "Halvlek", selectionSide: "home" },
        { homeScore: 1, awayScore: 3, homeHalfScore: 1, awayHalfScore: 0 }
      )
    ).toBe("win");
  });

  it("grades a half-time line", () => {
    expect(
      gradeBet(
        { market: "totals", marketCategory: "Halvlek", selectionSide: "over", line: 0.5 },
        { homeScore: 4, awayScore: 0, homeHalfScore: 0, awayHalfScore: 0 }
      )
    ).toBe("loss");
  });

  it("is null without a half-time score", () => {
    expect(
      gradeBet(
        { market: "h2h", marketCategory: "Halvlek", selectionSide: "home" },
        { homeScore: 1, awayScore: 0 }
      )
    ).toBeNull();
  });
});
