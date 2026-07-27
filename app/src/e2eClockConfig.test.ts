import { describe, expect, it } from "vitest";
import { e2eDayMilliseconds } from "./e2eClockConfig";

describe("e2e clock configuration", () => {
  it("ignores a stored override unless the explicit development E2E gate is enabled", () => {
    expect(e2eDayMilliseconds(false, "500")).toBeUndefined();
    expect(e2eDayMilliseconds(true, "500")).toBe(500);
  });
});
