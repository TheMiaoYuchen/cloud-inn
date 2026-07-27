import { describe, expect, it } from "vitest";

import {
  effectiveRate,
  seasonForGameDay,
  suggestRate,
  validatePricePolicy,
  type PricePolicy,
  type PricingContext,
} from "./pricing";

const policy: PricePolicy = {
  roomOfferId: "offer:room-1:standard",
  baseRateCents: 100_000,
  minRateCents: 70_000,
  maxRateCents: 130_000,
  automaticPricing: true,
  nightlyRateCents: 100_000,
};

const context: PricingContext = {
  season: "summer",
  trailingSevenDayOccupancyBps: 8_000,
  segmentDemandBps: 7_500,
  reputationBps: 6_000,
  remainingInventoryBps: 2_000,
};

describe("explainable room pricing", () => {
  it.each([
    ["baseRateCents", 1.5],
    ["baseRateCents", 0],
    ["minRateCents", -1],
    ["maxRateCents", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("rejects a non-positive safe integer %s", (field, value) => {
    expect(() => validatePricePolicy({ ...policy, [field]: value })).toThrow(
      "房价策略金额必须是正整数分",
    );
  });

  it.each([Number.NaN, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid persisted nightly rate %s",
    (nightlyRateCents) => {
      expect(() =>
        validatePricePolicy({ ...policy, nightlyRateCents }),
      ).toThrow("当前房价必须是非负整数分");
    },
  );

  it.each([
    { minRateCents: 110_000 },
    { maxRateCents: 90_000 },
  ])("rejects bounds which do not contain the base rate", (overrides) => {
    expect(() => validatePricePolicy({ ...policy, ...overrides })).toThrow(
      "最低价、基础价和最高价顺序无效",
    );
  });

  it("returns a deterministic golden suggestion with stable Chinese factors", () => {
    const snapshot = structuredClone({ policy, context });

    expect(suggestRate(policy, context)).toEqual({
      rateCents: 126_000,
      factors: [
        { key: "season", adjustmentBps: 800 },
        { key: "occupancy", adjustmentBps: 600 },
        { key: "segmentDemand", adjustmentBps: 500 },
        { key: "reputation", adjustmentBps: 100 },
        { key: "remainingInventory", adjustmentBps: 600 },
      ],
      reasons: [
        "夏季旺季 +8%",
        "近7日入住率 80% +6%",
        "客群需求 75% +5%",
        "酒店声誉 60% +1%",
        "剩余库存 20% +6%",
      ],
    });
    expect({ policy, context }).toEqual(snapshot);
  });

  it("uses the base rate for both suggestions and effective rates when manually locked", () => {
    const locked = { ...policy, automaticPricing: false };

    expect(suggestRate(locked, context)).toEqual({
      rateCents: 100_000,
      factors: [],
      reasons: ["手动锁价：使用基础房价 ¥1000"],
    });
    expect(effectiveRate(locked, context)).toBe(100_000);
  });

  it("derives repeating 30-day seasons from game days only", () => {
    expect([
      seasonForGameDay(0),
      seasonForGameDay(29),
      seasonForGameDay(30),
      seasonForGameDay(60),
      seasonForGameDay(90),
      seasonForGameDay(120),
    ]).toEqual(["spring", "spring", "summer", "autumn", "winter", "spring"]);
    expect(() => seasonForGameDay(1.5)).toThrow("游戏日必须是非负整数");
  });

  it("clamps the computed rate to policy bounds and explains the clamp last", () => {
    const upper = suggestRate({ ...policy, maxRateCents: 120_000 }, context);
    const lower = suggestRate(
      { ...policy, minRateCents: 90_000 },
      {
        ...context,
        season: "winter",
        trailingSevenDayOccupancyBps: 0,
        segmentDemandBps: 0,
        reputationBps: 0,
        remainingInventoryBps: 10_000,
      },
    );

    expect(upper.rateCents).toBe(120_000);
    expect(upper.reasons[upper.reasons.length - 1]).toBe("已限制为最高价 ¥1200");
    expect(lower.rateCents).toBe(90_000);
    expect(lower.reasons[lower.reasons.length - 1]).toBe("已限制为最低价 ¥900");
  });

  it.each([
    ["trailingSevenDayOccupancyBps", -1],
    ["segmentDemandBps", 10_001],
    ["reputationBps", 1.5],
    ["remainingInventoryBps", Number.NaN],
  ] as const)("rejects invalid context field %s", (field, value) => {
    expect(() => suggestRate(policy, { ...context, [field]: value })).toThrow(
      "定价上下文比例必须是 0 到 10000 的整数基点",
    );
  });

  it("validates context even while manual pricing is locked", () => {
    expect(() =>
      effectiveRate(
        { ...policy, automaticPricing: false },
        { ...context, reputationBps: -1 },
      ),
    ).toThrow("定价上下文比例必须是 0 到 10000 的整数基点");
  });
});
