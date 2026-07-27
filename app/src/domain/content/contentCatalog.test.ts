import { describe, expect, it } from "vitest";

import {
  APPROVED_PUBLIC_SPACE_TYPES,
  CONTENT_PROGRESS_SOURCES,
  FACILITY_CATALOG,
  FLOOR_TEMPLATE_CATALOG,
  TOWER_CATALOG,
  ITEM_CATALOG,
  ZONE_CATALOG,
  validateContentCatalog,
  type FacilityCatalogEntry,
} from "./contentCatalog";

describe("content catalog", () => {
  it("exposes all approved facilities in deterministic display order", () => {
    expect(FACILITY_CATALOG.map(({ id }) => id)).toEqual(
      APPROVED_PUBLIC_SPACE_TYPES,
    );
    expect(FACILITY_CATALOG.map(({ displayOrder }) => displayOrder)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(validateContentCatalog()).toBeUndefined();
  });

  it("defines complete playable metadata with the approved operating semantics", () => {
    expect(FACILITY_CATALOG).toHaveLength(12);
    for (const facility of FACILITY_CATALOG) {
      expect(facility.name.length).toBeGreaterThan(0);
      expect(facility.requiredZoneIds.length).toBeGreaterThan(0);
      expect(facility.permittedItemIds.length).toBeGreaterThan(0);
      expect(facility.constructionCostCents.minimum).toBeGreaterThanOrEqual(0);
      expect(facility.constructionCostCents.maximum).toBeGreaterThanOrEqual(
        facility.constructionCostCents.minimum,
      );
      expect(facility.defaultCapacity.maximum).toBeGreaterThanOrEqual(
        facility.defaultCapacity.minimum,
      );
    }

    expect(
      FACILITY_CATALOG.filter(({ operatingMode }) =>
        operatingMode === "light-operation"
      ).map(({ type }) => type),
    ).toEqual([
      "all-day-dining",
      "chinese-restaurant",
      "bar",
      "spa",
      "ballroom",
      "meeting-room",
    ]);
    expect(JSON.stringify(FACILITY_CATALOG)).not.toMatch(/ingredient/i);
    expect(TOWER_CATALOG).toEqual([
      expect.objectContaining({ id: "building-template:first-tower" }),
    ]);
    expect(FLOOR_TEMPLATE_CATALOG).toContainEqual(
      expect.objectContaining({
        id: "template:guest:dense-ring",
        slotsPerSide: 8,
        roomAreaSquareMeters: 24,
      }),
    );
  });

  it("references only known zones, items, and progress sources", () => {
    const zoneIds = new Set(ZONE_CATALOG.map(({ id }) => id));
    const itemIds = new Set(ITEM_CATALOG.map(({ id }) => id));

    for (const facility of FACILITY_CATALOG) {
      expect(facility.requiredZoneIds.every((id) => zoneIds.has(id))).toBe(true);
      expect(facility.permittedItemIds.every((id) => itemIds.has(id))).toBe(true);
      for (const prerequisite of facility.unlockRule.all) {
        expect(CONTENT_PROGRESS_SOURCES).toContain(prerequisite.source);
      }
    }
  });

  it("deep-freezes exported catalogs and their nested records at runtime", () => {
    expect(Object.isFrozen(FACILITY_CATALOG)).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0])).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0].constructionCostCents)).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0].requiredZoneIds)).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0].unlockRule)).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0].unlockRule.all)).toBe(true);
    expect(Object.isFrozen(APPROVED_PUBLIC_SPACE_TYPES)).toBe(true);
    expect(Object.isFrozen(ZONE_CATALOG)).toBe(true);
    expect(Object.isFrozen(ITEM_CATALOG)).toBe(true);
    expect(Object.isFrozen(FLOOR_TEMPLATE_CATALOG)).toBe(true);
    expect(Object.isFrozen(TOWER_CATALOG)).toBe(true);
    expect(() => {
      (FACILITY_CATALOG[0].constructionCostCents as { minimum: number }).minimum = 1;
    }).toThrow();
  });

  it("rejects subsets and reordered candidates even when display order is renumbered", () => {
    const subset = structuredClone(FACILITY_CATALOG).slice(1).map(
      (entry, displayOrder) => ({ ...entry, displayOrder }),
    );
    const reordered = [...structuredClone(FACILITY_CATALOG)]
      .reverse()
      .map((entry, displayOrder) => ({ ...entry, displayOrder }));

    expect(() => validateContentCatalog(subset)).toThrow("批准");
    expect(() => validateContentCatalog(reordered)).toThrow("批准");
  });

  it("resolves prerequisite facility references against the supplied candidate", () => {
    const candidate = structuredClone(FACILITY_CATALOG) as FacilityCatalogEntry[];
    candidate[8] = {
      ...candidate[8],
      unlockRule: {
        all: [
          { source: "reputation", thresholdBps: 7_000 },
          { source: "built-facility", facilityType: "missing" as never },
        ],
      },
    };

    expect(() => validateContentCatalog(candidate)).toThrow("未知设施类型");
  });

  it.each([
    ["duplicate IDs", (catalog: FacilityCatalogEntry[]) => {
      catalog[1] = { ...catalog[1], id: catalog[0].id };
    }],
    ["missing zone references", (catalog: FacilityCatalogEntry[]) => {
      catalog[0] = { ...catalog[0], requiredZoneIds: ["zone:missing" as never] };
    }],
    ["missing item references", (catalog: FacilityCatalogEntry[]) => {
      catalog[0] = { ...catalog[0], permittedItemIds: ["item:missing" as never] };
    }],
    ["unsafe money", (catalog: FacilityCatalogEntry[]) => {
      catalog[0] = {
        ...catalog[0],
        constructionCostCents: {
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER + 1,
        },
      };
    }],
    ["invalid ranges", (catalog: FacilityCatalogEntry[]) => {
      catalog[0] = {
        ...catalog[0],
        defaultCapacity: { minimum: 20, maximum: 10 },
      };
    }],
    ["nondeterministic display order", (catalog: FacilityCatalogEntry[]) => {
      catalog[0] = { ...catalog[0], displayOrder: 2 };
    }],
    ["unknown facility prerequisites", (catalog: FacilityCatalogEntry[]) => {
      catalog[8] = {
        ...catalog[8],
        unlockRule: {
          all: [{ source: "built-facility", facilityType: "missing" as never }],
        },
      };
    }],
  ])("rejects %s", (_label, mutate) => {
    const catalog = structuredClone(FACILITY_CATALOG) as FacilityCatalogEntry[];
    mutate(catalog);

    expect(() => validateContentCatalog(catalog)).toThrow();
  });
});
