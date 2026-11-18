import { describe, it, expect } from "vitest";
import { agoLabel, summarizeFreshness } from "../lib/localJobs";

const now = new Date("2026-11-18T12:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3600e3);

describe("färskhet för lokala jobb", () => {
  it("ett jobb som aldrig körts är gult", () => {
    expect(summarizeFreshness([], now)).toMatchObject({ lastOkAt: null, lastRunAt: null, tone: "warn", label: "aldrig", failed: false });
  });

  it("en färsk lyckad körning är neutral", () => {
    expect(summarizeFreshness([{ ranAt: h(2), summary: "ok · 40 s" }], now)).toMatchObject({ tone: "", label: "2 h sedan", failed: false });
  });

  it("mer än 30 timmar gammal är gul", () => {
    expect(summarizeFreshness([{ ranAt: h(31), summary: "ok · 40 s" }], now)).toMatchObject({ tone: "warn", label: "31 h sedan" });
  });

  it("ett fel senast är rött och visar senaste lyckade", () => {
    expect(
      summarizeFreshness(
        [
          { ranAt: h(1), summary: "FEL · exit 1 · 3 s · boom" },
          { ranAt: h(20), summary: "ok · 9 s" },
        ],
        now
      )
    ).toMatchObject({ tone: "neg", failed: true, label: "20 h sedan", error: "FEL · exit 1 · 3 s · boom", lastRunAt: h(1).toISOString() });
  });

  it("etiketter för tid sedan", () => {
    expect(agoLabel(null, now)).toBe("aldrig");
    expect(agoLabel(h(0.5), now)).toBe("nyss");
    expect(agoLabel(h(47), now)).toBe("47 h sedan");
    expect(agoLabel(h(72), now)).toBe("3 d sedan");
  });
});
