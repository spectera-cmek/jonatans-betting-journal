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

  it("ett utskrivet Prisma-fel ger felraden, inte objektets avslutande klammer", () => {
    // Slutet av nba.log när NBA-databasen svarade 402 (2026-11-17).
    const tail = [
      "Can't reach database server at `ep-x-pooler.c-14.us-east-1.aws.neon.tech:5432`",
      "",
      "Please make sure your database server is running at `ep-x-pooler.c-14.us-east-1.aws.neon.tech:5432`.",
      "    at $n.handleRequestError (C:\\x\\library.js:121:7615)",
      "    at async l (C:\\x\\library.js:130:9633) {",
      "  clientVersion: '5.22.0',",
      "  errorCode: undefined",
      "}",
    ].join("\n");
    expect(lastMeaningfulLine(tail)).toBe("Please make sure your database server is running at `ep-x-pooler.c-14.us-east-1.aws.neon.tech:5432`.");
    // Ett vanligt felmeddelande med kolon ska inte tas för en objektrad.
    expect(lastMeaningfulLine("Error: CS2_DATABASE_URL saknas")).toBe("Error: CS2_DATABASE_URL saknas");
  });
});
