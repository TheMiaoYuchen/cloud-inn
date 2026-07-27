import { describe, expect, it } from "vitest";

import type { OperationsDailyReport } from "./operationsTypes";
import {
  aggregateMonthlyClose,
  aggregateWeeklyReport,
  projectPeriodicReports,
} from "./reporting";
import { createOperationsState } from "./createOperationsState";

function daily(day: number): OperationsDailyReport {
  return {
    day,
    segments: [
      { segmentId: "business", demand: 4, soldRooms: 2, averageRateCents: 100, revenueCents: 200, satisfactionBps: 7_000 },
      { segmentId: "couple", demand: 3, soldRooms: 2, averageRateCents: 50, revenueCents: 100, satisfactionBps: 8_000 },
    ],
    revenueCents: day * 1_000,
    operatingCostCents: day * 100,
    financeCostCents: day * 10,
    netIncomeCents: day * 890,
    endingCashCents: 1_000_000 + day,
    reputationBps: 5_000 + day,
    availableRooms: 5,
    soldRooms: 4,
    occupancyBps: day * 100,
    lostBookings: [
      { segmentId: "business", code: "price", count: 1, explanation: "price" },
      { segmentId: "couple", code: "service", count: 1, explanation: "service" },
    ],
    reviews: [
      { segmentId: "business", ratingBps: 7_000, text: "ok" },
      { segmentId: "couple", ratingBps: 8_000, text: "great" },
    ],
  };
}

describe("operations reporting", () => {
  it("aggregates an exact seven-day week with integer totals and stable code tie-breaks", () => {
    const reports = Array.from({ length: 7 }, (_, index) => daily(index + 1));
    const snapshot = structuredClone(reports);

    expect(aggregateWeeklyReport(reports)).toEqual({
      week: 1,
      startDay: 1,
      endDay: 7,
      revenueCents: 28_000,
      operatingCostCents: 2_800,
      financeCostCents: 280,
      netIncomeCents: 24_920,
      availableRooms: 35,
      soldRooms: 28,
      averageOccupancyBps: 400,
      reputationBps: 5_004,
      topResultCode: "segment:business",
      topReasonCode: "price",
      suggestedActionCode: "adjust-pricing",
    });
    expect(reports).toEqual(snapshot);
  });

  it("aggregates an exact thirty-day close without recalculating bookings", () => {
    const reports = Array.from({ length: 30 }, (_, index) => daily(index + 1));

    expect(aggregateMonthlyClose(reports)).toEqual({
      month: 1,
      startDay: 1,
      endDay: 30,
      revenueCents: 465_000,
      operatingCostCents: 46_500,
      financeCostCents: 4_650,
      netIncomeCents: 413_850,
      debtPaymentCents: 4_650,
      availableRooms: 150,
      soldRooms: 120,
      averageOccupancyBps: 1_550,
      reputationBps: 5_015,
      endingCashCents: 1_000_030,
      topResultCode: "segment:business",
      topReasonCode: "price",
      suggestedActionCode: "adjust-pricing",
    });
  });

  it("projects daily reports every day, weekly reports only at 7/14/21/28, and a monthly close at 30", () => {
    const operations = createOperationsState();
    for (let day = 1; day <= 30; day += 1) {
      operations.dailyReports.push(daily(day));
      const projected = projectPeriodicReports(operations);
      operations.weeklyReports = projected.weeklyReports;
      operations.monthlyCloses = projected.monthlyCloses;
      expect(operations.dailyReports).toHaveLength(day);
      expect(operations.weeklyReports.map(({ endDay }) => endDay)).toEqual(
        [7, 14, 21, 28].filter((boundary) => boundary <= day),
      );
      expect(operations.monthlyCloses.map(({ endDay }) => endDay)).toEqual(
        day === 30 ? [30] : [],
      );
    }

    const projectedAgain = projectPeriodicReports(operations);
    expect(projectedAgain.weeklyReports).toHaveLength(4);
    expect(projectedAgain.monthlyCloses).toHaveLength(1);
  });

  it("does not repeat the frozen weekly or monthly boundaries after day 30", () => {
    const operations = createOperationsState();
    operations.dailyReports = Array.from({ length: 37 }, (_, index) => daily(index + 1));

    const projected = projectPeriodicReports(operations);

    expect(projected.weeklyReports).toEqual([]);
    expect(projected.monthlyCloses).toEqual([]);
  });

  it("skips a calendar week when late initialization has no complete aligned window", () => {
    const operations = createOperationsState();
    operations.dailyReports = [daily(6), daily(7)];

    expect(projectPeriodicReports(operations)).toEqual({
      weeklyReports: [],
      monthlyCloses: [],
    });
  });

  it("projects week two when late initialization contains the complete days 8 through 14", () => {
    const operations = createOperationsState();
    operations.dailyReports = Array.from({ length: 9 }, (_, index) => daily(index + 6));

    const projected = projectPeriodicReports(operations);

    expect(projected.weeklyReports.map(({ week, startDay, endDay }) => ({ week, startDay, endDay })))
      .toEqual([{ week: 2, startDay: 8, endDay: 14 }]);
    expect(projected.monthlyCloses).toEqual([]);
  });

  it("skips the monthly close when operations initialize on day thirty", () => {
    const operations = createOperationsState();
    operations.dailyReports = [daily(30)];

    expect(projectPeriodicReports(operations)).toEqual({
      weeklyReports: [],
      monthlyCloses: [],
    });
  });

  it.each([
    [[daily(1), daily(3), daily(2), daily(4), daily(5), daily(6), daily(7)], "连续"],
    [[daily(1), daily(2), daily(2), daily(4), daily(5), daily(6), daily(7)], "唯一"],
    [[daily(1), daily(2), daily(3)], "七天"],
  ] as const)("rejects invalid weekly report history %#", (reports, message) => {
    expect(() => aggregateWeeklyReport(reports)).toThrow(message);
  });

  it("uses BigInt to reject overflowing report totals", () => {
    const reports = Array.from({ length: 7 }, (_, index) => ({
      ...daily(index + 1),
      revenueCents: Number.MAX_SAFE_INTEGER,
    }));

    expect(() => aggregateWeeklyReport(reports)).toThrow("安全整数");
  });

  it.each([
    [Array.from({ length: 7 }, (_, index) => daily(index)), "正"],
    [Array.from({ length: 7 }, (_, index) => daily(index + 2)), "对齐"],
  ] as const)("rejects a non-positive or misaligned weekly window %#", (reports, message) => {
    expect(() => aggregateWeeklyReport(reports)).toThrow(message);
  });

  it("rejects a monthly window not aligned to days 1 through 30", () => {
    const reports = Array.from({ length: 30 }, (_, index) => daily(index + 2));

    expect(() => aggregateMonthlyClose(reports)).toThrow("对齐");
  });

  it("rejects report windows beyond the day-30 operating horizon", () => {
    const week = Array.from({ length: 7 }, (_, index) => daily(index + 29));
    const month = Array.from({ length: 30 }, (_, index) => daily(index + 31));

    expect(() => aggregateWeeklyReport(week)).toThrow("30");
    expect(() => aggregateMonthlyClose(month)).toThrow("30");
  });
});
