import { describe, expect, it } from "vitest";

import {
  FACILITY_OFFERINGS,
  MENU_STRUCTURES,
  createFacilityPolicy,
  projectFacilityOfferings,
  projectMenuStructures,
  projectOperatingChoices,
  validateFacilityPolicy,
  settleFacilityOperations,
} from "./facilityOperations";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { createApprovedOperations } from "../operations/operationsFixtures";

describe("light facility operations", () => {
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

  function settlementInput() {
    const phase4 = createPhase4AcceptanceState("facility-settlement").phase4!;
    const dining = Object.values(phase4.facilities).find(
      ({ type }) => type === "all-day-dining",
    )!;
    dining.status = "operating";
    dining.enabled = true;
    dining.policy = createFacilityPolicy("all-day-dining", {
      positioningId: "positioning:international-luxury",
      priceBandId: "price-band:premium",
      capacity: 30,
      openingPolicyId: "opening-policy:breakfast-dinner",
      serviceBudgetCents: 180_000,
    });
    const blueprint = phase4.spaceBlueprints[
      phase4.publicSpaces[dining.publicSpaceInstanceId].blueprintId
    ];
    blueprint.placedItems = Array.from({ length: 8 }, (_, index) => ({
      id: `item:dining-table:${index + 1}` as typeof blueprint.placedItems[number]["id"],
      catalogItemId: "item:dining-table" as typeof blueprint.placedItems[number]["catalogItemId"],
      x: index,
      y: 0,
      width: 1,
      height: 1,
      rotation: 0,
    }));
    for (const facility of Object.values(phase4.facilities)) {
      if (facility.id !== dining.id) facility.enabled = false;
    }
    return {
      day: 1,
      seed: "facility-seed",
      occupiedRooms: 90,
      availableRooms: 120,
      segmentMix: { business: 5_000, leisure: 5_000 },
      reputationBps: 6_000,
      departments: createApprovedOperations().departments,
      facilities: phase4.facilities,
      publicSpaces: phase4.publicSpaces,
      blueprints: phase4.spaceBlueprints,
    };
  }

  it("settles configured facilities in stable order within authoritative capacity", () => {
    const input = settlementInput();
    const snapshot = structuredClone(input);

    const result = settleFacilityOperations(input);

    expect(result.results.map(({ facilityId }) => facilityId)).toEqual(
      result.results.map(({ facilityId }) => facilityId).sort(),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].visits).toBeLessThanOrEqual(30);
    expect(result.publicSpaceRevenueCents).toBeGreaterThan(0);
    expect(result.facilityOperatingCostCents).toBeGreaterThan(0);
    expect(input).toEqual(snapshot);
  });

  it.each([
    ["same-day", 1, [{ day: 1 }]],
    ["future", 1, [{ day: 2 }]],
    ["duplicate", 3, [{ day: 1 }, { day: 1 }]],
    ["nonmonotonic", 3, [{ day: 2 }, { day: 1 }]],
    ["over-limit", 32, Array.from({ length: 31 }, (_, index) => ({ day: index + 1 }))],
  ] as const)("rejects %s facility history before settlement", (_label, day, records) => {
    const input = settlementInput();
    input.day = day;
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    const baseline = {
      visits: 1,
      revenueCents: 1,
      operatingCostCents: 1,
      utilizationBps: 1,
      satisfactionDeltaBps: 0,
      appealDeltaBps: 0,
      reasonCodes: [],
    };
    facility.dailyResults = records.map((record) => ({ ...baseline, ...record }));
    const snapshot = structuredClone(input);

    expect(() => settleFacilityOperations(input)).toThrow("设施历史");
    expect(input).toEqual(snapshot);
  });

  it("rejects a non-array facility history", () => {
    const input = settlementInput();
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    facility.dailyResults = {} as never;

    expect(() => settleFacilityOperations(input)).toThrow("设施历史必须是数组");
  });

  it("rejects settlement that would append a 31st enabled facility result", () => {
    const input = settlementInput();
    input.day = 31;
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    facility.dailyResults = Array.from({ length: 30 }, (_, index) => historyRecord(index + 1));
    const snapshot = structuredClone(input);

    expect(() => settleFacilityOperations(input)).toThrow("设施历史已满 30 天");
    expect(input).toEqual(snapshot);
  });

  it("accepts 29 prior results and produces exactly the day-30 facility result", () => {
    const input = settlementInput();
    input.day = 30;
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    facility.dailyResults = Array.from({ length: 29 }, (_, index) => historyRecord(index + 1));

    expect(settleFacilityOperations(input).results).toEqual([
      expect.objectContaining({ facilityId: facility.id, day: 30 }),
    ]);
    expect(facility.dailyResults).toHaveLength(29);
  });

  it("allows full history on a disabled facility because settlement appends no result", () => {
    const input = settlementInput();
    input.day = 31;
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    facility.enabled = false;
    facility.dailyResults = Array.from({ length: 30 }, (_, index) => historyRecord(index + 1));

    expect(settleFacilityOperations(input).results).toEqual([]);
    expect(facility.dailyResults).toHaveLength(30);
  });

  it.each([
    ["unsafe revenue", (record: any) => { record.revenueCents = Number.MAX_SAFE_INTEGER + 1; }],
    ["invalid utilization", (record: any) => { record.utilizationBps = 10_001; }],
    ["wrong facility id", (record: any) => { record.facilityId = "facility:other"; }],
  ])("rejects %s in facility history", (_label, mutate) => {
    const input = settlementInput();
    input.day = 2;
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    const record: any = {
      day: 1,
      visits: 1,
      revenueCents: 1,
      operatingCostCents: 1,
      utilizationBps: 1,
      satisfactionDeltaBps: 0,
      appealDeltaBps: 0,
      reasonCodes: [],
    };
    mutate(record);
    facility.dailyResults = [record];

    expect(() => settleFacilityOperations(input)).toThrow("设施历史");
  });

  it("rejects a facility record key/id mismatch before graph lookup", () => {
    const input = settlementInput();
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    input.facilities = { "facility:wrong-key": facility };

    expect(() => settleFacilityOperations(input)).toThrow("设施记录键与编号不一致");
  });

  it.each([
    ["missing instance", (input: ReturnType<typeof settlementInput>, facilityId: string) => {
      const facility = input.facilities[facilityId];
      delete input.publicSpaces[facility.publicSpaceInstanceId];
    }, "未知公共空间"],
    ["missing blueprint", (input: ReturnType<typeof settlementInput>, facilityId: string) => {
      const facility = input.facilities[facilityId];
      const instance = input.publicSpaces[facility.publicSpaceInstanceId];
      delete input.blueprints[instance.blueprintId];
    }, "未知公共空间蓝图"],
  ])("rejects a facility graph with %s", (_label, mutate, message) => {
    const input = settlementInput();
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    mutate(input, facility.id);

    expect(() => settleFacilityOperations(input)).toThrow(message);
  });

  it("orders facility IDs by explicit code units instead of locale collation", () => {
    const input = settlementInput();
    const original = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    const colon = { ...structuredClone(original), id: "facility:a:b" as typeof original.id };
    const digit = { ...structuredClone(original), id: "facility:a0" as typeof original.id };
    input.facilities = {
      [colon.id]: colon,
      [digit.id]: digit,
    };

    expect(settleFacilityOperations(input).results.map(({ facilityId }) => facilityId)).toEqual([
      "facility:a0",
      "facility:a:b",
    ]);
  });

  it("uses both policy and design capacity as authoritative visit bounds", () => {
    const input = settlementInput();
    const facility = Object.values(input.facilities).find(({ enabled }) => enabled)!;
    const blueprint = input.blueprints[
      input.publicSpaces[facility.publicSpaceInstanceId].blueprintId
    ];
    blueprint.placedItems = blueprint.placedItems.slice(0, 2);

    const result = settleFacilityOperations(input).results[0];

    expect(result.visits).toBeLessThanOrEqual(8);
  });

  it("settles enabled boost facilities without requiring a light-operation policy", () => {
    const input = settlementInput();
    for (const facility of Object.values(input.facilities)) facility.enabled = false;
    const gym = Object.values(input.facilities).find(({ type }) => type === "gym")!;
    gym.enabled = true;
    gym.status = "operating";
    gym.policy = null;
    const blueprint = input.blueprints[input.publicSpaces[gym.publicSpaceInstanceId].blueprintId];
    blueprint.placedItems = [{
      id: "item:gym:station" as typeof blueprint.placedItems[number]["id"],
      catalogItemId: "item:fitness-station" as typeof blueprint.placedItems[number]["catalogItemId"],
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      rotation: 0,
    }];

    expect(settleFacilityOperations(input).results).toEqual([
      expect.objectContaining({
        facilityId: gym.id,
        revenueCents: 0,
        operatingCostCents: gym.dailyOperatingCostCents,
        appealDeltaBps: expect.any(Number),
      }),
    ]);
  });



  it("skips disabled and unconfigured facilities with explicit bounded reasons", () => {
    const input = settlementInput();
    const facility = Object.values(input.facilities)[0];
    facility.enabled = true;
    facility.status = "operating";
    facility.policy = null;

    const result = settleFacilityOperations(input);

    expect(result.results.find(({ facilityId }) => facilityId === facility.id)).toMatchObject({
      visits: 0,
      revenueCents: 0,
      operatingCostCents: 0,
      reasonCodes: ["facility:unconfigured"],
    });
  });

  it("caps representative flows without letting the cap alter economics", () => {
    const input = settlementInput();

    const full = settleFacilityOperations({ ...input, maximumFlowEvents: 150 });
    const truncated = settleFacilityOperations({ ...input, maximumFlowEvents: 0 });

    expect(full.flowEvents.length).toBeLessThanOrEqual(150);
    expect(truncated.flowEvents).toEqual([]);
    expect({ ...truncated, flowEvents: full.flowEvents }).toEqual(full);
  });

  it("configures light operations without ingredient inventory", () => {
    const policy = createFacilityPolicy("all-day-dining", {
      positioningId: "positioning:international-luxury",
      priceBandId: "price-band:premium",
      capacity: 84,
      openingPolicyId: "opening-policy:breakfast-dinner",
      serviceBudgetCents: 180_000,
      signatureOfferingId: "dish:tea-smoked-duck",
    });

    expect(policy).not.toHaveProperty("inventory");
    expect(validateFacilityPolicy("all-day-dining", policy)).toEqual({ ok: true });
  });

  it.each(["dining", "bar", "spa", "banquet"] as const)(
    "ships 3-5 positioning or service choices for %s",
    (group) => {
      expect(projectOperatingChoices(group).length).toBeGreaterThanOrEqual(3);
      expect(projectOperatingChoices(group).length).toBeLessThanOrEqual(5);
    },
  );

  it("ships deterministic compatible menus and offerings", () => {
    expect(projectMenuStructures("all-day-dining").map(({ id }) => id)).toEqual([
      "menu:all-day-balanced",
      "menu:all-day-seasonal",
      "menu:all-day-chef-led",
    ]);
    expect(projectMenuStructures("spa")).toEqual([]);
    expect(projectFacilityOfferings("bar")).toHaveLength(3);
    expect(projectFacilityOfferings("spa")).toHaveLength(3);
    expect(new Set(FACILITY_OFFERINGS.map(({ id }) => id)).size)
      .toBe(FACILITY_OFFERINGS.length);
    expect(Object.isFrozen(MENU_STRUCTURES)).toBe(true);
    expect(Object.isFrozen(MENU_STRUCTURES[0])).toBe(true);
    expect(Object.isFrozen(FACILITY_OFFERINGS)).toBe(true);
    expect(Object.isFrozen(FACILITY_OFFERINGS[0].segmentAppealBps)).toBe(true);
  });

  it.each([
    ["all-day-dining", 29],
    ["all-day-dining", 181],
    ["spa", 3],
    ["spa", 37],
  ] as const)("rejects out-of-range capacity for %s", (type, capacity) => {
    expect(() => createFacilityPolicy(type, {
      positioningId: type === "spa"
        ? "positioning:restorative-wellness"
        : "positioning:international-luxury",
      priceBandId: "price-band:premium",
      capacity,
      openingPolicyId: type === "spa"
        ? "opening-policy:appointment-daily"
        : "opening-policy:breakfast-dinner",
      serviceBudgetCents: 180_000,
    })).toThrow("容量");
  });

  it("rejects boost facilities and incompatible offerings", () => {
    expect(() => createFacilityPolicy("gym", {
      positioningId: "positioning:restorative-wellness",
      priceBandId: "price-band:premium",
      capacity: 20,
      openingPolicyId: "opening-policy:appointment-daily",
      serviceBudgetCents: 180_000,
    })).toThrow("轻量运营");

    expect(() => createFacilityPolicy("all-day-dining", {
      positioningId: "positioning:international-luxury",
      priceBandId: "price-band:premium",
      capacity: 84,
      openingPolicyId: "opening-policy:breakfast-dinner",
      serviceBudgetCents: 180_000,
      signatureOfferingId: "drink:cloud-negroni",
    })).toThrow("招牌产品");
  });

  it("validates capacity and offering compatibility with authoritative type context", () => {
    const tooSmall = {
      positioningId: "positioning:international-luxury" as const,
      priceBandId: "price-band:premium" as const,
      capacity: 1,
      openingPolicyId: "opening-policy:breakfast-dinner" as const,
      serviceBudgetCents: 180_000,
    };
    expect(validateFacilityPolicy("all-day-dining", tooSmall)).toEqual({
      ok: false,
      reasons: ["设施容量必须在 30-180 之间"],
    });
    expect(validateFacilityPolicy("all-day-dining", {
      ...tooSmall,
      capacity: 84,
      signatureOfferingId: "drink:cloud-negroni",
    })).toEqual({
      ok: false,
      reasons: ["招牌产品与设施类型不兼容"],
    });
  });

  it("returns a Chinese validation result for malformed runtime policies", () => {
    expect(validateFacilityPolicy("all-day-dining", null as never)).toEqual({
      ok: false,
      reasons: ["设施运营策略结构无效"],
    });
  });
});
