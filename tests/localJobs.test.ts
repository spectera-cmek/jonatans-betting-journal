import { describe, it, expect } from "vitest";
import { jobArea, lastMeaningfulLine, runSummary, shouldNotify, syncKind } from "../lib/localJobs";

describe("lokala jobb", () => {
  it("område och SyncLog-typ ur npm-skriptet", () => {
    expect(jobArea("cs2:update")).toBe("cs2");
    expect(jobArea("shots:ingest")).toBe("shots");
    expect(syncKind("nba:update")).toBe("lokal:nba:update");
  });

  it("sammanfattning av en körning", () => {
    expect(runSummary({ exitCode: 0, seconds: 42, lastLine: "x", notified: false })).toBe("ok · 42 s");
    expect(runSummary({ exitCode: 1, seconds: 3, lastLine: "Can't reach database server", notified: true })).toBe(
      "FEL (notis) · exit 1 · 3 s · Can't reach database server"
    );
    expect(runSummary({ exitCode: null, seconds: 3, lastLine: "", notified: false })).toBe("FEL · exit ? · 3 s");
    expect(runSummary({ exitCode: 1, seconds: 1, lastLine: "y".repeat(900), notified: false }).length).toBe(500);
  });

  it("högst en notis per dygn", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(shouldNotify(null, now)).toBe(true);
    expect(shouldNotify(new Date("2026-11-18T01:00:00Z"), now)).toBe(false);
    expect(shouldNotify(new Date("2026-11-17T11:59:00Z"), now)).toBe(true);
  });

  it("sista meningsfulla utskriftsraden", () => {
    expect(lastMeaningfulLine("a\n> tsx x\nfel här\n\n")).toBe("fel här");
    expect(lastMeaningfulLine("")).toBe("");
    // npm:s hänvisning till sin egen logg säger inget om felet.
    expect(
      lastMeaningfulLine('npm error Missing script: "x"\nnpm error\nnpm error A complete log of this run can be found in: C:\\x.log')
    ).toBe('npm error Missing script: "x"');
  });
});
