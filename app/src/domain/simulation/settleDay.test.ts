import { describe, expect, it } from "vitest";

import { settleDay } from "./settleDay";

describe("settleDay", () => {
  const approvedInput = {
    day: 1,
    cashCents: 53_600_000,
    availableRooms: 4,
    rateCents: 80_000,
    suggestedRateCents: 80_000,
    areaSquareMeters: 24,
  };

  it("settles the approved four-room fixture at the suggested price", () => {
    expect(settleDay(approvedInput)).toEqual({
      day: 1,
      availableRooms: 4,
      soldRooms: 3,
      occupancyBps: 7_500,
      rateCents: 80_000,
      revenueCents: 240_000,
      operatingCostCents: 77_000,
      netIncomeCents: 163_000,
      endingCashCents: 53_763_000,
      reasons: [
        "24㎡满足商务客的面积期望",
        "房价处于建议价，需求转化正常",
      ],
    });
  });

  it("sells no rooms at twice the suggested price", () => {
    expect(
      settleDay({
        ...approvedInput,
        day: 2,
        cashCents: 53_763_000,
        rateCents: 160_000,
      }),
    ).toEqual({
      day: 2,
      availableRooms: 4,
      soldRooms: 0,
      occupancyBps: 0,
      rateCents: 160_000,
      revenueCents: 0,
      operatingCostCents: 32_000,
      netIncomeCents: -32_000,
      endingCashCents: 53_731_000,
      reasons: [
        "24㎡满足商务客的面积期望",
        "房价达到建议价两倍，商务需求未转化",
      ],
    });
  });

  it("caps sales at both deterministic demand and available inventory", () => {
    expect(
      settleDay({
        ...approvedInput,
        availableRooms: 5,
        rateCents: 0,
      }).soldRooms,
    ).toBe(3);
    expect(
      settleDay({
        ...approvedInput,
        availableRooms: 2,
        rateCents: 0,
      }).soldRooms,
    ).toBe(2);
  });

  it("reports zero occupancy when no rooms are available", () => {
    expect(
      settleDay({ ...approvedInput, availableRooms: 0 }).occupancyBps,
    ).toBe(0);
  });

  it("explains rates between the suggested price and double price", () => {
    expect(
      settleDay({ ...approvedInput, rateCents: 120_000 }).reasons[1],
    ).toBe("房价变化影响了需求转化");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects invalid day %s",
    (day) => {
      expect(() => settleDay({ ...approvedInput, day })).toThrow(
        "营业日必须是正安全整数",
      );
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects invalid available room count %s",
    (availableRooms) => {
      expect(() => settleDay({ ...approvedInput, availableRooms })).toThrow(
        "可售房间数必须是非负安全整数",
      );
    },
  );

  it.each([
    ["cashCents", -1],
    ["cashCents", 1.5],
    ["cashCents", Number.MAX_SAFE_INTEGER + 1],
    ["cashCents", NaN],
    ["cashCents", Infinity],
    ["rateCents", -1],
    ["rateCents", 1.5],
    ["rateCents", Number.MAX_SAFE_INTEGER + 1],
    ["rateCents", NaN],
    ["rateCents", Infinity],
    ["suggestedRateCents", -1],
    ["suggestedRateCents", 1.5],
    ["suggestedRateCents", Number.MAX_SAFE_INTEGER + 1],
    ["suggestedRateCents", NaN],
    ["suggestedRateCents", Infinity],
  ] as const)("rejects invalid money input %s=%s", (field, value) => {
    expect(() => settleDay({ ...approvedInput, [field]: value })).toThrow(
      "金额必须是非负整数分",
    );
  });

  it("requires a positive suggested rate", () => {
    expect(() =>
      settleDay({ ...approvedInput, suggestedRateCents: 0 }),
    ).toThrow("建议房价必须大于零");
  });

  it.each([0, -0.25, 0.1, 24.1, NaN, Infinity])(
    "rejects invalid room area %s",
    (areaSquareMeters) => {
      expect(() => settleDay({ ...approvedInput, areaSquareMeters })).toThrow(
        "房间面积必须是按0.25㎡递增的正有限数",
      );
    },
  );

  it("rejects unsafe calculated money", () => {
    expect(() =>
      settleDay({
        ...approvedInput,
        cashCents: Number.MAX_SAFE_INTEGER,
        availableRooms: 1,
      }),
    ).toThrow("金额必须是非负整数分");
  });

  it("rejects a settlement that would leave negative cash", () => {
    expect(() =>
      settleDay({
        ...approvedInput,
        cashCents: 0,
        availableRooms: 1,
        rateCents: 0,
      }),
    ).toThrow("金额必须是非负整数分");
  });

  it("does not mutate its input", () => {
    const input = { ...approvedInput };
    const snapshot = structuredClone(input);

    settleDay(input);

    expect(input).toEqual(snapshot);
  });
});
