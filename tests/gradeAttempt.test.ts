import { describe, it, expect } from "vitest";
import { backoffHours, isRetryDue, MAX_GRADE_ATTEMPTS } from "../lib/gradeAttempt";

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
const NOW = new Date();

describe("backoffHours", () => {
  it("doubles from one hour", () => {
    expect(backoffHours(1)).toBe(1);
    expect(backoffHours(2)).toBe(2);
    expect(backoffHours(3)).toBe(4);
    expect(backoffHours(4)).toBe(8);
  });

  // Most failures are "not finished yet" or "the feed has not published it",
  // and both clear within a day. Uncapped doubling would push a gradable bet
  // weeks out over a handful of early misses.
  it("caps at a day", () => {
    expect(backoffHours(6)).toBe(24);
    expect(backoffHours(20)).toBe(24);
  });

  it("is zero before the first attempt", () => {
    expect(backoffHours(0)).toBe(0);
  });
});

describe("isRetryDue", () => {
  it("is due when never tried", () => {
    expect(isRetryDue({ gradeAttempts: 0, gradeLastTriedAt: null }, NOW)).toBe(true);
  });

  it("waits out the backoff window", () => {
    expect(isRetryDue({ gradeAttempts: 3, gradeLastTriedAt: hoursAgo(1) }, NOW)).toBe(false);
    expect(isRetryDue({ gradeAttempts: 3, gradeLastTriedAt: hoursAgo(5) }, NOW)).toBe(true);
  });

  // A bet nothing can settle stops costing a lookup and waits for a human.
  it("gives up after the attempt ceiling", () => {
    expect(
      isRetryDue({ gradeAttempts: MAX_GRADE_ATTEMPTS, gradeLastTriedAt: hoursAgo(500) }, NOW)
    ).toBe(false);
  });

  it("still retries one attempt short of the ceiling", () => {
    expect(
      isRetryDue({ gradeAttempts: MAX_GRADE_ATTEMPTS - 1, gradeLastTriedAt: hoursAgo(500) }, NOW)
    ).toBe(true);
  });
});
