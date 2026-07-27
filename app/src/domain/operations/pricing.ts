import type { RoomPricePolicy } from "./operationsTypes";

export type Season = "spring" | "summer" | "autumn" | "winter";

export interface PricePolicy extends RoomPricePolicy {
  baseRateCents: number;
  minRateCents: number;
  maxRateCents: number;
  automaticPricing: boolean;
}

export interface PricingContext {
  season: Season;
  trailingSevenDayOccupancyBps: number;
  segmentDemandBps: number;
  reputationBps: number;
  remainingInventoryBps: number;
}

export type PricingFactorKey =
  | "season"
  | "occupancy"
  | "segmentDemand"
  | "reputation"
  | "remainingInventory";

export interface PricingSuggestion {
  rateCents: number;
  factors: Array<{ key: PricingFactorKey; adjustmentBps: number }>;
  reasons: string[];
}

const SEASONS: readonly Season[] = ["spring", "summer", "autumn", "winter"];

function assertPositiveMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("房价策略金额必须是正整数分");
  }
}

function assertContextBps(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("定价上下文比例必须是 0 到 10000 的整数基点");
  }
}

function signedPercent(adjustmentBps: number): string {
  const sign = adjustmentBps >= 0 ? "+" : "-";
  const magnitude = Math.abs(adjustmentBps);
  const whole = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;
  return `${sign}${whole}${fraction === 0 ? "" : `.${String(fraction).padStart(2, "0").replace(/0+$/, "")}`}%`;
}

function yuan(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = cents % 100;
  return `¥${whole}${fraction === 0 ? "" : `.${String(fraction).padStart(2, "0")}`}`;
}

export function validatePricePolicy(policy: Readonly<PricePolicy>): void {
  assertPositiveMoney(policy.baseRateCents);
  assertPositiveMoney(policy.minRateCents);
  assertPositiveMoney(policy.maxRateCents);
  if (
    policy.minRateCents > policy.baseRateCents ||
    policy.baseRateCents > policy.maxRateCents
  ) {
    throw new Error("最低价、基础价和最高价顺序无效");
  }
  if (typeof policy.roomOfferId !== "string" || policy.roomOfferId.length === 0) {
    throw new Error("客房产品编号不能为空");
  }
  if (typeof policy.automaticPricing !== "boolean") {
    throw new Error("自动定价开关无效");
  }
}

export function seasonForGameDay(gameDay: number): Season {
  if (!Number.isSafeInteger(gameDay) || gameDay < 0) {
    throw new Error("游戏日必须是非负整数");
  }
  return SEASONS[Math.trunc((gameDay % 120) / 30)];
}

function validateContext(context: Readonly<PricingContext>): void {
  if (!SEASONS.includes(context.season)) {
    throw new Error("季节无效");
  }
  assertContextBps(context.trailingSevenDayOccupancyBps);
  assertContextBps(context.segmentDemandBps);
  assertContextBps(context.reputationBps);
  assertContextBps(context.remainingInventoryBps);
}

export function suggestRate(
  policy: Readonly<PricePolicy>,
  context: Readonly<PricingContext>,
): PricingSuggestion {
  validatePricePolicy(policy);
  validateContext(context);

  if (!policy.automaticPricing) {
    return {
      rateCents: policy.baseRateCents,
      factors: [],
      reasons: [`手动锁价：使用基础房价 ${yuan(policy.baseRateCents)}`],
    };
  }

  const seasonAdjustment = {
    spring: 0,
    summer: 800,
    autumn: -200,
    winter: -800,
  }[context.season];
  const adjustments: Array<{
    key: PricingFactorKey;
    adjustmentBps: number;
    reason: string;
  }> = [
    {
      key: "season",
      adjustmentBps: seasonAdjustment,
      reason: `${{ spring: "春季平季", summer: "夏季旺季", autumn: "秋季平季", winter: "冬季淡季" }[context.season]} ${signedPercent(seasonAdjustment)}`,
    },
    {
      key: "occupancy",
      adjustmentBps: Math.trunc((context.trailingSevenDayOccupancyBps - 5_000) / 5),
      reason: "",
    },
    {
      key: "segmentDemand",
      adjustmentBps: Math.trunc((context.segmentDemandBps - 5_000) / 5),
      reason: "",
    },
    {
      key: "reputation",
      adjustmentBps: Math.trunc((context.reputationBps - 5_000) / 10),
      reason: "",
    },
    {
      key: "remainingInventory",
      adjustmentBps: Math.trunc((5_000 - context.remainingInventoryBps) / 5),
      reason: "",
    },
  ];
  adjustments[1].reason = `近7日入住率 ${context.trailingSevenDayOccupancyBps / 100}% ${signedPercent(adjustments[1].adjustmentBps)}`;
  adjustments[2].reason = `客群需求 ${context.segmentDemandBps / 100}% ${signedPercent(adjustments[2].adjustmentBps)}`;
  adjustments[3].reason = `酒店声誉 ${context.reputationBps / 100}% ${signedPercent(adjustments[3].adjustmentBps)}`;
  adjustments[4].reason = `剩余库存 ${context.remainingInventoryBps / 100}% ${signedPercent(adjustments[4].adjustmentBps)}`;

  const totalAdjustmentBps = adjustments.reduce(
    (total, factor) => total + factor.adjustmentBps,
    0,
  );
  const rawRate = Number(
    (BigInt(policy.baseRateCents) * BigInt(10_000 + totalAdjustmentBps)) /
      10_000n,
  );
  const rateCents = Math.max(
    policy.minRateCents,
    Math.min(policy.maxRateCents, rawRate),
  );
  const reasons = adjustments.map(({ reason }) => reason);
  if (rateCents !== rawRate) {
    reasons.push(
      rateCents === policy.minRateCents
        ? `已限制为最低价 ${yuan(rateCents)}`
        : `已限制为最高价 ${yuan(rateCents)}`,
    );
  }

  return {
    rateCents,
    factors: adjustments.map(({ key, adjustmentBps }) => ({ key, adjustmentBps })),
    reasons,
  };
}

export function effectiveRate(
  policy: Readonly<PricePolicy>,
  context: Readonly<PricingContext>,
): number {
  return suggestRate(policy, context).rateCents;
}
