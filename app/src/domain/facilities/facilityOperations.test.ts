import { describe, expect, it } from "vitest";

import {
  FACILITY_OFFERINGS,
  MENU_STRUCTURES,
  createFacilityPolicy,
  projectFacilityOfferings,
  projectMenuStructures,
  projectOperatingChoices,
  validateFacilityPolicy,
} from "./facilityOperations";

describe("light facility operations", () => {
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
