import { describe, expect, it } from "vitest";

import { createNewGame } from "../game/state";
import { createOperationsState } from "./createOperationsState";
import type {
  DepartmentId,
  Difficulty,
  DiscoveredMarketNeed,
  GuestSegmentId,
  LoanState,
  MonthlyOperationsClose,
  OperationsDailyReport,
  OperationsState,
  RoomOfferUpgrade,
  RoomPricePolicy,
  SegmentDayResult,
  WeeklyOperationsReport,
} from "./operationsTypes";
import { DEPARTMENT_IDS, GUEST_SEGMENT_IDS } from "./operationsTypes";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

type ApprovedGuestSegmentId =
  | "business"
  | "couple"
  | "family"
  | "leisure"
  | "high-net-worth"
  | "cultural-experience";
type GuestSegmentCatalogIsExact = Expect<
  Equal<GuestSegmentId, ApprovedGuestSegmentId>
>;
const guestSegmentCatalogIsExact: GuestSegmentCatalogIsExact = true;

type ApprovedDepartmentId =
  | "frontOffice"
  | "housekeeping"
  | "foodAndBeverage"
  | "engineering"
  | "security"
  | "guestRelations";
type DepartmentCatalogIsExact = Expect<
  Equal<DepartmentId, ApprovedDepartmentId>
>;
const departmentCatalogIsExact: DepartmentCatalogIsExact = true;

describe("operations state contracts", () => {
  it("exports the exact approved guest segment catalog", () => {
    expect(guestSegmentCatalogIsExact).toBe(true);
    expect(GUEST_SEGMENT_IDS).toEqual([
      "business",
      "couple",
      "family",
      "leisure",
      "high-net-worth",
      "cultural-experience",
    ]);
  });

  it("exports the exact approved department catalog", () => {
    expect(departmentCatalogIsExact).toBe(true);
    expect(DEPARTMENT_IDS).toEqual([
      "frontOffice",
      "housekeeping",
      "foodAndBeverage",
      "engineering",
      "security",
      "guestRelations",
    ]);
  });
  it("creates the approved casual operations envelope without changing legacy state", () => {
    const game = createNewGame("phase-3");
    const operations = createOperationsState("casual");

    expect(operations).toMatchObject({
      rulesetVersion: "operations-v1",
      difficulty: "casual",
      reputationBps: 5_000,
      maximumReputationBps: 5_000,
      timeSpeed: 0,
      lastOfflineCheckpointMs: null,
    });
    expect(Object.keys(operations.departments)).toEqual([
      "frontOffice",
      "housekeeping",
      "foodAndBeverage",
      "engineering",
      "security",
      "guestRelations",
    ]);
    expect(game.operations).toBeUndefined();
  });

  it("uses deterministic immutable defaults without reading wall-clock time", () => {
    const first = createOperationsState("management");
    const second = createOperationsState("management");

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.lastOfflineCheckpointMs).toBeNull();
    expect(first.pricePolicies).toEqual({});
    expect(first.offerUpgrades).toEqual({});
    expect(first.loans).toEqual([]);
    expect(first.discoveredNeeds).toEqual([]);
    expect(first.dailyReports).toEqual([]);
    expect(first.weeklyReports).toEqual([]);
    expect(first.monthlyCloses).toEqual([]);
    expect(first.unlockedContent).toEqual([]);
    expect(Object.values(first.departments)).toEqual(
      Object.keys(first.departments).map((id) => ({
        id,
        staffing: 0,
        dailyBudgetCents: 0,
        trainingBps: 0,
        serviceStandardBps: 5_000,
      })),
    );
  });

  it("creates deeply independent operations records and collections", () => {
    const first = createOperationsState("casual");
    const second = createOperationsState("casual");

    first.departments.frontOffice.staffing = 12;
    first.loans.push({
      id: "loan-mutated",
      principalCents: 1,
      outstandingCents: 1,
      dailyInterestBps: 1,
      minimumPaymentCents: 1,
    });
    first.discoveredNeeds.push({
      id: "need-mutated",
      segmentId: "business",
      kind: "service",
      discoveredDay: 1,
      strengthBps: 1,
    });
    first.pricePolicies.mutated = {
      roomOfferId: "mutated",
      nightlyRateCents: 1,
    };
    first.offerUpgrades.mutated = {
      roomOfferId: "mutated",
      upgradeId: "mutated",
      level: 1,
    };
    first.unlockedContent.push("mutated");

    expect(second).toEqual(createOperationsState("casual"));
  });

  it("exposes persisted discriminated records for future simulation phases", () => {
    const difficulty: Difficulty = "management";
    const segmentId: GuestSegmentId = "business";
    const departmentId: DepartmentId = "frontOffice";
    const pricePolicy: RoomPricePolicy = {
      roomOfferId: "deluxe-king",
      nightlyRateCents: 120_000,
    };
    const upgrade: RoomOfferUpgrade = {
      roomOfferId: "deluxe-king",
      upgradeId: "club-access",
      level: 1,
    };
    const loan: LoanState = {
      id: "loan-1",
      principalCents: 1_000_000,
      outstandingCents: 900_000,
      dailyInterestBps: 10,
      minimumPaymentCents: 10_000,
    };
    const segment: SegmentDayResult = {
      segmentId,
      demand: 10,
      soldRooms: 8,
      averageRateCents: 120_000,
      revenueCents: 960_000,
      satisfactionBps: 8_000,
    };
    const daily: OperationsDailyReport = {
      day: 1,
      segments: [segment],
      revenueCents: 960_000,
      operatingCostCents: 100_000,
      financeCostCents: 1_000,
      netIncomeCents: 859_000,
      endingCashCents: 2_000_000,
      reputationBps: 5_100,
    };
    const weekly: WeeklyOperationsReport = {
      week: 1,
      startDay: 1,
      endDay: 7,
      revenueCents: 6_000_000,
      netIncomeCents: 2_000_000,
      averageOccupancyBps: 7_500,
      reputationBps: 5_100,
    };
    const monthly: MonthlyOperationsClose = {
      month: 1,
      startDay: 1,
      endDay: 30,
      revenueCents: 24_000_000,
      netIncomeCents: 8_000_000,
      debtPaymentCents: 100_000,
      endingCashCents: 10_000_000,
    };
    const need: DiscoveredMarketNeed = {
      id: "need-1",
      segmentId,
      kind: "room-feature",
      discoveredDay: 1,
      strengthBps: 7_000,
    };
    const operations: OperationsState = {
      ...createOperationsState(difficulty),
      pricePolicies: { [pricePolicy.roomOfferId]: pricePolicy },
      offerUpgrades: { [upgrade.roomOfferId]: upgrade },
      loans: [loan],
      discoveredNeeds: [need],
      dailyReports: [daily],
      weeklyReports: [weekly],
      monthlyCloses: [monthly],
    };

    expect(operations.departments[departmentId].id).toBe(departmentId);
    expect(operations.dailyReports[0].segments[0].segmentId).toBe(segmentId);
  });
});
