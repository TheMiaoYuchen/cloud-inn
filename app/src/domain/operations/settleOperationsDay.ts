import type { DailyReport } from "../game/state";
import { GUEST_SEGMENT_IDS, type LostBookingReason, type OperationsDailyReport, type OperationsState } from "./operationsTypes";
import { matchGuest } from "./matchGuest";
import { GUEST_SEGMENTS } from "./segmentCatalog";
import type { RoomOffer } from "./roomOffer";
import { calculateServiceCapacity } from "./serviceCapacity";
import { projectOperationsFinance, validateLoans } from "./finance";
import { projectReputationUnlocks } from "./unlocks";
import {
  applyRoomOfferUpgrades,
  roomOfferRenovationKind,
  validateRoomOfferUpgrades,
} from "./renovation";

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

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const LOSS_CODE_ORDER = ["hard-requirement", "price", "service", "no-inventory"] as const;

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeNumber(value: bigint, label: string, allowNegative = false): number {
  if (value > MAX_SAFE_BIGINT || value < (allowNegative ? -MAX_SAFE_BIGINT : 0n)) {
    throw new Error(`${label}超出安全整数范围`);
  }
  return Number(value);
}

function assertSafeInteger(value: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(`${label}必须是${positive ? "正" : "非负"}安全整数`);
  }
}

function validateInput(input: Readonly<OperationsSettlementInput>): void {
  assertSafeInteger(input.day, "营业日", true);
  assertSafeInteger(input.cashCents, "现金");
  if (input.operations.difficulty !== "casual" && input.operations.difficulty !== "management") {
    throw new Error("经营难度无效");
  }
  assertSafeInteger(input.operations.reputationBps, "声誉");
  if (input.operations.reputationBps > 10_000) throw new Error("声誉必须是 0 到 10000 的安全整数");
  assertSafeInteger(input.operations.maximumReputationBps, "最高声誉");
  if (input.operations.maximumReputationBps > 10_000) {
    throw new Error("最高声誉必须是 0 到 10000 的安全整数");
  }
  if (input.operations.maximumReputationBps < input.operations.reputationBps) {
    throw new Error("最高声誉不能低于当前声誉");
  }
  let previousReportDay = 0;
  for (const report of input.operations.dailyReports) {
    if (!Number.isSafeInteger(report.day) || report.day <= previousReportDay) {
      throw new Error("经营日报日期必须是唯一且严格递增的正安全整数");
    }
    previousReportDay = report.day;
  }
  if (input.day <= previousReportDay) {
    throw new Error("营业日必须晚于最后一份经营日报");
  }
  validateLoans(input.operations.loans);
  projectReputationUnlocks(input.operations, input.operations.reputationBps);
  const offerIds = new Set<string>();
  for (const offer of input.offers) {
    if (offer.id.trim().length === 0) throw new Error("客房产品编号不能为空");
    if (offerIds.has(offer.id)) throw new Error("客房产品编号必须唯一");
    offerIds.add(offer.id);
    if (!offer.sourceRoomId) throw new Error("客房产品房间编号不能为空");
    if (!Number.isSafeInteger(offer.nightlyRateCents) || offer.nightlyRateCents < 0) {
      throw new Error("客房产品房价必须是非负安全整数");
    }
    if (!Number.isSafeInteger(offer.capacity) || offer.capacity <= 0) {
      throw new Error("客房产品容量必须是正安全整数");
    }
    if (!Number.isFinite(offer.areaSquareMeters) || offer.areaSquareMeters <= 0) {
      throw new Error("客房产品面积必须是正有限数");
    }
    for (const value of [
      offer.viewBps,
      offer.workspaceBps,
      offer.quietBps,
      offer.privacyBps,
      ...GUEST_SEGMENT_IDS.map((segmentId) => offer.designAffinities[segmentId]),
    ]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
        throw new Error("客房产品比例必须是 0 到 10000 的安全整数");
      }
    }
  }
}

function meetsHardRequirements(
  segment: (typeof GUEST_SEGMENTS)[number],
  offer: Readonly<RoomOffer>,
): boolean {
  const requirements = segment.hardRequirements;
  return (requirements.minimumCapacity === undefined || offer.capacity >= requirements.minimumCapacity)
    && (segment.id !== "family" || offer.bedType === "twin")
    && (requirements.minimumAreaSquareMeters === undefined || offer.areaSquareMeters >= requirements.minimumAreaSquareMeters)
    && (!requirements.requiredBedTypes || requirements.requiredBedTypes.includes(offer.bedType));
}

function maximumAcceptedRateCents(
  segment: (typeof GUEST_SEGMENTS)[number],
): number {
  return 240_000 - segment.priceSensitivityBps * 10;
}

export function settleOperationsDay(
  input: Readonly<OperationsSettlementInput>,
): OperationsSettlementResult {
  validateInput(input);
  validateRoomOfferUpgrades(input.offers, input.operations);
  const demandPattern = [0, 1, 0, 2, 1, 3, 2] as const;
  const segments = GUEST_SEGMENTS.map((segment) => ({
    segmentId: segment.id,
    demand: segment.baseDailyDemand + demandPattern[(input.day - 1) % demandPattern.length],
    soldRooms: 0,
    averageRateCents: 0,
    revenueCents: 0,
    satisfactionBps: 0,
  }));
  const pricedOffers = input.offers
    .filter((offer) => !Object.values(input.operations.offerUpgrades).some((upgrade) =>
      roomOfferRenovationKind(upgrade) !== null
        && upgrade.roomOfferId === offer.id
        && (upgrade.remainingClosureDays ?? 0) > 0,
    ))
    .map((offer) => ({
      ...applyRoomOfferUpgrades(offer, input.operations),
      nightlyRateCents: input.operations.pricePolicies[offer.id]?.nightlyRateCents
        ?? offer.nightlyRateCents,
    }));
  for (const offer of pricedOffers) {
    if (!Number.isSafeInteger(offer.nightlyRateCents) || offer.nightlyRateCents < 0) {
      throw new Error("有效房价必须是非负安全整数");
    }
  }
  const availableRooms = new Set(pricedOffers.map(({ sourceRoomId }) => sourceRoomId)).size;
  const service = calculateServiceCapacity(input.operations.departments, {
    occupiedRooms: availableRooms,
    availableRooms,
  });
  const serviceSlots = service.overallBps === 0
    ? 0
    : Math.trunc((availableRooms * service.overallBps + 9_999) / 10_000);
  const candidates = GUEST_SEGMENTS.flatMap((segment, segmentIndex) =>
    Array.from({ length: segments[segmentIndex].demand }, (_, demandIndex) =>
      pricedOffers.flatMap((offer) => {
        const match = matchGuest(segment, offer);
        if (!match.eligible || offer.nightlyRateCents > maximumAcceptedRateCents(segment)) {
          return [];
        }
        return [{
          segmentIndex,
          demandIndex,
          offer,
          score: match.preferenceScoreBps ?? 0,
          priceFit: maximumAcceptedRateCents(segment) - offer.nightlyRateCents,
        }];
      }),
    ).flat(),
  ).sort((left, right) =>
    right.score - left.score
      || right.priceFit - left.priceFit
      || left.segmentIndex - right.segmentIndex
      || compareCodeUnits(left.offer.sourceRoomId, right.offer.sourceRoomId)
      || compareCodeUnits(left.offer.id, right.offer.id)
      || left.demandIndex - right.demandIndex,
  );
  const soldOffers = new Set<string>();
  const soldRoomsInventory = new Set<string>();
  const soldDemand = new Set<string>();
  const assignments: typeof candidates = [];
  for (const candidate of candidates) {
    if (assignments.length >= serviceSlots) break;
    const demandKey = `${candidate.segmentIndex}:${candidate.demandIndex}`;
    if (
      soldOffers.has(candidate.offer.id)
      || soldRoomsInventory.has(candidate.offer.sourceRoomId)
      || soldDemand.has(demandKey)
    ) continue;
    soldOffers.add(candidate.offer.id);
    soldRoomsInventory.add(candidate.offer.sourceRoomId);
    soldDemand.add(demandKey);
    assignments.push(candidate);
  }
  for (const assignment of assignments) {
    const result = segments[assignment.segmentIndex];
    result.soldRooms += 1;
    result.revenueCents += assignment.offer.nightlyRateCents;
  }
  for (const result of segments) {
    result.averageRateCents = result.soldRooms === 0
      ? 0
      : Math.trunc(result.revenueCents / result.soldRooms);
    const segmentIndex = GUEST_SEGMENT_IDS.indexOf(result.segmentId);
    const scores = assignments
      .filter((assignment) => assignment.segmentIndex === segmentIndex)
      .map(({ score }) => score);
    result.satisfactionBps = scores.length === 0
      ? 0
      : Math.trunc(
          (Math.trunc(scores.reduce((sum, score) => sum + score, 0) / scores.length)
            + service.overallBps) / 2,
        );
  }
  let remainingServiceLoss = Math.max(0, availableRooms - serviceSlots);
  const lostBookings: LostBookingReason[] = segments.flatMap((result): LostBookingReason[] => {
    const segment = GUEST_SEGMENTS.find(({ id }) => id === result.segmentId)!;
    const eligibleOffers = pricedOffers.filter((offer) => meetsHardRequirements(segment, offer));
    const affordableOffers = eligibleOffers.filter(
      ({ nightlyRateCents }) => nightlyRateCents <= maximumAcceptedRateCents(segment),
    );
    if (pricedOffers.length === 0) {
      return [{ segmentId: result.segmentId, code: "no-inventory" as const, count: result.demand, explanation: `没有可售客房，未能承接${segment.displayName}的需求` }];
    }
    if (eligibleOffers.length === 0) {
      return [{ segmentId: result.segmentId, code: "hard-requirement" as const, count: result.demand, explanation: result.segmentId === "family" ? "没有客房同时满足家庭出游的容量与床型硬要求" : `没有客房满足${segment.displayName}的入住硬要求` }];
    }
    if (affordableOffers.length === 0) {
      return [{ segmentId: result.segmentId, code: "price" as const, count: result.demand, explanation: `可用客房价格超出${segment.displayName}的接受范围` }];
    }
    const unserved = result.demand - result.soldRooms;
    if (unserved === 0) return [];
    const serviceLoss = Math.min(unserved, remainingServiceLoss);
    remainingServiceLoss -= serviceLoss;
    const inventoryLoss = unserved - serviceLoss;
    return [
      ...(serviceLoss > 0 ? [{ segmentId: result.segmentId, code: "service" as const, count: serviceLoss, explanation: `部门服务能力不足，未能承接${segment.displayName}的合规预订` }] : []),
      ...(inventoryLoss > 0 ? [{ segmentId: result.segmentId, code: "no-inventory" as const, count: inventoryLoss, explanation: `可售客房已分配完毕，未能承接${segment.displayName}的其余需求` }] : []),
    ];
  }).sort((left, right) =>
    GUEST_SEGMENT_IDS.indexOf(left.segmentId) - GUEST_SEGMENT_IDS.indexOf(right.segmentId)
      || LOSS_CODE_ORDER.indexOf(left.code) - LOSS_CODE_ORDER.indexOf(right.code),
  );
  const soldRooms = assignments.length;
  const revenueCents = safeNumber(
    segments.reduce((sum, result) => sum + BigInt(result.revenueCents), 0n),
    "客房收入",
  );
  const departmentCostCents = safeNumber(BigInt(service.dailyCostCents), "部门成本");
  const finance = projectOperationsFinance({
    difficulty: input.operations.difficulty,
    cashCents: input.cashCents,
    revenueCents,
    operatingCostCents: departmentCostCents,
    loans: input.operations.loans,
  });
  const loanInterestCents = finance.interestCents;
  const totalCostCents = finance.totalCostCents;
  const netIncomeCents = finance.netIncomeCents;
  const cashShortfallCents = finance.cashShortfallCents;
  const endingCashCents = finance.endingCashCents;
  const reviewedSegments = segments.filter(({ soldRooms: sold }) => sold > 0);
  const reviews = reviewedSegments.map((result) => {
    const segment = GUEST_SEGMENTS.find(({ id }) => id === result.segmentId)!;
    return {
      segmentId: result.segmentId,
      ratingBps: result.satisfactionBps,
      text: result.satisfactionBps >= 7_000
        ? `${segment.displayName}：入住体验顺畅，客房与服务符合期待。`
        : `${segment.displayName}：入住体验尚可，但客房或服务仍有改进空间。`,
    };
  });
  const averageSatisfactionBps = reviews.length === 0
    ? input.operations.reputationBps
    : Math.trunc(reviews.reduce((sum, review) => sum + review.ratingBps, 0) / reviews.length);
  const reputationDeltaBps = Math.max(
    -200,
    Math.min(200, Math.trunc((averageSatisfactionBps - 5_000) / 20)),
  );
  const reputationBps = Math.max(
    0,
    Math.min(10_000, input.operations.reputationBps + reputationDeltaBps),
  );
  const newDiscoveries = reviewedSegments.flatMap((result) => {
    if (result.satisfactionBps >= 7_000) return [];
    const segment = GUEST_SEGMENTS.find(({ id }) => id === result.segmentId)!;
    const id = `need:${result.segmentId}:${segment.initiallyHiddenNeedLabels[0]}`;
    if (input.operations.discoveredNeeds.some((need) => need.id === id)) return [];
    return [{
      id,
      segmentId: result.segmentId,
      kind: "room-feature" as const,
      discoveredDay: input.day,
      strengthBps: 10_000 - result.satisfactionBps,
    }];
  });
  const report: OperationsDailyReport = {
    day: input.day,
    segments,
    revenueCents,
    operatingCostCents: departmentCostCents,
    financeCostCents: loanInterestCents,
    netIncomeCents,
    endingCashCents,
    reputationBps,
    availableRooms,
    soldRooms,
    occupancyBps: availableRooms === 0 ? 0 : Math.trunc((soldRooms * 10_000) / availableRooms),
    departmentCostCents,
    roomRevenueCents: revenueCents,
    loanInterestCents,
    cashShortfallCents,
    lostBookings,
    reviews,
    bookings: assignments
      .map((assignment) => ({
        segmentId: GUEST_SEGMENTS[assignment.segmentIndex].id,
        roomId: assignment.offer.sourceRoomId,
        offerId: assignment.offer.id,
        rateCents: assignment.offer.nightlyRateCents,
      }))
      .sort((left, right) => compareCodeUnits(left.offerId, right.offerId)),
    reputationDeltaBps,
    discoveredNeeds: newDiscoveries,
  };
  const operations = structuredClone(input.operations) as OperationsState;
  operations.dailyReports = [...operations.dailyReports, report];
  operations.reputationBps = reputationBps;
  Object.assign(operations, projectReputationUnlocks(input.operations, reputationBps));
  operations.discoveredNeeds = [...operations.discoveredNeeds, ...newDiscoveries];
  operations.loans = finance.loans;
  operations.offerUpgrades = Object.fromEntries(
    Object.entries(operations.offerUpgrades).map(([key, upgrade]) => {
      if (roomOfferRenovationKind(upgrade) === null) return [key, upgrade];
      return [key, {
        ...upgrade,
        remainingClosureDays: Math.max(0, (upgrade.remainingClosureDays ?? 0) - 1),
      }];
    }),
  );
  if (soldRooms > 0) {
    let allocatedBps = 0;
    let lastSoldIndex = 0;
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index].soldRooms > 0) lastSoldIndex = index;
    }
    operations.segmentMix = Object.fromEntries(
      segments.map((segment, index) => {
        const bps = index === lastSoldIndex
          ? 10_000 - allocatedBps
          : Math.trunc((segment.soldRooms * 10_000) / soldRooms);
        allocatedBps += bps;
        return [segment.segmentId, bps];
      }),
    );
  }
  return {
    report,
    legacyReport: {
      day: input.day,
      availableRooms,
      soldRooms,
      occupancyBps: report.occupancyBps ?? 0,
      rateCents: soldRooms === 0 ? 0 : Math.trunc(revenueCents / soldRooms),
      revenueCents,
      operatingCostCents: totalCostCents,
      netIncomeCents: report.netIncomeCents,
      endingCashCents: report.endingCashCents,
      reasons: lostBookings.map(({ explanation }) => explanation),
    },
    operations,
    cashCents: endingCashCents,
  };
}
