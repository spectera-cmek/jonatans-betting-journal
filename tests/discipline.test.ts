import { describe, it, expect } from "vitest";
import { evaluateBet, betCategory } from "../lib/discipline";

describe("betCategory", () => {
  it("reads the category from the free-text selection", () => {
    expect(betCategory({ selection: "Bridges över 13.5 skott" })).toBe("Skott");
    expect(betCategory({ selection: "Över 9.5 hörnor" })).toBe("Hörnor");
    expect(betCategory({ selection: "Jokic över 11.5 returer" })).toBe("Returer");
  });
  it("falls back to the market field", () => {
    expect(betCategory({ selection: "Arsenal", market: "spreads" })).toBe("Handikapp");
    expect(betCategory({ selection: "", market: "totals" })).toBe("Totalt");
  });
});

describe("evaluateBet — leaks", () => {
  it("warns on odds >= 3 and harder on 5+", () => {
    const v3 = evaluateBet({ odds: 3.2 });
    expect(v3.level).toBe("warn");
    expect(v3.notes.some((n) => n.text.includes("Odds ≥ 3"))).toBe(true);

    const v5 = evaluateBet({ odds: 6.0 });
    expect(v5.notes.some((n) => n.text.includes("Odds 5+"))).toBe(true);
  });

  it("warns on the longshot lottery (small stake at high odds)", () => {
    const v = evaluateBet({ odds: 12, stakeUnits: 0.25 });
    expect(v.notes.some((n) => n.text.includes("longshot"))).toBe(true);
  });

  it("warns on accumulators", () => {
    const v = evaluateBet({ betType: "accumulator", odds: 2.0 });
    expect(v.notes.some((n) => n.text.includes("Ackumulatorer"))).toBe(true);
  });

  it("warns on basketball props but not basketball rebounds in the edge zone", () => {
    const props = evaluateBet({ sport: "Basketball", selection: "LeBron över 27.5 poäng", odds: 1.9 });
    expect(props.notes.some((n) => n.text.includes("Basketprops"))).toBe(true);

    const rebounds = evaluateBet({ sport: "Basketball", selection: "Jokic över 11.5 returer", odds: 1.9 });
    expect(rebounds.notes.some((n) => n.text.includes("Basketprops"))).toBe(false);
    expect(rebounds.notes.some((n) => n.tone === "pos" && n.text.includes("Returer"))).toBe(true);
  });

  it("warns on kort & fouls and tennis", () => {
    expect(evaluateBet({ selection: "Över 4.5 kort", odds: 1.8 }).notes.some((n) => n.text.includes("Kort & fouls"))).toBe(true);
    expect(evaluateBet({ sport: "Tennis", odds: 1.8 }).notes.some((n) => n.text.includes("Tennis"))).toBe(true);
  });
});

describe("evaluateBet — edges", () => {
  it("flags shots/corners/rebounds at odds 1.5–3 as edge", () => {
    const v = evaluateBet({ sport: "Football", selection: "Saka 1+ skott på mål", odds: 1.85, stakeUnits: 1 });
    expect(v.level).toBe("edge");
    expect(v.notes.some((n) => n.tone === "pos" && n.text.includes("Skott"))).toBe(true);
  });

  it("does not call the same category an edge at odds 5+", () => {
    const v = evaluateBet({ selection: "Över 10.5 hörnor", odds: 5.5 });
    expect(v.notes.some((n) => n.tone === "pos" && n.text.includes("Hörnor"))).toBe(false);
    expect(v.notes.some((n) => n.tone === "neg")).toBe(true);
  });

  it("flags the 2.00–2.99 odds band and conviction stakes", () => {
    const v = evaluateBet({ selection: "Över 24.5 skott", odds: 2.1, stakeUnits: 3 });
    expect(v.level).toBe("edge");
    expect(v.notes.some((n) => n.text.includes("2,00–2,99"))).toBe(true);
    expect(v.notes.some((n) => n.text.includes("Conviction"))).toBe(true);
  });

  it("mixed when both edge and leak apply", () => {
    // Shots edge category but on a basketball player props day at high odds.
    const v = evaluateBet({ selection: "Över 9.5 hörnor", odds: 2.5, stakeUnits: 0.25 });
    expect(v.notes.some((n) => n.tone === "pos")).toBe(true);
  });

  it("none when nothing matches", () => {
    const v = evaluateBet({ sport: "Football", selection: "Arsenal vinner", market: "h2h", odds: 1.6, stakeUnits: 1 });
    expect(v.level).toBe("none");
  });
});
