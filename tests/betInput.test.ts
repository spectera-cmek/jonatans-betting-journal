import { describe, it, expect } from "vitest";
import { buildBetData, ValidationError } from "../lib/betInput";

// A minimal valid create payload. Individual tests override one field at a time
// so a failure points at the rule under test, not at unrelated required fields.
const base = { event: "Arsenal vs Chelsea", selection: "Arsenal", odds: 2.5, stakeUnits: 1 };

describe("buildBetData — validation", () => {
  it("requires an event on create", () => {
    expect(() => buildBetData({ ...base, event: "" })).toThrow(ValidationError);
    expect(() => buildBetData({ ...base, event: "   " })).toThrow(ValidationError);
  });

  it("rejects odds below 1.01 and accepts exactly 1.01", () => {
    expect(() => buildBetData({ ...base, odds: 1 })).toThrow(/odds must be a decimal/);
    expect(() => buildBetData({ ...base, odds: 0 })).toThrow(ValidationError);
    expect(() => buildBetData({ ...base, odds: "abc" })).toThrow(ValidationError);
    // 1.01 is the import placeholder for a loss with unknown odds — it must stay legal.
    expect(buildBetData({ ...base, odds: 1.01 }).odds).toBe(1.01);
  });

  it("rejects a stake of zero or less", () => {
    expect(() => buildBetData({ ...base, stakeUnits: 0 })).toThrow(/stakeUnits must be > 0/);
    expect(() => buildBetData({ ...base, stakeUnits: -1 })).toThrow(ValidationError);
  });

  it("rejects unknown enum values", () => {
    expect(() => buildBetData({ ...base, selectionSide: "sideways" })).toThrow(/selectionSide/);
    expect(() => buildBetData({ ...base, marketScope: "referee" })).toThrow(/marketScope/);
    expect(() => buildBetData({ ...base, outcome: "cancelled" })).toThrow(/outcome must be one of/);
    expect(() => buildBetData({ ...base, eventKind: "friendly" })).toThrow(/eventKind/);
    expect(() => buildBetData({ ...base, tournamentStage: "kvartsfinalen-ish" })).toThrow(
      /tournamentStage/
    );
  });

  it("rejects an unparseable eventAt but accepts null to clear it", () => {
    expect(() => buildBetData({ ...base, eventAt: "not-a-date" })).toThrow(/eventAt is not a valid date/);
    expect(buildBetData({ ...base, eventAt: null }).eventAt).toBeNull();
    expect(buildBetData({ ...base, eventAt: "2026-08-24T18:00:00Z" }).eventAt).toEqual(
      new Date("2026-08-24T18:00:00Z")
    );
  });
});

describe("buildBetData — Swedish decimal commas", () => {
  // The add-bet form is used on a Swedish keyboard, where the decimal separator
  // is a comma. Every numeric field goes through the same num() helper.
  it("parses commas in odds, stake, line and closing odds", () => {
    const data = buildBetData({
      ...base,
      odds: "2,50",
      stakeUnits: "1,25",
      line: "2,5",
      closingOdds: "2,20",
    });
    expect(data.odds).toBe(2.5);
    expect(data.stakeUnits).toBe(1.25);
    expect(data.line).toBe(2.5);
    expect(data.closingOdds).toBe(2.2);
  });

  it("treats an empty numeric string as null, not zero", () => {
    expect(buildBetData({ ...base, closingOdds: "" }).closingOdds).toBeNull();
    expect(buildBetData({ ...base, line: "" }).line).toBeNull();
  });
});

describe("buildBetData — partial (PATCH) semantics", () => {
  it("touches only the fields that were supplied", () => {
    const data = buildBetData({ notes: "kollade laguppställningen" }, { partial: true });
    expect(Object.keys(data)).toEqual(["notes"]);
  });

  it("still validates the fields that were supplied", () => {
    expect(() => buildBetData({ odds: 1.0 }, { partial: true })).toThrow(ValidationError);
  });

  it("always writes the required fields on create", () => {
    const data = buildBetData(base);
    for (const key of ["event", "odds", "stakeUnits", "market", "selection", "outcome"]) {
      expect(data[key]).toBeDefined();
    }
    expect(data.outcome).toBe("pending");
  });
});

describe("buildBetData — profit recomputation", () => {
  const existing = { odds: 2.5, stakeUnits: 2, outcome: "win" };

  it("computes profit from odds and stake when settling on create", () => {
    const data = buildBetData({ ...base, stakeUnits: 2, outcome: "win" });
    expect(data.profitUnits).toBe(3); // 2u at 2.50 -> +3u
    expect(data.gradedAt).toBeInstanceOf(Date);
  });

  it("clears profit and gradedAt when the outcome is pending", () => {
    const data = buildBetData({ ...base, outcome: "pending" });
    expect(data.profitUnits).toBeNull();
    expect(data.gradedAt).toBeNull();
  });

  it("halves the profit on half_win and half_loss", () => {
    expect(buildBetData({ ...base, stakeUnits: 2, outcome: "half_win" }).profitUnits).toBe(1.5);
    expect(buildBetData({ ...base, stakeUnits: 2, outcome: "half_loss" }).profitUnits).toBe(-1);
  });

  // The regression that matters most: bet365/Betsson imports store the real
  // payout in profitUnits. Editing an unrelated field must not silently replace
  // that authoritative number with the formula value.
  it("leaves an imported profit alone when a PATCH touches no profit input", () => {
    const data = buildBetData({ notes: "rättad mot kvittot" }, { partial: true, existing });
    expect(data.profitUnits).toBeUndefined();
    expect(data.gradedAt).toBeUndefined();
  });

  it("recomputes from the existing row when a PATCH changes only the outcome", () => {
    const data = buildBetData({ outcome: "loss" }, { partial: true, existing });
    expect(data.profitUnits).toBe(-2); // stake comes from `existing`
  });

  it("recomputes when a PATCH changes only the odds", () => {
    const data = buildBetData({ odds: 3 }, { partial: true, existing });
    expect(data.profitUnits).toBe(4); // 2u at 3.00, outcome "win" from `existing`
  });
});

describe("buildBetData — closing odds provenance", () => {
  it("stamps a hand-entered closing price as a verified manual source", () => {
    const d = buildBetData({ ...base, closingOdds: 2.3 });
    expect(d.closingOdds).toBe(2.3);
    expect(d.closingSource).toBe("manual");
    expect(d.closingCapturedAt).toBeInstanceOf(Date);
  });

  it("clears the stamp when the closing price is removed", () => {
    const d = buildBetData({ closingOdds: "" }, { partial: true });
    expect(d.closingOdds).toBeNull();
    expect(d.closingSource).toBeNull();
    expect(d.closingCapturedAt).toBeNull();
  });

  it("leaves provenance untouched when closingOdds is not part of the patch", () => {
    const d = buildBetData({ odds: 2.1 }, { partial: true });
    expect("closingSource" in d).toBe(false);
  });

  it("accepts the boosted flag and coerces it to a boolean", () => {
    // The modal keeps it as a "1" / "" string like every other form field.
    expect(buildBetData({ ...base, boosted: true }).boosted).toBe(true);
    expect(buildBetData({ boosted: null }, { partial: true }).boosted).toBe(false);
  });
});
