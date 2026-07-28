import { describe, expect, it } from "vitest";

import { projectHotelInventory } from "../building/hotelInventory";
import { createApprovedOperations } from "./operationsFixtures";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { settleHotelDay } from "./settleHotelDay";
import { createFacilityPolicy, settleFacilityOperations } from "../facilities/facilityOperations";
import { settleRoomDemand } from "./settleRoomDemand";
import { projectLoanSettlement } from "./finance";
import { projectRoomOfferUpgrade, roomOfferUpgradeKey } from "./renovation";

function settlementInput() {
  const state = createPhase4AcceptanceState("hotel-settlement");
  const operations = createApprovedOperations();
  const inventory = projectHotelInventory({ ...state, operations });
  for (const facility of Object.values(state.phase4!.facilities)) facility.enabled = false;
  const dining = Object.values(state.phase4!.facilities).find(
    ({ type }) => type === "all-day-dining",
  )!;
  dining.enabled = true;
  dining.status = "operating";
  dining.policy = createFacilityPolicy("all-day-dining", {
    positioningId: "positioning:international-luxury",
    priceBandId: "price-band:premium",
    capacity: 30,
    openingPolicyId: "opening-policy:breakfast-dinner",
    serviceBudgetCents: 180_000,
  });
  return {
    day: 1,
    seed: "phase4-hotel-settlement",
    cashCents: 8_000_000,
    operations,
    offers: inventory.rooms,
    phase4: state.phase4!,
  };
}

describe("settleHotelDay", () => {
  const historyRecord = (day: number) => ({
    day,
    visits: 1,
    revenueCents: 1,
    operatingCostCents: 1,
    utilizationBps: 1,
    satisfactionDeltaBps: 0,
    appealDeltaBps: 0,
    reasonCodes: [],
  });

  it("keeps exact report-v2 category arithmetic", () => {
    const report = settleHotelDay(settlementInput()).report;

    expect(report.revenueCents).toBe(
      report.roomRevenueCents! + report.publicSpaceRevenueCents!,
    );
    expect(report.operatingCostCents).toBe(
      report.departmentCostCents! + report.facilityOperatingCostCents!,
    );
    expect(report.netIncomeCents).toBe(
      report.revenueCents - report.operatingCostCents - report.financeCostCents,
    );
  });

  it("replays the same 120-room mixed hotel for 30 identical days", () => {
    const replay = () => {
      let input = settlementInput();
      for (let day = 1; day <= 30; day += 1) {
        const settled = settleHotelDay({ ...input, day });
        input = {
          ...input,
          cashCents: settled.cashCents,
          operations: settled.operations,
          phase4: settled.phase4,
        };
      }
      return input;
    };

    const first = replay();
    const second = replay();

    expect(second).toEqual(first);
    expect(first.operations.dailyReports).toHaveLength(30);
    expect(Object.values(first.phase4.facilities).find(
      ({ type }) => type === "all-day-dining",
    )?.dailyResults).toHaveLength(30);
  });

  it("appends one cloned facility result without mutating prior history", () => {
    const input = settlementInput();
    input.day = 2;
    const facility = Object.values(input.phase4.facilities).find(({ enabled }) => enabled)!;
    const prior = {
      day: 1,
      visits: 1,
      revenueCents: 1,
      operatingCostCents: 1,
      utilizationBps: 1,
      satisfactionDeltaBps: 0,
      appealDeltaBps: 0,
      reasonCodes: [],
    };
    facility.dailyResults = [prior];
    const snapshot = structuredClone(input);

    const settled = settleHotelDay(input);
    const next = settled.phase4.facilities[facility.id].dailyResults;

    expect(next.map(({ day }) => day)).toEqual([1, 2]);
    expect(next[0]).toEqual(prior);
    expect(next[0]).not.toBe(prior);
    expect(input).toEqual(snapshot);
  });

  it("rejects same-day facility history without appending or mutating settlement state", () => {
    const input = settlementInput();
    const facility = Object.values(input.phase4.facilities).find(({ enabled }) => enabled)!;
    facility.dailyResults = [{
      day: input.day,
      visits: 1,
      revenueCents: 1,
      operatingCostCents: 1,
      utilizationBps: 1,
      satisfactionDeltaBps: 0,
      appealDeltaBps: 0,
      reasonCodes: [],
    }];
    const snapshot = structuredClone(input);

    expect(() => settleHotelDay(input)).toThrow("设施历史日期必须早于当前营业日");
    expect(input).toEqual(snapshot);
  });

  it("rejects a 31st facility result before hotel economics or reports are finalized", () => {
    const input = settlementInput();
    input.day = 31;
    const facility = Object.values(input.phase4.facilities).find(({ enabled }) => enabled)!;
    facility.dailyResults = Array.from({ length: 30 }, (_, index) => historyRecord(index + 1));
    const snapshot = structuredClone(input);

    expect(() => settleHotelDay(input)).toThrow("设施历史已满 30 天");
    expect(input).toEqual(snapshot);
    expect(input.operations.dailyReports).toEqual([]);
  });

  it("appends exactly the 30th facility result on day 30", () => {
    const input = settlementInput();
    input.day = 30;
    const facility = Object.values(input.phase4.facilities).find(({ enabled }) => enabled)!;
    facility.dailyResults = Array.from({ length: 29 }, (_, index) => historyRecord(index + 1));

    const settled = settleHotelDay(input);

    expect(settled.phase4.facilities[facility.id].dailyResults.map(({ day }) => day))
      .toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(settled.operations.dailyReports).toHaveLength(1);
    expect(input.operations.dailyReports).toEqual([]);
    expect(facility.dailyResults).toHaveLength(29);
  });

  it("combines room and facility reputation evidence and finalizes loan interest once", () => {
    const input = settlementInput();
    input.operations.loans = [{
      id: "loan:hotel",
      principalCents: 1_000_000,
      outstandingCents: 1_000_000,
      dailyInterestBps: 100,
      minimumPaymentCents: 1_000,
    }];
    const room = settleRoomDemand(input);
    const facility = settleFacilityOperations({
      day: input.day,
      seed: input.seed,
      occupiedRooms: room.soldRooms,
      availableRooms: room.availableRooms,
      segmentMix: room.segmentMix ?? {},
      reputationBps: input.operations.reputationBps,
      departments: input.operations.departments,
      facilities: input.phase4.facilities,
      publicSpaces: input.phase4.publicSpaces,
      blueprints: input.phase4.spaceBlueprints,
    });

    const result = settleHotelDay(input);

    expect(result.report.loanInterestCents).toBe(
      projectLoanSettlement(input.operations.loans).interestCents,
    );
    expect(result.report.reputationDeltaBps).toBe(
      Math.max(-10_000, Math.min(10_000, room.reputationDeltaBps + facility.reputationDeltaBps)),
    );
    expect(result.operations.loans).toHaveLength(1);
  });

  it("advances a room renovation exactly once during mixed settlement", () => {
    const input = settlementInput();
    const offer = input.offers[0];
    const upgrade = projectRoomOfferUpgrade(offer, {
      roomOfferId: offer.id,
      kind: "workspace",
      level: 1,
    }).upgrade;
    upgrade.remainingClosureDays = 2;
    const key = roomOfferUpgradeKey(offer.id, "workspace");
    input.operations.offerUpgrades[key] = upgrade;

    const result = settleHotelDay(input);

    expect(result.operations.offerUpgrades[key].remainingClosureDays).toBe(1);
  });

  it("settles zero rooms and zero facilities with exact zero category totals", () => {
    const input = settlementInput();
    input.offers = [];
    input.phase4.facilities = {};

    const result = settleHotelDay(input);

    expect(result.report).toMatchObject({
      availableRooms: 0,
      soldRooms: 0,
      roomRevenueCents: 0,
      publicSpaceRevenueCents: 0,
      facilityOperatingCostCents: 0,
    });
    expect(result.phase4.recentFlowSnapshot?.events).toEqual([]);
  });

  it("keeps all-disabled facilities out of mixed-hotel economics", () => {
    const input = settlementInput();
    for (const facility of Object.values(input.phase4.facilities)) facility.enabled = false;

    const result = settleHotelDay(input);

    expect(result.report.publicSpaceRevenueCents).toBe(0);
    expect(result.report.facilityOperatingCostCents).toBe(0);
    expect(result.phase4.recentFlowSnapshot?.events).toEqual([]);
  });

  it("creates one deterministic settlement safety loan for a mixed-hotel cash shortfall", () => {
    const input = settlementInput();
    input.cashCents = 0;
    input.offers = [];
    input.phase4.facilities = {};

    const result = settleHotelDay(input);

    expect(result.operations.loans).toEqual([
      expect.objectContaining({
        id: "safety-loan:daily-settlement",
        principalCents: result.report.cashShortfallCents,
        outstandingCents: result.report.cashShortfallCents,
      }),
    ]);
  });
});
