import { describe, it, expect } from "vitest";
import { dayIso, weekdayIdx, addDays, weekOf, isoWeekNo } from "../lib/time";

describe("dayIso", () => {
  it("formats in Swedish local time, not UTC", () => {
    // 23:30 UTC on Jun 11 is already Jun 12 in Stockholm (UTC+2 in summer).
    expect(dayIso("2026-06-11T23:30:00Z")).toBe("2026-06-12");
    expect(dayIso("2026-06-11T12:00:00Z")).toBe("2026-06-11");
  });

  it("handles winter time (UTC+1)", () => {
    expect(dayIso("2026-01-10T23:30:00Z")).toBe("2026-01-11");
    expect(dayIso("2026-01-10T22:30:00Z")).toBe("2026-01-10");
  });
});

describe("weekdayIdx", () => {
  it("is Monday-first", () => {
    expect(weekdayIdx("2026-06-08")).toBe(0); // Monday
    expect(weekdayIdx("2026-06-14")).toBe(6); // Sunday
  });
});

describe("addDays", () => {
  it("adds and subtracts across month edges", () => {
    expect(addDays("2026-05-31", 1)).toBe("2026-06-01");
    expect(addDays("2026-06-01", -1)).toBe("2026-05-31");
    expect(addDays("2026-06-12", 0)).toBe("2026-06-12");
  });
});

describe("weekOf", () => {
  it("returns the Monday–Sunday window containing the date", () => {
    // 2026-06-12 is a Friday.
    expect(weekOf("2026-06-12T10:00:00Z")).toEqual({ start: "2026-06-08", end: "2026-06-14" });
  });

  it("a Sunday late evening UTC already belongs to the next Swedish week", () => {
    // Sunday 23:00 UTC = Monday 01:00 in Stockholm.
    expect(weekOf("2026-06-14T23:00:00Z")).toEqual({ start: "2026-06-15", end: "2026-06-21" });
  });
});

describe("isoWeekNo", () => {
  it("matches known ISO week numbers", () => {
    expect(isoWeekNo("2026-01-01")).toBe(1);
    expect(isoWeekNo("2026-06-08")).toBe(24);
    expect(isoWeekNo("2024-12-30")).toBe(1); // ISO week 1 of 2025
  });
});
