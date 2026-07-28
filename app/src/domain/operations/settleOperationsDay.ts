import type { DailyReport } from "../game/state";
import { projectOperationsFinance, validateLoans } from "./finance";
import type { OperationsDailyReport, OperationsState } from "./operationsTypes";
import { projectReputationUnlocks } from "./unlocks";
import {
  settleRoomDemand,
  type RoomDemandSettlementResult,
} from "./settleRoomDemand";
import type { RoomOffer } from "./roomOffer";

export { compareCodeUnits } from "./settleRoomDemand";

export interface OperationsSettlementInput {
  day: number;
  cashCents: number;
  operations: Readonly<OperationsState>;
  offers: ReadonlyArray<Readonly<RoomOffer>>;
}

export interface OperationsSettlementResult {
  report: OperationsDailyReport;
  legacyReport: DailyReport;
  operations: OperationsState;
  cashCents: number;
}

export interface SharedSettlementFinalizerInput {
  day: number;
  cashCents: number;
  operations: Readonly<OperationsState>;
  room: Readonly<RoomDemandSettlementResult>;
  publicSpaceRevenueCents?: number;
  facilityOperatingCostCents?: number;
  facilityReputationDeltaBps?: number;
  includePhase4Categories?: boolean;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function safeNumber(value: bigint, label: string, allowNegative = false): number {
  if (value > MAX_SAFE_BIGINT || value < (allowNegative ? -MAX_SAFE_BIGINT : 0n)) {
    throw new Error(`${label}超出安全整数范围`);
  }
  return Number(value);
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负安全整数`);
  }
}

function validateFinalizerInput(input: Readonly<SharedSettlementFinalizerInput>): void {
  assertSafeInteger(input.cashCents, "现金");
  if (input.operations.difficulty !== "casual" && input.operations.difficulty !== "management") {
    throw new Error("经营难度无效");
  }
  validateLoans(input.operations.loans);
  projectReputationUnlocks(input.operations, input.operations.reputationBps);
  assertSafeInteger(input.publicSpaceRevenueCents ?? 0, "公共空间收入");
  assertSafeInteger(input.facilityOperatingCostCents ?? 0, "设施经营成本");
  const facilityDelta = input.facilityReputationDeltaBps ?? 0;
  if (!Number.isSafeInteger(facilityDelta) || facilityDelta < -10_000 || facilityDelta > 10_000) {
    throw new Error("设施声誉证据必须是 -10000 到 10000 的安全整数");
  }
}

export function finalizeOperationsSettlement(
  input: Readonly<SharedSettlementFinalizerInput>,
): OperationsSettlementResult {
  validateFinalizerInput(input);
  const publicSpaceRevenueCents = input.publicSpaceRevenueCents ?? 0;
  const facilityOperatingCostCents = input.facilityOperatingCostCents ?? 0;
  const revenueCents = safeNumber(
    BigInt(input.room.roomRevenueCents) + BigInt(publicSpaceRevenueCents),
    "营业收入",
  );
  const operatingCostCents = safeNumber(
    BigInt(input.room.departmentCostCents) + BigInt(facilityOperatingCostCents),
    "经营成本",
  );
  const finance = projectOperationsFinance({
    difficulty: input.operations.difficulty,
    cashCents: input.cashCents,
    revenueCents,
    operatingCostCents,
    loans: input.operations.loans,
  });
  const combinedReputationDeltaBps = Math.max(
    -10_000,
    Math.min(10_000, input.room.reputationDeltaBps + (input.facilityReputationDeltaBps ?? 0)),
  );
  const reputationBps = Math.max(
    0,
    Math.min(10_000, input.operations.reputationBps + combinedReputationDeltaBps),
  );
  const report: OperationsDailyReport = {
    day: input.day,
    segments: input.room.segments.map((segment) => ({ ...segment })),
    revenueCents,
    operatingCostCents,
    financeCostCents: finance.interestCents,
    netIncomeCents: finance.netIncomeCents,
    endingCashCents: finance.endingCashCents,
    reputationBps,
    availableRooms: input.room.availableRooms,
    soldRooms: input.room.soldRooms,
    occupancyBps: input.room.occupancyBps,
    ...(input.includePhase4Categories ? {
      departmentCostCents: input.room.departmentCostCents,
      roomRevenueCents: input.room.roomRevenueCents,
      publicSpaceRevenueCents,
      facilityOperatingCostCents,
    } : {}),
    loanInterestCents: finance.interestCents,
    cashShortfallCents: finance.cashShortfallCents,
    lostBookings: input.room.lostBookings.map((reason) => ({ ...reason })),
    reviews: input.room.reviews.map((review) => ({ ...review })),
    bookings: input.room.bookings.map((booking) => ({ ...booking })),
    reputationDeltaBps: reputationBps - input.operations.reputationBps,
    discoveredNeeds: input.room.discoveredNeeds.map((need) => ({ ...need })),
  };
  const operations = structuredClone(input.operations) as OperationsState;
  operations.dailyReports = [...operations.dailyReports, report];
  operations.reputationBps = reputationBps;
  Object.assign(operations, projectReputationUnlocks(input.operations, reputationBps));
  operations.discoveredNeeds = [
    ...operations.discoveredNeeds,
    ...input.room.discoveredNeeds.map((need) => ({ ...need })),
  ];
  operations.loans = finance.loans;
  operations.offerUpgrades = structuredClone(input.room.renovationProgress);
  operations.segmentMix = input.room.segmentMix === undefined
    ? undefined
    : { ...input.room.segmentMix };

  return {
    report,
    legacyReport: {
      day: input.day,
      availableRooms: input.room.availableRooms,
      soldRooms: input.room.soldRooms,
      occupancyBps: input.room.occupancyBps,
      rateCents: input.room.soldRooms === 0
        ? 0
        : Math.trunc(input.room.roomRevenueCents / input.room.soldRooms),
      revenueCents,
      operatingCostCents: finance.totalCostCents,
      netIncomeCents: report.netIncomeCents,
      endingCashCents: report.endingCashCents,
      reasons: input.room.lostBookings.map(({ explanation }) => explanation),
    },
    operations,
    cashCents: finance.endingCashCents,
  };
}

export function settleOperationsDay(
  input: Readonly<OperationsSettlementInput>,
): OperationsSettlementResult {
  const room = settleRoomDemand({
    day: input.day,
    operations: input.operations,
    offers: input.offers,
  });
  return finalizeOperationsSettlement({
    day: input.day,
    cashCents: input.cashCents,
    operations: input.operations,
    room,
  });
}
