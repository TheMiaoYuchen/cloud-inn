import { describe, expect, it } from "vitest";

import { REPUTATION_UNLOCKS } from "../operations/unlocks";

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
  type SpaceMetricRules,
} from "./contentCatalog";

const spaceMetricFields = [
  "constructionCellCostCents",
  "constructionItemCostCents",
  "baseAppealBps",
  "appealPerCellBps",
  "basePrivacyBps",
  "quietZonePrivacyBps",
  "serviceDistanceAdvisoryMaximum",
] as const satisfies readonly (keyof SpaceMetricRules)[];

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
      expect(facility.allowedZoneIds.length).toBeGreaterThanOrEqual(
        facility.requiredZoneIds.length,
      );
      expect(facility.requiredItemIds.length).toBeGreaterThan(0);
      expect(facility.permittedItemIds.length).toBeGreaterThan(0);
      expect(facility.itemRules.map(({ id }) => id)).toEqual(
        facility.permittedItemIds,
      );
      for (const itemRule of facility.itemRules) {
        expect(itemRule.allowedZoneIds.length).toBeGreaterThan(0);
        expect(itemRule.allowedZoneIds.every((zoneId) =>
          facility.allowedZoneIds.includes(zoneId))).toBe(true);
      }
      expect(facility.metrics.constructionCellCostCents).toBeGreaterThan(0);
      expect(facility.metrics.constructionItemCostCents).toBeGreaterThan(0);
      expect(facility.metrics.baseAppealBps).toBeGreaterThanOrEqual(0);
      expect(facility.metrics.basePrivacyBps).toBeGreaterThanOrEqual(0);
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
      expect(facility.allowedZoneIds.every((id) => zoneIds.has(id))).toBe(true);
      expect(facility.requiredZoneIds.every((id) => facility.allowedZoneIds.includes(id))).toBe(true);
      expect(facility.permittedItemIds.every((id) => itemIds.has(id))).toBe(true);
      expect(facility.requiredItemIds.every((id) => facility.permittedItemIds.includes(id))).toBe(true);
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
    expect(Object.isFrozen(FACILITY_CATALOG[0].allowedZoneIds)).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0].requiredItemIds)).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0].itemRules)).toBe(true);
    expect(Object.isFrozen(FACILITY_CATALOG[0].metrics)).toBe(true);
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

  it.each(["service", "price"] as const)(
    "rejects discovered-need kind %s because settlement cannot produce it",
    (kind) => {
      const candidate = structuredClone(FACILITY_CATALOG) as FacilityCatalogEntry[];
      candidate[5] = {
        ...candidate[5],
        unlockRule: {
          all: [{ source: "discovered-need", segmentId: "leisure", kind }],
        },
      };

      expect(() => validateContentCatalog(candidate)).toThrow("需求类型");
    },
  );

  it("rejects completed choices outside the actual reputation unlock catalog", () => {
    const candidate = structuredClone(FACILITY_CATALOG) as FacilityCatalogEntry[];
    candidate[10] = {
      ...candidate[10],
      unlockRule: {
        all: [{
          source: "completed-content-choice",
          id: "operations:does-not-exist" as never,
        }],
      },
    };

    expect(() => validateContentCatalog(candidate)).toThrow("内容选择");
  });

  it.each(REPUTATION_UNLOCKS)(
    "accepts actual completed choice $key",
    ({ key }) => {
      const candidate = structuredClone(FACILITY_CATALOG) as FacilityCatalogEntry[];
      candidate[10] = {
        ...candidate[10],
        unlockRule: {
          all: [{ source: "completed-content-choice", id: key as never }],
        },
      };

      expect(validateContentCatalog(candidate)).toBeUndefined();
    },
  );

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

  it.each(spaceMetricFields)("rejects a missing metric field: %s", (field) => {
    const catalog = structuredClone(FACILITY_CATALOG) as any[];
    delete catalog[0].metrics[field];

    expect(() => validateContentCatalog(catalog)).toThrow("设施运营指标规则无效");
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ])("rejects an explicit %s metric value", (_label, value) => {
    const catalog = structuredClone(FACILITY_CATALOG) as any[];
    catalog[0].metrics.serviceDistanceAdvisoryMaximum = value;

    expect(() => validateContentCatalog(catalog)).toThrow("设施运营指标规则无效");
  });

  it("defines every editor and strategy zone in the single reference catalog", () => {
    expect(ZONE_CATALOG.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "zone:deck",
      "zone:service-route",
      "zone:entrance",
      "zone:reception",
      "zone:waiting",
      "zone:luggage",
      "zone:elevator-lobby",
      "zone:treatment",
      "zone:wet-route",
      "zone:stage",
      "zone:meeting-setup",
      "zone:partition",
    ]));
  });

  it.each([
    ["unknown allowed zone", (entry: any) => { entry.allowedZoneIds = ["zone:missing"]; }],
    ["required zone outside allowed set", (entry: any) => { entry.allowedZoneIds = ["zone:arrival"]; entry.requiredZoneIds = ["zone:waiting"]; }],
    ["duplicate allowed zone", (entry: any) => { entry.allowedZoneIds = ["zone:arrival", "zone:arrival"]; }],
    ["unknown required item", (entry: any) => { entry.requiredItemIds = ["item:missing"]; }],
    ["required item outside permitted set", (entry: any) => { entry.requiredItemIds = ["item:lounge-seat"]; entry.permittedItemIds = ["item:reception-desk"]; }],
    ["duplicate required item", (entry: any) => { entry.requiredItemIds = ["item:reception-desk", "item:reception-desk"]; }],
    ["invalid strategy", (entry: any) => { entry.strategy = "unknown"; }],
    ["unsafe metric", (entry: any) => { entry.metrics = { constructionCellCostCents: Number.MAX_SAFE_INTEGER + 1, constructionItemCostCents: 1, baseAppealBps: 1, appealPerCellBps: 1, basePrivacyBps: 1, quietZonePrivacyBps: 1 }; }],
    ["negative item capacity", (entry: any) => { entry.itemRules = [{ id: "item:reception-desk", capacity: -1, appealBps: 1, role: "service" }]; }],
    ["duplicate item rule", (entry: any) => { const rule = { id: "item:reception-desk", capacity: 0, appealBps: 1, role: "service" }; entry.itemRules = [rule, rule]; }],
    ["unknown item placement zone", (entry: any) => { entry.itemRules[0].allowedZoneIds = ["zone:missing"]; }],
    ["item placement zone outside facility", (entry: any) => { entry.itemRules[0].allowedZoneIds = ["zone:retail"]; }],
  ])("rejects invalid space definition rule: %s", (_label, mutate) => {
    const catalog = structuredClone(FACILITY_CATALOG) as any[];
    mutate(catalog[0]);
    expect(() => validateContentCatalog(catalog)).toThrow();
  });

  it.each([
    ["category", (entry: any) => { entry.category = "unknown"; }],
    ["operating mode", (entry: any) => { entry.operatingMode = "unknown"; }],
    ["operation group", (entry: any) => { entry.operationGroup = "unknown"; }],
    ["boost group with light mode", (entry: any) => { entry.operatingMode = "light-operation"; }],
    ["non-boost group with boost mode", (entry: any) => {
      entry.operationGroup = "dining";
      entry.operatingMode = "boost";
    }],
  ])("rejects invalid facility runtime enum consistency: %s", (_label, mutate) => {
    const catalog = structuredClone(FACILITY_CATALOG) as any[];
    mutate(catalog[0]);

    expect(() => validateContentCatalog(catalog)).toThrow("设施运营分类或模式无效");
  });
});
