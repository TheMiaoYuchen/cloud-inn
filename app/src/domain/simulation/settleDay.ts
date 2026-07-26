import { prototypeConfig } from "../config/prototypeConfig";
import type { DailyReport } from "../game/state";
import { assertSafeMoney } from "../primitives";

export interface SettlementInput {
  day: number;
  cashCents: number;
  availableRooms: number;
  rateCents: number;
  suggestedRateCents: number;
  areaSquareMeters: number;
}

function assertValidInput(input: SettlementInput): void {
  if (!Number.isSafeInteger(input.day) || input.day <= 0) {
    throw new Error("营业日必须是正安全整数");
  }

  assertSafeMoney(input.cashCents);
  assertSafeMoney(input.rateCents);
  assertSafeMoney(input.suggestedRateCents);
  if (input.suggestedRateCents === 0) {
    throw new Error("建议房价必须大于零");
  }

  if (
    !Number.isSafeInteger(input.availableRooms) ||
    input.availableRooms < 0
  ) {
    throw new Error("可售房间数必须是非负安全整数");
  }

  const areaInCells =
    input.areaSquareMeters / prototypeConfig.cellAreaSquareMeters;
  if (
    !Number.isFinite(input.areaSquareMeters) ||
    input.areaSquareMeters <= 0 ||
    !Number.isInteger(areaInCells)
  ) {
    throw new Error(
      `房间面积必须是按${prototypeConfig.cellAreaSquareMeters}㎡递增的正有限数`,
    );
  }
}

export function settleDay(input: SettlementInput): DailyReport {
  assertValidInput(input);

  const rateCents = BigInt(input.rateCents);
  const suggestedRateCents = BigInt(input.suggestedRateCents);
  const twiceSuggestedRateCents = 2n * suggestedRateCents;
  const convertedDemand =
    rateCents <= suggestedRateCents
      ? prototypeConfig.businessDemandPerDay
      : rateCents >= twiceSuggestedRateCents
        ? 0
        : Number(
            (BigInt(prototypeConfig.businessDemandPerDay) *
              (twiceSuggestedRateCents - rateCents)) /
              suggestedRateCents,
          );
  const soldRooms = Math.min(input.availableRooms, convertedDemand);
  const revenueCents = assertSafeMoney(soldRooms * input.rateCents);
  const operatingCostCents = assertSafeMoney(
    input.availableRooms * prototypeConfig.availableRoomCostCents +
      soldRooms * prototypeConfig.occupiedRoomCostCents,
  );
  const netIncomeCents = revenueCents - operatingCostCents;
  const endingCashCents = assertSafeMoney(input.cashCents + netIncomeCents);
  const occupancyBps =
    input.availableRooms === 0
      ? 0
      : Math.floor((soldRooms * 10_000) / input.availableRooms);
  const areaReason =
    input.areaSquareMeters ===
    prototypeConfig.businessFitIdealAreaSquareMeters
      ? `${input.areaSquareMeters}㎡满足商务客的面积期望`
      : input.areaSquareMeters <
          prototypeConfig.businessFitIdealAreaSquareMeters
        ? `${input.areaSquareMeters}㎡低于商务客的面积期望`
        : `${input.areaSquareMeters}㎡高于商务客的面积期望`;

  return {
    day: input.day,
    availableRooms: input.availableRooms,
    soldRooms,
    occupancyBps,
    rateCents: input.rateCents,
    revenueCents,
    operatingCostCents,
    netIncomeCents,
    endingCashCents,
    reasons: [
      areaReason,
      rateCents === suggestedRateCents
        ? "房价处于建议价，需求转化正常"
        : rateCents >= twiceSuggestedRateCents
          ? "房价达到建议价两倍，商务需求未转化"
          : "房价变化影响了需求转化",
    ],
  };
}
