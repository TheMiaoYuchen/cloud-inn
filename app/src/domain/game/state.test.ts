import { describe, expect, it } from "vitest";

import { assertSafeMoney } from "../primitives";
import { createNewGame } from "./state";

describe("createNewGame", () => {
  it("creates the authoritative prototype starting state", () => {
    const state = createNewGame("save-1");

    expect(state.phase).toBe("design");
    expect(state.currentDay).toBe(0);
    expect(state.cashCents).toBe(100_000_000);
    expect(state.roomBlueprint).toBeNull();
    expect(state.floor.rooms).toEqual([]);
    expect(state.rateCents).toBe(80_000);
    expect(state.latestReport).toBeNull();
    expect(state.revision).toBe(0);
    expect(state.operations).toBeUndefined();
  });

  it("keeps Phase 4 optional for all legacy saves", () => {
    expect(createNewGame("legacy").phase4).toBeUndefined();
  });
});

describe("assertSafeMoney", () => {
  it("returns non-negative safe integer cents", () => {
    expect(assertSafeMoney(0)).toBe(0);
    expect(assertSafeMoney(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
    "rejects invalid cent value %s",
    (value) => {
      expect(() => assertSafeMoney(value)).toThrow("金额必须是非负整数分");
    },
  );
});
