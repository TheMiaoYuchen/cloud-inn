import { describe, expect, it } from "vitest";

import { offlineDaysForElapsed } from "./offlineSettlement";

describe("offlineDaysForElapsed", () => {
  it.each([
    [0, 60_000, 0],
    [59_999, 60_000, 0],
    [60_000, 60_000, 1],
    [179_999, 60_000, 2],
    [420_000, 60_000, 7],
    [999_999_999, 60_000, 7],
  ])("converts %s elapsed milliseconds at %s per day to %s capped days", (elapsed, perDay, expected) => {
    expect(offlineDaysForElapsed(elapsed, perDay)).toBe(expected);
  });

  it.each([
    [-1, 60_000],
    [Number.NaN, 60_000],
    [Infinity, 60_000],
    [1.5, 60_000],
    [0, 0],
    [0, -1],
    [0, Number.NaN],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects unsafe elapsed/per-day values (%s, %s)", (elapsed, perDay) => {
    expect(() => offlineDaysForElapsed(elapsed, perDay)).toThrow("安全整数");
  });
});
