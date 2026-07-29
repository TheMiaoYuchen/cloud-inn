import { describe, expect, it } from "vitest";

import { createNewGame, type GameState } from "../../domain/game/state";
import { DEPARTMENT_IDS, GUEST_SEGMENT_IDS, type OperationsDailyReport } from "../../domain/operations/operationsTypes";
import { createOperationsState } from "../../domain/operations/createOperationsState";
import { aggregateMonthlyClose, aggregateWeeklyReport } from "../../domain/operations/reporting";
import { REPUTATION_UNLOCKS } from "../../domain/operations/unlocks";
import { validateBrowserGameState } from "./validateBrowserGameState";
import sharedPhase4Fixture from "../../../src-tauri/tests/fixtures/phase4-valid.json";

function daily(day: number): OperationsDailyReport {
  return {
    day,
    segments: GUEST_SEGMENT_IDS.map((segmentId) => segmentId === "business" ? {
      segmentId,
      demand: 2,
      soldRooms: 1,
      averageRateCents: 1_000,
      revenueCents: 1_000,
      satisfactionBps: 5_000 + day,
    } : zeroSegment(segmentId)),
    revenueCents: 1_000,
    operatingCostCents: 100,
    financeCostCents: 10,
    netIncomeCents: 890,
    endingCashCents: 1_000_000 + day,
    reputationBps: 5_000 + day,
    availableRooms: 2,
    soldRooms: 1,
    occupancyBps: 5_000,
    departmentCostCents: 100,
    roomRevenueCents: 1_000,
    loanInterestCents: 10,
    cashShortfallCents: 0,
    lostBookings: [{ segmentId: "couple", code: "price", count: 1, explanation: "rate" }],
    reviews: [{ segmentId: "business", ratingBps: 5_000 + day, text: "ok" }],
    bookings: [{ segmentId: "business", roomId: "room-1", offerId: "offer-1", rateCents: 1_000 }],
    reputationDeltaBps: 1,
    discoveredNeeds: [{ id: `need-${day}`, segmentId: "business", kind: "service", discoveredDay: day, strengthBps: 100 }],
  };
}

function zeroSegment(segmentId: (typeof GUEST_SEGMENT_IDS)[number]) {
  return {
    segmentId,
    demand: 0,
    soldRooms: 0,
    averageRateCents: 0,
    revenueCents: 0,
    satisfactionBps: 5_000,
  };
}

function legacyReport(report: OperationsDailyReport) {
  return {
    day: report.day,
    availableRooms: report.availableRooms ?? 0,
    soldRooms: report.soldRooms ?? 0,
    occupancyBps: report.occupancyBps ?? 0,
    rateCents: 1_000,
    revenueCents: report.revenueCents,
    operatingCostCents: report.operatingCostCents + report.financeCostCents,
    netIncomeCents: report.netIncomeCents,
    endingCashCents: report.endingCashCents,
    reasons: [],
  };
}

function minimalState(): GameState {
  const state = createNewGame("operations-minimal");
  return { ...state, revision: 1, operations: createOperationsState() };
}

function thirtyDayState(): GameState {
  const reports = Array.from({ length: 30 }, (_, index) => daily(index + 1));
  const operations = createOperationsState();
  operations.dailyReports = reports;
  operations.weeklyReports = [0, 7, 14, 21].map((start) => aggregateWeeklyReport(reports.slice(start, start + 7)));
  operations.monthlyCloses = [aggregateMonthlyClose(reports)];
  operations.reputationBps = reports[29].reputationBps;
  operations.maximumReputationBps = reports[29].reputationBps;
  operations.timeSpeed = 0;
  operations.lastOfflineCheckpointMs = 30_000;
  operations.pricePolicies = {
    "offer-1": {
      roomOfferId: "offer-1",
      nightlyRateCents: 1_000,
      baseRateCents: 1_000,
      minRateCents: 800,
      maxRateCents: 1_200,
      automaticPricing: true,
    },
  } as typeof operations.pricePolicies;
  operations.offerUpgrades = {
    "offer-1:workspace": {
      roomOfferId: "offer-1",
      upgradeId: "workspace",
      kind: "workspace",
      level: 1,
      remainingClosureDays: 0,
      committedDay: 2,
      costCents: 120_000,
    },
    legacy: { roomOfferId: "missing-old-offer", upgradeId: "arbitrary-v0", level: 99 },
  };
  operations.loans = [{
    id: "loan-1",
    principalCents: 10_000,
    outstandingCents: 5_000,
    dailyInterestBps: 100,
    minimumPaymentCents: 500,
  }];
  operations.unlockedContent = REPUTATION_UNLOCKS
    .filter(({ reputationBps }) => reputationBps <= operations.maximumReputationBps)
    .map(({ key }) => key);

  const legacy = reports.map(legacyReport);
  return {
    ...createNewGame("operations-30"),
    revision: 1,
    currentDay: 30,
    cashCents: reports[29].endingCashCents,
    reports: legacy,
    latestReport: legacy[29],
    operations,
  };
}

function malformed(mutate: (state: Record<string, any>) => void): unknown {
  const state = structuredClone(thirtyDayState()) as unknown as Record<string, any>;
  mutate(state);
  return state;
}

describe("browser operations persistence validation", () => {
  it("accepts exact report-v2 arithmetic from the shared maximum fixture", () => {
    expect(() => validateBrowserGameState(
      structuredClone(sharedPhase4Fixture),
      "phase4-shared",
    )).not.toThrow();
  });

  it("keeps operations optional and accepts a minimal operations state", () => {
    const phaseOne = createNewGame("phase-one");
    expect(validateBrowserGameState(phaseOne, phaseOne.saveId)).toEqual(phaseOne);

    const state = minimalState();
    expect(validateBrowserGameState(state, state.saveId)).toEqual(state);
  });

  it("round-trips a complete day-30 operations state through browser JSON without mutation", () => {
    const state = thirtyDayState();
    const snapshot = structuredClone(state);
    const loaded = validateBrowserGameState(JSON.parse(JSON.stringify(state)), state.saveId);

    expect(loaded).toEqual(state);
    expect(state).toEqual(snapshot);
    expect(loaded).not.toBe(state);
  });

  it("accepts cash spent after the latest settled report", () => {
    const state = thirtyDayState();
    state.cashCents -= 250_000;

    expect(validateBrowserGameState(state, state.saveId)).toEqual(state);
  });

  it("accepts classic daily categories with category-free Phase 3 aggregates", () => {
    const state = thirtyDayState();

    expect(state.operations?.dailyReports[0]).toMatchObject({
      roomRevenueCents: 1_000,
      departmentCostCents: 100,
    });
    expect(state.operations?.weeklyReports[0]).not.toHaveProperty("roomRevenueCents");
    expect(state.operations?.monthlyCloses[0]).not.toHaveProperty("departmentCostCents");
    expect(validateBrowserGameState(state, state.saveId)).toEqual(state);
  });

  it.each(Array.from({ length: 14 }, (_, index) => index + 1).filter((mask) => mask !== 5))(
    "rejects partial report-v2 category presence mask %s",
    (mask) => {
      const report = daily(1);
      delete report.roomRevenueCents;
      delete report.publicSpaceRevenueCents;
      delete report.departmentCostCents;
      delete report.facilityOperatingCostCents;
      const categoryValues = {
        roomRevenueCents: 1_000,
        publicSpaceRevenueCents: 0,
        departmentCostCents: 100,
        facilityOperatingCostCents: 0,
      } as const;
      const keys = Object.keys(categoryValues) as Array<keyof typeof categoryValues>;
      Object.assign(report, Object.fromEntries(
        keys.flatMap((key, index) => mask & (1 << index) ? [[key, categoryValues[key]]] : []),
      ));
      const operations = createOperationsState();
      operations.dailyReports = [report];
      operations.reputationBps = report.reputationBps;
      operations.maximumReputationBps = report.reputationBps;
      const legacy = legacyReport(report);
      const state: GameState = {
        ...createNewGame(`partial-v2-${mask}`),
        revision: 1,
        currentDay: 1,
        cashCents: report.endingCashCents,
        reports: [legacy],
        latestReport: legacy,
        operations,
      };

      expect(() => validateBrowserGameState(state, state.saveId)).toThrow(
        "必须完整包含四项收入与成本分类",
      );
    },
  );

  it("accepts a fresh operations envelope lazily initialized on legacy day 30", () => {
    const legacy = createNewGame("legacy-day-30");
    const reports = Array.from({ length: 30 }, (_, index) => ({
      ...legacyReport(daily(index + 1)),
      day: index + 1,
    }));
    const state: GameState = {
      ...legacy,
      revision: 1,
      currentDay: 30,
      reports,
      latestReport: reports[29],
      operations: createOperationsState(),
    };

    expect(validateBrowserGameState(JSON.parse(JSON.stringify(state)), state.saveId)).toEqual(state);
  });

  it.each([
    ["ruleset", (g: any) => { g.operations.rulesetVersion = "operations-v2"; }],
    ["difficulty", (g: any) => { g.operations.difficulty = "expert"; }],
    ["missing department", (g: any) => { delete g.operations.departments.security; }],
    ["extra department", (g: any) => { g.operations.departments.spa = { ...g.operations.departments.security, id: "spa" }; }],
    ["department id mismatch", (g: any) => { g.operations.departments.security.id = "engineering"; }],
    ["unsafe money", (g: any) => { g.operations.departments.security.dailyBudgetCents = Number.MAX_SAFE_INTEGER + 1; }],
    ["fractional bps", (g: any) => { g.operations.departments.security.trainingBps = 1.5; }],
    ["out-of-range bps", (g: any) => { g.operations.reputationBps = 10_001; }],
    ["invalid day", (g: any) => { g.operations.dailyReports[0].day = 0; }],
    ["invalid speed", (g: any) => { g.operations.timeSpeed = 3; }],
    ["unsafe checkpoint", (g: any) => { g.operations.lastOfflineCheckpointMs = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative checkpoint", (g: any) => { g.operations.lastOfflineCheckpointMs = -1; }],
    ["day 30 running", (g: any) => { g.operations.timeSpeed = 1; }],
    ["day 30 history missing checkpoint", (g: any) => { g.operations.lastOfflineCheckpointMs = null; }],
  ])("rejects invalid operations scalar or catalog state: %s", (_label, mutate) => {
    expect(() => validateBrowserGameState(malformed(mutate), "operations-30")).toThrow("经营存档");
  });

  it.each([
    ["unknown segment", (g: any) => { g.operations.dailyReports[0].segments[0].segmentId = "group"; }],
    ["duplicate day", (g: any) => { g.operations.dailyReports[1].day = 1; }],
    ["nonmonotonic day", (g: any) => { [g.operations.dailyReports[1], g.operations.dailyReports[2]] = [g.operations.dailyReports[2], g.operations.dailyReports[1]]; }],
    ["more than 30 days", (g: any) => { g.operations.dailyReports.push(daily(31)); }],
    ["segment revenue sum", (g: any) => { g.operations.dailyReports[0].revenueCents += 1; }],
    ["daily net total", (g: any) => { g.operations.dailyReports[0].netIncomeCents += 1; }],
    ["daily room revenue", (g: any) => { g.operations.dailyReports[0].roomRevenueCents += 1; }],
    ["daily department cost", (g: any) => { g.operations.dailyReports[0].departmentCostCents += 1; }],
    ["daily finance cost", (g: any) => { g.operations.dailyReports[0].loanInterestCents += 1; }],
    ["operations reputation mismatch", (g: any) => { g.operations.reputationBps -= 1; }],
    ["invalid review", (g: any) => { g.operations.dailyReports[0].reviews[0].ratingBps = 10_001; }],
    ["invalid booking", (g: any) => { g.operations.dailyReports[0].bookings[0].rateCents = -1; }],
    ["invalid lost reason", (g: any) => { g.operations.dailyReports[0].lostBookings[0].code = "unknown"; }],
  ])("rejects inconsistent daily report history: %s", (_label, mutate) => {
    expect(() => validateBrowserGameState(malformed(mutate), "operations-30")).toThrow("经营存档");
  });

  it("rejects a duplicate segment even when the stored daily totals agree", () => {
    const report = daily(1);
    report.segments.push(structuredClone(report.segments[0]));
    report.revenueCents = 2_000;
    report.roomRevenueCents = 2_000;
    report.netIncomeCents = 1_890;
    report.soldRooms = 2;
    report.occupancyBps = 10_000;
    const legacy = legacyReport(report);
    const operations = createOperationsState();
    operations.dailyReports = [report];
    operations.reputationBps = report.reputationBps;
    operations.maximumReputationBps = report.reputationBps;
    const state: GameState = {
      ...createNewGame("duplicate-segment"),
      revision: 1,
      currentDay: 1,
      cashCents: report.endingCashCents,
      reports: [legacy],
      latestReport: legacy,
      operations,
    };

    expect(() => validateBrowserGameState(state, state.saveId)).toThrow("经营存档");
  });

  it.each([
    ["empty", []],
    ["one valid", [zeroSegment("business")]],
    ["missing one", GUEST_SEGMENT_IDS.slice(0, -1).map(zeroSegment)],
  ])("rejects an incomplete %s daily segment catalog", (_label, segments) => {
    const report = daily(1);
    report.segments = segments;
    report.revenueCents = 0;
    report.roomRevenueCents = 0;
    report.netIncomeCents = -110;
    report.soldRooms = 0;
    report.occupancyBps = 0;
    const legacy = legacyReport(report);
    const operations = createOperationsState();
    operations.dailyReports = [report];
    operations.reputationBps = report.reputationBps;
    operations.maximumReputationBps = report.reputationBps;
    const state: GameState = {
      ...createNewGame("incomplete-segments"),
      revision: 1,
      currentDay: 1,
      cashCents: report.endingCashCents,
      reports: [legacy],
      latestReport: legacy,
      operations,
    };

    expect(() => validateBrowserGameState(state, state.saveId)).toThrow("经营存档");
  });

  it.each([
    ["missing weekly boundary", (g: any) => { g.operations.weeklyReports.pop(); }],
    ["extra weekly boundary", (g: any) => { g.operations.weeklyReports.push({ ...g.operations.weeklyReports[0], week: 5, startDay: 29, endDay: 30 }); }],
    ["weekly number", (g: any) => { g.operations.weeklyReports[0].week = 2; }],
    ["weekly window", (g: any) => { g.operations.weeklyReports[0].startDay = 2; }],
    ["weekly sum", (g: any) => { g.operations.weeklyReports[0].revenueCents += 1; }],
    ["weekly reputation", (g: any) => { g.operations.weeklyReports[0].reputationBps += 1; }],
    ["monthly duplicate", (g: any) => { g.operations.monthlyCloses.push(g.operations.monthlyCloses[0]); }],
    ["monthly boundary", (g: any) => { g.operations.monthlyCloses[0].endDay = 29; }],
    ["monthly sum", (g: any) => { g.operations.monthlyCloses[0].netIncomeCents += 1; }],
    ["monthly cash", (g: any) => { g.operations.monthlyCloses[0].endingCashCents += 1; }],
  ])("rejects invalid periodic report state: %s", (_label, mutate) => {
    expect(() => validateBrowserGameState(malformed(mutate), "operations-30")).toThrow("经营存档");
  });

  it.each([
    ["empty loan id", (g: any) => { g.operations.loans[0].id = ""; }],
    ["duplicate loan", (g: any) => { g.operations.loans.push(g.operations.loans[0]); }],
    ["zero balance", (g: any) => { g.operations.loans[0].outstandingCents = 0; }],
    ["balance over principal", (g: any) => { g.operations.loans[0].outstandingCents = 10_001; }],
    ["payment over balance", (g: any) => { g.operations.loans[0].minimumPaymentCents = 5_001; }],
    ["bad reserved contract", (g: any) => { g.operations.loans[0].id = "safety-loan:daily-settlement"; }],
    ["price key mismatch", (g: any) => { g.operations.pricePolicies["offer-1"].roomOfferId = "offer-2"; }],
    ["price range", (g: any) => { g.operations.pricePolicies["offer-1"].minRateCents = 1_001; }],
    ["invalid current price", (g: any) => { g.operations.pricePolicies["offer-1"].nightlyRateCents = -1; }],
  ])("rejects invalid financial records: %s", (_label, mutate) => {
    expect(() => validateBrowserGameState(malformed(mutate), "operations-30")).toThrow("经营存档");
  });

  it.each([
    ["explicit missing field", (g: any) => { delete g.operations.offerUpgrades["offer-1:workspace"].costCents; }],
    ["compound key", (g: any) => { g.operations.offerUpgrades.bad = g.operations.offerUpgrades["offer-1:workspace"]; delete g.operations.offerUpgrades["offer-1:workspace"]; }],
    ["id kind mismatch", (g: any) => { g.operations.offerUpgrades["offer-1:workspace"].upgradeId = "view"; }],
    ["unknown kind", (g: any) => { g.operations.offerUpgrades["offer-1:workspace"].kind = "pool"; }],
    ["negative closure", (g: any) => { g.operations.offerUpgrades["offer-1:workspace"].remainingClosureDays = -1; }],
    ["inconsistent closure", (g: any) => { g.operations.offerUpgrades["offer-1:workspace"].remainingClosureDays = 3; }],
    ["inconsistent cost", (g: any) => { g.operations.offerUpgrades["offer-1:workspace"].costCents = 1; }],
    ["future commit", (g: any) => { g.operations.offerUpgrades["offer-1:workspace"].committedDay = 31; }],
    ["fractional level", (g: any) => { g.operations.offerUpgrades["offer-1:workspace"].level = 1.5; }],
  ])("rejects malformed explicit upgrade records: %s", (_label, mutate) => {
    expect(() => validateBrowserGameState(malformed(mutate), "operations-30")).toThrow("经营存档");
  });

  it("keeps arbitrary legacy no-kind upgrade records compatible", () => {
    const state = thirtyDayState();
    state.operations!.offerUpgrades = {
      arbitraryStorageKey: { roomOfferId: "removed-offer", upgradeId: "old-custom-upgrade", level: 42 },
    };
    expect(validateBrowserGameState(state, state.saveId).operations?.offerUpgrades).toEqual(state.operations!.offerUpgrades);
  });

  it.each([
    ["maximum below current", (g: any) => { g.operations.maximumReputationBps = g.operations.reputationBps - 1; }],
    ["duplicate unlock", (g: any) => { g.operations.unlockedContent = [REPUTATION_UNLOCKS[0].key, REPUTATION_UNLOCKS[0].key]; }],
    ["unknown unlock", (g: any) => { g.operations.unlockedContent = ["unknown:unlock"]; }],
    ["unknown need segment", (g: any) => { g.operations.discoveredNeeds = [{ id: "x", segmentId: "vip", kind: "service", discoveredDay: 1, strengthBps: 1 }]; }],
    ["duplicate need", (g: any) => { g.operations.discoveredNeeds = [{ id: "x", segmentId: "business", kind: "service", discoveredDay: 1, strengthBps: 1 }, { id: "x", segmentId: "business", kind: "price", discoveredDay: 2, strengthBps: 1 }]; }],
    ["invalid segment mix", (g: any) => { g.operations.segmentMix = { business: 5_000, vip: 5_000 }; }],
  ])("rejects invalid reputation or market state: %s", (_label, mutate) => {
    expect(() => validateBrowserGameState(malformed(mutate), "operations-30")).toThrow("经营存档");
  });

  it("keeps persistence IDs in parity with the readonly domain catalogs", async () => {
    const module = await import("./validateBrowserGameState");
    expect(module.OPERATIONS_PERSISTENCE_IDS.departments).toEqual(DEPARTMENT_IDS);
    expect(module.OPERATIONS_PERSISTENCE_IDS.segments).toEqual(GUEST_SEGMENT_IDS);
    expect(module.OPERATIONS_PERSISTENCE_IDS.unlocks).toEqual(REPUTATION_UNLOCKS.map(({ key }) => key));
  });
});
