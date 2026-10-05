import { describe, it, expect } from "vitest";
import { MANUAL_STEP, buildManualVeto, isManualVetoStep } from "../lib/cs2/manualVeto";

describe("manuellt veto", () => {
  it("bo3: två val och en decider, i ordning", () => {
    const r = buildManualVeto(
      "bo3",
      [
        { mapName: "Mirage", pickedBy: 10 },
        { mapName: "de_inferno", pickedBy: 20 },
        { mapName: "nuke", pickedBy: 10 },
      ],
      [10, 20]
    );
    expect("rows" in r && r.rows).toEqual([
      { step: MANUAL_STEP + 1, teamId: 10, action: "pick", mapName: "mirage" },
      { step: MANUAL_STEP + 2, teamId: 20, action: "pick", mapName: "inferno" },
      // Decidern har inget lag, även om ett skickades.
      { step: MANUAL_STEP + 3, teamId: null, action: "decider", mapName: "nuke" },
    ]);
  });

  it("okänt lag eller okänd väljare blir null", () => {
    const r = buildManualVeto("bo3", [{ mapName: "mirage", pickedBy: 99 }, { mapName: "ancient" }, { mapName: "dust2" }], [10, 20]);
    expect("rows" in r && r.rows.map((x) => x.teamId)).toEqual([null, null, null]);
  });

  it("bo1 är bara en decider", () => {
    const r = buildManualVeto("bo1", [{ mapName: "anubis", pickedBy: 10 }], [10, 20]);
    expect("rows" in r && r.rows).toEqual([{ step: MANUAL_STEP + 1, teamId: null, action: "decider", mapName: "anubis" }]);
  });

  it("nekar fel antal, dubbletter och okända kartor", () => {
    expect(buildManualVeto("bo3", [{ mapName: "mirage" }, { mapName: "nuke" }], [1, 2])).toEqual({ error: "BO3 har 3 kartor." });
    expect(buildManualVeto("bo3", [{ mapName: "mirage" }, { mapName: "de_mirage" }, { mapName: "nuke" }], [1, 2])).toEqual({
      error: "Samma karta kan inte väljas två gånger.",
    });
    expect("error" in buildManualVeto("bo1", [{ mapName: "" }], [1, 2])).toBe(true);
  });

  it("känner igen manuella steg", () => {
    expect(isManualVetoStep(MANUAL_STEP + 1)).toBe(true);
    expect(isManualVetoStep(7)).toBe(false);
  });
});
