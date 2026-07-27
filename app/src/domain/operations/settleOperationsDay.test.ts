import { describe, expect, it } from "vitest";

import { createApprovedOperations, createApprovedSettlementInput } from "./operationsFixtures";
import { GUEST_SEGMENT_IDS } from "./operationsTypes";
import { compareCodeUnits, settleOperationsDay } from "./settleOperationsDay";

describe("settleOperationsDay", () => {
  it("orders ASCII and non-ASCII identifiers by explicit code units", () => {
    expect(["房间", "z", "a", "酒店"].sort(compareCodeUnits)).toEqual([
      "a",
      "z",
      "房间",
      "酒店",
    ]);
  });
  it("replays the approved hotel for 30 days identically from independent inputs", () => {
    const replay = (clone: boolean) => {
      let input = createApprovedSettlementInput();
      if (clone) input = structuredClone(input);
      const reports = [];
      for (let day = 1; day <= 30; day += 1) {
        const settled = settleOperationsDay({ ...input, day });
        reports.push(settled.report);
        input = {
          ...input,
          cashCents: settled.cashCents,
          operations: settled.operations,
        };
      }
      return {
        reports,
        cashCents: input.cashCents,
        reputationBps: input.operations.reputationBps,
        loans: input.operations.loans,
        discoveredNeeds: input.operations.discoveredNeeds,
        segmentMix: input.operations.segmentMix,
      };
    };

    const first = replay(false);
    const second = replay(true);

    expect(first.reports).toHaveLength(30);
    expect(second).toEqual(first);
    expect(first.reports.every((report) =>
      (report.lostBookings ?? []).every((loss, index, losses) =>
        index === 0 || GUEST_SEGMENT_IDS.indexOf(loss.segmentId) >= GUEST_SEGMENT_IDS.indexOf(losses[index - 1].segmentId),
      ),
    )).toBe(true);
    expect(Object.values(first.segmentMix ?? {}).reduce((sum, bps) => sum + (bps ?? 0), 0)).toBe(10_000);
  });

  it("records hard requirements before any soft room matching", () => {
    const input = createApprovedSettlementInput();
    input.offers = input.offers
      .filter(({ id }) => id.includes("business"))
      .map((offer) => ({ ...offer, capacity: 2, bedType: "double" as const }));

    const { report } = settleOperationsDay(input);
    const family = report.segments.find(({ segmentId }) => segmentId === "family");

    expect(family?.demand).toBeGreaterThan(0);
    expect(family?.soldRooms).toBe(0);
    expect(report.lostBookings).toContainEqual({
      segmentId: "family",
      code: "hard-requirement",
      count: family?.demand,
      explanation: "没有客房同时满足家庭出游的容量与床型硬要求",
    });
  });

  it("reports price loss when an eligible room exceeds the segment price ceiling", () => {
    const input = createApprovedSettlementInput();
    input.offers = input.offers
      .filter(({ id }) => id.includes("business"))
      .map((offer) => ({ ...offer, nightlyRateCents: 500_000 }));

    const { report } = settleOperationsDay(input);
    const business = report.segments[0];

    expect(business.soldRooms).toBe(0);
    expect(report.lostBookings).toContainEqual({
      segmentId: "business",
      code: "price",
      count: business.demand,
      explanation: "可用客房价格超出商务差旅的接受范围",
    });
  });

  it("loses otherwise valid bookings when configured service cannot support them", () => {
    const input = createApprovedSettlementInput();
    input.operations = createApprovedOperations();
    for (const department of Object.values(input.operations.departments)) {
      department.staffing = 0;
      department.dailyBudgetCents = 100;
    }
    input.offers = input.offers.filter(({ id }) => id.includes("business"));

    const { report } = settleOperationsDay(input);

    expect(report.soldRooms).toBe(0);
    expect(report.departmentCostCents).toBe(600);
    expect(report.lostBookings).toContainEqual({
      segmentId: "business",
      code: "service",
      count: 1,
      explanation: "部门服务能力不足，未能承接商务差旅的合规预订",
    });
  });

  it("counts each unavailable service slot only once across segments", () => {
    const input = createApprovedSettlementInput();
    for (const department of Object.values(input.operations.departments)) {
      department.staffing = 0;
      department.dailyBudgetCents = 0;
    }

    const { report } = settleOperationsDay(input);
    const serviceLosses = report.lostBookings
      ?.filter(({ code }) => code === "service")
      .reduce((sum, { count }) => sum + count, 0);

    expect(serviceLosses).toBe(report.availableRooms);
  });

  it("allocates each room once in stable order independent of insertion history", () => {
    const first = createApprovedSettlementInput();
    first.operations.pricePolicies = Object.fromEntries(
      first.offers.map((offer) => [offer.id, {
        roomOfferId: offer.id,
        nightlyRateCents: offer.nightlyRateCents,
      }]),
    );
    const second = structuredClone(first);
    second.offers.reverse();
    second.operations.pricePolicies = Object.fromEntries(
      Object.entries(second.operations.pricePolicies).reverse(),
    );

    const firstReport = settleOperationsDay(first).report;
    const secondReport = settleOperationsDay(second).report;

    expect(secondReport.bookings).toEqual(firstReport.bookings);
    expect(new Set(firstReport.bookings?.map(({ roomId }) => roomId)).size).toBe(
      firstReport.bookings?.length,
    );
    expect(firstReport.bookings?.map(({ offerId }) => offerId)).toEqual(
      [...(firstReport.bookings ?? [])].map(({ offerId }) => offerId).sort(),
    );
  });

  it("canonicalizes loan history and does not assign segment mix to zero-sales segments", () => {
    const first = createApprovedSettlementInput();
    first.operations.loans = [
      { id: "loan:z", principalCents: 200_000, outstandingCents: 200_000, dailyInterestBps: 20, minimumPaymentCents: 100 },
      { id: "loan:a", principalCents: 100_000, outstandingCents: 100_000, dailyInterestBps: 10, minimumPaymentCents: 100 },
    ];
    const second = structuredClone(first);
    second.operations.loans.reverse();

    const firstResult = settleOperationsDay(first);
    const secondResult = settleOperationsDay(second);

    expect(secondResult).toEqual(firstResult);
    expect(firstResult.operations.loans.map(({ id }) => id)).toEqual(["loan:a", "loan:z"]);
    for (const segment of firstResult.report.segments) {
      if (segment.soldRooms === 0) {
        expect(firstResult.operations.segmentMix?.[segment.segmentId]).toBe(0);
      }
    }
  });

  it("never sells duplicate offer variants backed by the same room inventory", () => {
    const input = createApprovedSettlementInput();
    for (const department of Object.values(input.operations.departments)) {
      department.staffing = 100;
    }
    const original = input.offers[0];
    input.offers = [
      original,
      { ...original, id: `${original.id}:alternate`, nightlyRateCents: original.nightlyRateCents - 1 },
    ];

    const { report } = settleOperationsDay(input);

    expect(report.soldRooms).toBe(1);
    expect(new Set(report.bookings?.map(({ roomId }) => roomId)).size).toBe(1);
  });

  it("generates stable template reviews and applies bounded reputation discovery", () => {
    const input = createApprovedSettlementInput();
    const { report, operations } = settleOperationsDay(input);

    expect(report.reviews?.map(({ segmentId }) => segmentId)).toEqual(
      report.segments.filter(({ soldRooms }) => soldRooms > 0).map(({ segmentId }) => segmentId),
    );
    expect(report.reviews?.every(({ text }) => text.includes("入住体验"))).toBe(true);
    expect(report.reputationDeltaBps).toBe(
      report.reputationBps - input.operations.reputationBps,
    );
    expect(operations.reputationBps).toBe(report.reputationBps);
    expect(operations.maximumReputationBps).toBeGreaterThanOrEqual(operations.reputationBps);
    expect(operations.discoveredNeeds).toEqual(report.discoveredNeeds);
  });

  it.each([Number.NaN, -1, 10_001, 1.5])(
    "rejects invalid maximum reputation %s",
    (maximumReputationBps) => {
      const input = createApprovedSettlementInput();
      input.operations.maximumReputationBps = maximumReputationBps;

      expect(() => settleOperationsDay(input)).toThrow("最高声誉");
    },
  );

  it("rejects a maximum reputation below current reputation", () => {
    const input = createApprovedSettlementInput();
    input.operations.reputationBps = 6_000;
    input.operations.maximumReputationBps = 5_999;

    expect(() => settleOperationsDay(input)).toThrow("最高声誉不能低于当前声誉");
  });

  it("preserves the historical maximum when daily reputation falls", () => {
    const input = createApprovedSettlementInput();
    input.operations.reputationBps = 7_000;
    input.operations.maximumReputationBps = 8_000;
    input.offers = [{
      ...input.offers[0],
      nightlyRateCents: 150_000,
      viewBps: 0,
      workspaceBps: 0,
      quietBps: 0,
      privacyBps: 0,
      designAffinities: Object.fromEntries(
        GUEST_SEGMENT_IDS.map((segmentId) => [segmentId, 0]),
      ) as typeof input.offers[number]["designAffinities"],
    }];

    const { operations } = settleOperationsDay(input);

    expect(operations.reputationBps).toBeLessThan(7_000);
    expect(operations.maximumReputationBps).toBe(8_000);
  });

  it("does not mutate nested settlement input", () => {
    const input = createApprovedSettlementInput();
    const snapshot = structuredClone(input);

    settleOperationsDay(input);

    expect(input).toEqual(snapshot);
  });

  it("rejects settlement on the same or an earlier day than existing history", () => {
    const input = createApprovedSettlementInput();
    const first = settleOperationsDay({ ...input, day: 2 });

    expect(() => settleOperationsDay({
      ...input,
      day: first.report.day,
      operations: first.operations,
    })).toThrow("营业日必须晚于最后一份经营日报");
    expect(() => settleOperationsDay({
      ...input,
      day: 1,
      operations: first.operations,
    })).toThrow("营业日必须晚于最后一份经营日报");
  });

  it.each([
    ["unsafe", [1, Number.NaN]],
    ["duplicate", [1, 1]],
    ["descending", [2, 1]],
  ] as const)("rejects %s existing daily report history", (_kind, days) => {
    const input = createApprovedSettlementInput();
    const report = settleOperationsDay(input).report;
    input.day = 3;
    input.operations.dailyReports = days.map((day) => ({ ...report, day }));

    expect(() => settleOperationsDay(input)).toThrow("经营日报日期");
  });

  it("settles department cost, loan interest, and no inventory without rooms", () => {
    const input = createApprovedSettlementInput();
    input.offers = [];
    input.operations.loans = [{
      id: "loan:bank",
      principalCents: 1_000_000,
      outstandingCents: 1_000_000,
      dailyInterestBps: 100,
      minimumPaymentCents: 1_000,
    }];

    const { report } = settleOperationsDay(input);

    expect(report).toMatchObject({
      availableRooms: 0,
      soldRooms: 0,
      occupancyBps: 0,
      roomRevenueCents: 0,
      loanInterestCents: 10_000,
    });
    expect(report.departmentCostCents).toBeGreaterThan(0);
    expect(report.lostBookings?.every(({ code }) => code === "no-inventory")).toBe(true);
  });

  it("uses a deterministic settlement safety loan for casual cash shortfall", () => {
    const input = createApprovedSettlementInput();
    input.cashCents = 0;
    input.offers = [];

    const { report, operations, cashCents } = settleOperationsDay(input);

    expect(cashCents).toBe(0);
    expect(report.cashShortfallCents).toBe(report.operatingCostCents + report.financeCostCents);
    expect(operations.loans[operations.loans.length - 1]).toMatchObject({
      id: "safety-loan:daily-settlement",
      principalCents: report.cashShortfallCents,
      outstandingCents: report.cashShortfallCents,
      dailyInterestBps: 10,
    });
  });

  it("keeps management cash nonnegative while exposing unfunded pressure", () => {
    const input = createApprovedSettlementInput();
    input.cashCents = 0;
    input.offers = [];
    input.operations.difficulty = "management";

    const { report, operations, cashCents } = settleOperationsDay(input);

    expect(cashCents).toBe(0);
    expect(report.cashShortfallCents).toBeGreaterThan(0);
    expect(report.netIncomeCents).toBeLessThan(0);
    expect(operations.loans).toEqual([]);
  });

  it.each([
    ["day", 0],
    ["day", 1.5],
    ["cashCents", Number.NaN],
    ["cashCents", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("rejects invalid scalar %s=%s", (field, value) => {
    const input = createApprovedSettlementInput();
    expect(() => settleOperationsDay({ ...input, [field]: value })).toThrow("安全整数");
  });

  it("rejects unsafe finance arithmetic instead of overflowing", () => {
    const input = createApprovedSettlementInput();
    input.operations.loans = [{
      id: "loan:unsafe-interest",
      principalCents: Number.MAX_SAFE_INTEGER,
      outstandingCents: Number.MAX_SAFE_INTEGER,
      dailyInterestBps: 10_000,
      minimumPaymentCents: 0,
    }];

    expect(() => settleOperationsDay(input)).toThrow("安全整数范围");
  });

  it.each(["", "   "])("rejects empty loan id %j", (id) => {
    const input = createApprovedSettlementInput();
    input.operations.loans = [{
      id,
      principalCents: 100_000,
      outstandingCents: 100_000,
      dailyInterestBps: 10,
      minimumPaymentCents: 100,
    }];

    expect(() => settleOperationsDay(input)).toThrow("贷款编号不能为空");
  });

  it("rejects duplicate loan ids before interest or safety financing", () => {
    const input = createApprovedSettlementInput();
    const loan = {
      id: "loan:duplicate",
      principalCents: 100_000,
      outstandingCents: 100_000,
      dailyInterestBps: 100,
      minimumPaymentCents: 100,
    };
    input.operations.loans = [loan, { ...loan }];

    expect(() => settleOperationsDay(input)).toThrow("贷款编号必须唯一");
  });

  it.each(["", "   "])("rejects empty offer id %j", (id) => {
    const input = createApprovedSettlementInput();
    input.offers[0] = { ...input.offers[0], id };

    expect(() => settleOperationsDay(input)).toThrow("客房产品编号不能为空");
  });

  it("rejects duplicate offer ids instead of silently dropping inventory", () => {
    const input = createApprovedSettlementInput();
    input.offers = [
      input.offers[0],
      {
        ...input.offers[1],
        id: input.offers[0].id,
        sourceRoomId: "room-distinct-inventory",
      },
    ];

    expect(() => settleOperationsDay(input)).toThrow("客房产品编号必须唯一");
  });

  it.each([
    ["nightlyRateCents", Number.NaN],
    ["viewBps", 10_001],
    ["workspaceBps", 1.5],
  ] as const)("rejects invalid offer %s=%s", (field, value) => {
    const input = createApprovedSettlementInput();
    input.offers[0] = { ...input.offers[0], [field]: value };

    expect(() => settleOperationsDay(input)).toThrow("客房产品");
  });

  it("rejects an invalid effective policy rate", () => {
    const input = createApprovedSettlementInput();
    input.operations.pricePolicies[input.offers[0].id] = {
      roomOfferId: input.offers[0].id,
      nightlyRateCents: Number.NaN,
    };

    expect(() => settleOperationsDay(input)).toThrow("有效房价");
  });
});
