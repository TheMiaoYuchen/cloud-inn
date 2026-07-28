import { describe, expect, it } from "vitest";

import { FACILITY_CATALOG } from "../content/contentCatalog";
import {
  addSpaceDoor,
  createSpaceDraft,
  paintSpaceRectangle,
  placeSpaceItem,
} from "./spaceEditor";
import { validatePublicSpace } from "./spaceValidation";
import type { SpaceDraft } from "./spaceTypes";

function rectangle(
  type: SpaceDraft["type"],
  zones: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  columns = 12,
  rows = 12,
): SpaceDraft {
  let draft = createSpaceDraft(type, columns, rows);
  for (const zone of zones) {
    draft = paintSpaceRectangle(draft, zone, zone.id);
  }
  return draft;
}

function validLobby() {
  return playableLobby();
}

function invalidRestaurantWithoutKitchen() {
  const draft = playableDining("all-day-dining");
  return {
    ...draft,
    cells: draft.cells.map((cell) => cell.zoneId === "zone:kitchen"
      ? { ...cell, zoneId: "zone:back-of-house" }
      : cell),
  };
}

function invalidPoolWithoutDeck() {
  const draft = playablePool();
  return {
    ...draft,
    cells: draft.cells.map((cell) => cell.zoneId === "zone:deck"
      ? { ...cell, zoneId: "zone:wet" }
      : cell),
  };
}

function invalidSpaWithoutPrivacy() {
  const draft = playableSpa();
  return {
    ...draft,
    cells: draft.cells.map((cell) => cell.x === 3 && cell.y === 4
      ? { ...cell, zoneId: "zone:treatment" }
      : cell),
    items: draft.items.map((item) => item.id === "bed:1"
      ? { ...item, x: 3, y: 4 }
      : item),
  };
}

function invalidBallroomWithoutEgress() {
  return { ...playableEvent("ballroom"), doors: [] };
}

function addItem(
  draft: SpaceDraft,
  id: string,
  catalogItemId: string,
  x: number,
  y: number,
  width = 1,
  height = 1,
): SpaceDraft {
  return placeSpaceItem(draft, {
    id, catalogItemId, x, y, width, height, rotation: 0,
  });
}

function addRepeatedItems(
  draft: SpaceDraft,
  catalogItemId: string,
  count: number,
  startX: number,
  startY: number,
): SpaceDraft {
  let next = draft;
  for (let index = 0; index < count; index += 1) {
    next = addItem(next, `${catalogItemId}:${index}`, catalogItemId, startX + index, startY);
  }
  return next;
}

function playableLobby(): SpaceDraft {
  let draft = rectangle("sky-lobby", [
    { id: "zone:arrival", x: 0, y: 0, width: 2, height: 2 },
    { id: "zone:entrance", x: 0, y: 2, width: 2, height: 4 },
    { id: "zone:reception", x: 2, y: 2, width: 2, height: 4 },
    { id: "zone:waiting", x: 4, y: 0, width: 5, height: 4 },
    { id: "zone:luggage", x: 2, y: 6, width: 2, height: 2 },
    { id: "zone:elevator-lobby", x: 4, y: 4, width: 5, height: 4 },
  ]);
  draft = addSpaceDoor(draft, { x: 0, y: 2, side: "west" });
  draft = addItem(draft, "reception:1", "item:reception-desk", 2, 2);
  return addRepeatedItems(draft, "item:lounge-seat", 5, 4, 1);
}

function playableDining(type: "all-day-dining" | "chinese-restaurant" | "bar"): SpaceDraft {
  const serviceZone = type === "bar" ? "zone:bar-service" : "zone:kitchen";
  const guestItem = type === "bar" ? "item:lounge-seat" : "item:dining-table";
  const serviceItem = type === "bar" ? "item:bar-counter" : "item:service-counter";
  const guestCount = type === "all-day-dining" ? 8 : type === "chinese-restaurant" ? 6 : 8;
  let draft = rectangle(type, [
    { id: "zone:seating", x: 0, y: 0, width: 10, height: 10 },
    { id: "zone:service-route", x: 10, y: 0, width: 1, height: 10 },
    { id: serviceZone, x: 11, y: 0, width: 3, height: 10 },
  ], 16, 12);
  draft = addRepeatedItems(draft, guestItem, guestCount, 0, 1);
  return addItem(draft, "service:1", serviceItem, 11, 1);
}

function playablePool(): SpaceDraft {
  let draft = rectangle("pool", [
    { id: "zone:wet", x: 3, y: 3, width: 4, height: 4 },
    { id: "zone:deck", x: 2, y: 2, width: 6, height: 1 },
    { id: "zone:deck", x: 2, y: 7, width: 6, height: 1 },
    { id: "zone:deck", x: 2, y: 3, width: 1, height: 4 },
    { id: "zone:deck", x: 7, y: 3, width: 1, height: 4 },
    { id: "zone:wet-route", x: 0, y: 2, width: 2, height: 1 },
  ]);
  draft = addSpaceDoor(draft, { x: 0, y: 2, side: "west" });
  return addItem(draft, "pool:1", "item:pool", 3, 3, 4, 4);
}

function playableSpa(): SpaceDraft {
  let draft = rectangle("spa", [
    { id: "zone:treatment", x: 0, y: 0, width: 4, height: 4 },
    { id: "zone:quiet", x: 4, y: 0, width: 2, height: 4 },
    { id: "zone:reception", x: 0, y: 4, width: 4, height: 2 },
    { id: "zone:wet", x: 4, y: 4, width: 4, height: 4 },
  ]);
  draft = addSpaceDoor(draft, { x: 0, y: 5, side: "south" });
  draft = addItem(draft, "reception:1", "item:reception-desk", 0, 4);
  draft = addItem(draft, "bed:1", "item:treatment-bed", 0, 0);
  return addItem(draft, "bed:2", "item:treatment-bed", 2, 0);
}

function playableEvent(type: "ballroom" | "meeting-room"): SpaceDraft {
  if (type === "meeting-room") {
    let draft = rectangle(type, [
      { id: "zone:event", x: 0, y: 0, width: 10, height: 6 },
      { id: "zone:meeting-setup", x: 0, y: 6, width: 10, height: 2 },
      { id: "zone:back-of-house", x: 10, y: 0, width: 2, height: 6 },
      { id: "zone:partition", x: 10, y: 6, width: 2, height: 2 },
    ]);
    draft = addSpaceDoor(draft, { x: 0, y: 0, side: "north" });
    return addItem(draft, "meeting:1", "item:meeting-table", 1, 1);
  }
  let draft = rectangle(type, [
    { id: "zone:event", x: 0, y: 0, width: 16, height: 10 },
    { id: "zone:back-of-house", x: 16, y: 0, width: 4, height: 10 },
    { id: "zone:stage", x: 0, y: 10, width: 16, height: 2 },
    { id: "zone:service-route", x: 16, y: 10, width: 4, height: 2 },
    { id: "zone:partition", x: 20, y: 0, width: 1, height: 12 },
  ], 24, 16);
  draft = addSpaceDoor(addSpaceDoor(draft,
    { x: 0, y: 0, side: "north" }),
    { x: 10, y: 0, side: "north" });
  draft = addRepeatedItems(draft, "item:event-table", 8, 1, 1);
  return addItem(draft, "service:1", "item:service-counter", 16, 1);
}

function playableGeneral(type: "executive-lounge" | "gym" | "garden-terrace" | "boutique"): SpaceDraft {
  if (type === "executive-lounge") {
    let draft = rectangle(type, [{ id: "zone:quiet", x: 0, y: 0, width: 10, height: 8 }]);
    draft = addRepeatedItems(draft, "item:lounge-seat", 4, 0, 1);
    return addItem(draft, "service:1", "item:service-counter", 5, 1);
  }
  if (type === "gym") {
    return addRepeatedItems(
      rectangle(type, [{ id: "zone:fitness", x: 0, y: 0, width: 10, height: 8 }]),
      "item:fitness-station", 4, 0, 1,
    );
  }
  if (type === "garden-terrace") {
    let draft = rectangle(type, [{ id: "zone:terrace", x: 0, y: 0, width: 10, height: 8 }]);
    draft = addItem(draft, "planter:1", "item:planter", 0, 0);
    return addRepeatedItems(draft, "item:lounge-seat", 3, 1, 1);
  }
  return addItem(
    rectangle(type, [{ id: "zone:retail", x: 0, y: 0, width: 10, height: 8 }]),
    "display:1", "item:display-case", 1, 1,
  );
}

function playableDraft(type: SpaceDraft["type"]): SpaceDraft {
  if (type === "sky-lobby") return playableLobby();
  if (type === "all-day-dining" || type === "chinese-restaurant" || type === "bar") return playableDining(type);
  if (type === "pool") return playablePool();
  if (type === "spa") return playableSpa();
  if (type === "ballroom" || type === "meeting-room") return playableEvent(type);
  return playableGeneral(type);
}

describe("public-space validation strategies", () => {
  it.each(FACILITY_CATALOG)("accepts a complete playable $type path", ({ type }) => {
    expect(validatePublicSpace(playableDraft(type)).blocking).toEqual([]);
  });

  it.each(FACILITY_CATALOG.flatMap((definition) =>
    definition.requiredZoneIds.map((zoneId) => ({ definition, zoneId })),
  ))("blocks $definition.type without required zone $zoneId", ({ definition, zoneId }) => {
    const draft = playableDraft(definition.type);
    const missing = {
      ...draft,
      cells: draft.cells.filter((cell) => cell.zoneId !== zoneId),
    };
    const expected = definition.strategy === "dining" && zoneId === "zone:kitchen"
      ? "必须设置厨房或备餐区"
      : definition.strategy === "pool" && zoneId === "zone:deck"
        ? "泳池必须设置连续池岸"
        : `缺少必需分区：${zoneId}`;
    expect(validatePublicSpace(missing).blocking.map(({ message }) => message)).toContain(expected);
  });

  it.each(FACILITY_CATALOG.flatMap((definition) =>
    definition.requiredItemIds.map((itemId) => ({ definition, itemId })),
  ))("blocks $definition.type without required item $itemId", ({ definition, itemId }) => {
    const draft = playableDraft(definition.type);
    const missing = {
      ...draft,
      items: draft.items.filter((item) => item.catalogItemId !== itemId),
    };
    expect(validatePublicSpace(missing).blocking.map(({ message }) => message)).toContain(
      `缺少必需物件：${itemId}`,
    );
  });

  it("blocks catalog-known zones that are not allowed by the space definition", () => {
    const draft = playableDraft("gym");
    const disallowed = paintSpaceRectangle(
      draft,
      { x: 9, y: 7, width: 1, height: 1 },
      "zone:retail",
    );
    expect(validatePublicSpace(disallowed).blocking.map(({ message }) => message)).toContain(
      "分区不适用于该空间：zone:retail",
    );
  });

  it("blocks required items placed outside their catalog-defined zones", () => {
    const draft = playableLobby();
    const misplaced = {
      ...draft,
      items: draft.items.map((item) => item.catalogItemId === "item:reception-desk"
        ? { ...item, x: 4, y: 0 }
        : item),
    };
    expect(validatePublicSpace(misplaced).blocking.map(({ message }) => message)).toContain(
      "物件 reception:1 必须放置于适用分区",
    );
  });

  it.each(FACILITY_CATALOG)("uses actual rather than clamped capacity for $type", (definition) => {
    const draft = playableDraft(definition.type);
    const belowMinimum = {
      ...draft,
      items: [],
    };
    const result = validatePublicSpace(belowMinimum);
    expect(result.metrics.capacity).toBeLessThan(definition.defaultCapacity.minimum);
    expect(result.blocking.map(({ message }) => message)).toContain(
      `实际容量低于最低要求：${definition.defaultCapacity.minimum}`,
    );
  });

  it("enforces lobby flow relationships", () => {
    const draft = playableLobby();
    const broken = {
      ...draft,
      cells: [
        ...draft.cells.filter((cell) => cell.zoneId !== "zone:entrance"),
        { x: 10, y: 10, zoneId: "zone:entrance" },
      ],
    };
    expect(validatePublicSpace(broken).blocking.map(({ message }) => message)).toContain(
      "大堂入口必须连接接待区",
    );
  });

  it.each(["all-day-dining", "chinese-restaurant", "bar"] as const)(
    "requires a connected service route for %s",
    (type) => {
      const draft = playableDining(type);
      const missing = {
        ...draft,
        cells: draft.cells.filter((cell) => cell.zoneId !== "zone:service-route"),
      };
      expect(validatePublicSpace(missing).blocking.map(({ message }) => message)).toContain(
        "餐饮服务路线必须连接服务区与座位区",
      );
    },
  );

  it("detects a service route blocked by an item footprint", () => {
    const draft = playableDining("all-day-dining");
    const blocked = {
      ...draft,
      items: draft.items.map((item, index) => index === 0 ? { ...item, x: 10, y: 5 } : item),
    };
    expect(validatePublicSpace(blocked).blocking.map(({ message }) => message)).toContain(
      "餐饮服务路线必须连接服务区与座位区",
    );
  });

  it("requires pool wet-route safety access", () => {
    const draft = playablePool();
    const inaccessible = { ...draft, doors: [] };
    expect(validatePublicSpace(inaccessible).blocking.map(({ message }) => message)).toContain(
      "泳池必须设置安全通达入口",
    );
  });

  it("does not treat a spa without treatment beds as private", () => {
    const draft = playableSpa();
    const withoutBeds = {
      ...draft,
      items: draft.items.filter(({ catalogItemId }) => catalogItemId !== "item:treatment-bed"),
    };
    expect(validatePublicSpace(withoutBeds).blocking.map(({ message }) => message)).toContain(
      "护理区私密性不足",
    );
  });

  it("requires dedicated meeting-room egress", () => {
    const draft = playableEvent("meeting-room");
    expect(validatePublicSpace({ ...draft, doors: [] }).blocking.map(({ message }) => message)).toContain(
      "会议空间疏散出口不足",
    );
  });

  it.each([
    ["ballroom", "宴会厅疏散出口不足"],
    ["meeting-room", "会议空间疏散出口不足"],
  ] as const)("does not count interior doors as %s egress", (type, expected) => {
    const draft = playableEvent(type);
    const interiorDoors = type === "ballroom"
      ? [
          { x: 1, y: 1, side: "north" as const },
          { x: 2, y: 1, side: "north" as const },
        ]
      : [{ x: 1, y: 1, side: "north" as const }];
    expect(validatePublicSpace({ ...draft, doors: interiorDoors }).blocking.map(
      ({ message }) => message,
    )).toContain(expected);
  });
  it.each([
    ["sky-lobby", validLobby(), []],
    ["all-day-dining", invalidRestaurantWithoutKitchen(), ["必须设置厨房或备餐区"]],
    ["pool", invalidPoolWithoutDeck(), ["泳池必须设置连续池岸"]],
    ["spa", invalidSpaWithoutPrivacy(), ["护理区私密性不足"]],
    ["ballroom", invalidBallroomWithoutEgress(), ["宴会厅疏散出口不足"]],
  ])("validates %s with its strategy", (_kind, draft, expectedBlocking) => {
    expect(validatePublicSpace(draft).blocking.map((issue) => issue.message)).toEqual(
      expectedBlocking,
    );
  });

  it("returns every actionable catalog issue in deterministic blocking/advisory groups", () => {
    const draft = paintSpaceRectangle(
      createSpaceDraft("gym", 4, 4),
      { x: 0, y: 0, width: 1, height: 1 },
      "zone:unknown",
    );
    const withUnknownItem = placeSpaceItem(draft, {
      id: "unknown:1", catalogItemId: "item:unknown",
      x: 2, y: 2, width: 1, height: 1, rotation: 0,
    });

    expect(validatePublicSpace(withUnknownItem)).toMatchObject({
      blocking: [
        { code: "required-zone:zone:fitness", message: "缺少必需分区：zone:fitness" },
        { code: "unknown-zone:zone:unknown", message: "分区未在目录中定义：zone:unknown" },
        { code: "unknown-item:item:unknown", message: "物件未在目录中定义：item:unknown" },
        { code: "required-item:item:fitness-station", message: "缺少必需物件：item:fitness-station" },
        { code: "minimum-capacity", message: "实际容量低于最低要求：8" },
      ],
      advisory: [],
    });
  });

  it("returns all lobby requirements without short-circuiting", () => {
    const result = validatePublicSpace(rectangle("sky-lobby", [
      { id: "zone:arrival", x: 0, y: 0, width: 4, height: 4 },
    ]));
    expect(result.blocking.map(({ message }) => message)).toEqual(expect.arrayContaining([
      "缺少必需分区：zone:entrance",
      "缺少必需分区：zone:reception",
      "缺少必需分区：zone:waiting",
      "缺少必需分区：zone:luggage",
      "缺少必需分区：zone:elevator-lobby",
      "缺少必需物件：item:reception-desk",
      "缺少必需物件：item:lounge-seat",
      "大堂必须设置入口",
    ]));
  });

  it("includes imported editor errors in blocking issues without losing metrics", () => {
    const draft = rectangle("gym", [
      { id: "zone:fitness", x: 0, y: 0, width: 2, height: 2 },
    ]);
    const malformed = {
      ...draft,
      items: [
        { id: "station:1", catalogItemId: "item:fitness-station", x: 10, y: 0, width: 2, height: 1, rotation: 0 as const },
        { id: "station:2", catalogItemId: "item:fitness-station", x: 11, y: 0, width: 2, height: 1, rotation: 0 as const },
      ],
    };
    const result = validatePublicSpace(malformed);
    expect(result.blocking.map(({ message }) => message)).toEqual(expect.arrayContaining([
      "物件超出空间边界",
      "物件不能互相重叠",
      "缺少必需物件：item:fitness-station",
      "实际容量低于最低要求：8",
    ]));
    expect(Object.values(result.metrics).every(Number.isSafeInteger)).toBe(true);
  });

  it("keeps metrics safe when imported coordinates are non-finite", () => {
    const draft = validLobby();
    const malformed = {
      ...draft,
      items: draft.items.map((item, index) =>
        index === 0 ? { ...item, x: Number.NaN } : item,
      ),
    };

    const result = validatePublicSpace(malformed);
    expect(result.blocking.map(({ message }) => message)).toContain(
      "物件尺寸和坐标必须是有效整数",
    );
    expect(Object.values(result.metrics).every(Number.isSafeInteger)).toBe(true);
  });

  it.each([
    ["NaN x", { x: Number.NaN }, "物件尺寸和坐标必须是有效整数"],
    ["infinite x", { x: Number.POSITIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["infinite y", { y: Number.POSITIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["infinite width", { width: Number.POSITIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["infinite height", { height: Number.POSITIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["paired infinite x/width", { x: Number.POSITIVE_INFINITY, width: Number.NEGATIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["paired infinite width/x", { x: Number.NEGATIVE_INFINITY, width: Number.POSITIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["paired infinite y/height", { y: Number.POSITIVE_INFINITY, height: Number.NEGATIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["paired infinite height/y", { y: Number.NEGATIVE_INFINITY, height: Number.POSITIVE_INFINITY }, "物件尺寸和坐标必须是有效整数"],
    ["extreme x", { x: Number.MAX_SAFE_INTEGER }, "物件超出空间边界"],
    ["zero width", { width: 0 }, "物件尺寸和坐标必须是有效整数"],
    ["negative height", { height: -1 }, "物件尺寸和坐标必须是有效整数"],
  ])("rejects unsafe pool geometry without unbounded perimeter work: %s", (_label, geometry, expectedGeometryIssue) => {
    let draft = rectangle("pool", [
      { id: "zone:wet", x: 2, y: 2, width: 4, height: 4 },
      { id: "zone:deck", x: 1, y: 1, width: 6, height: 1 },
      { id: "zone:deck", x: 1, y: 6, width: 6, height: 1 },
      { id: "zone:deck", x: 1, y: 2, width: 1, height: 4 },
      { id: "zone:deck", x: 6, y: 2, width: 1, height: 4 },
    ]);
    draft = placeSpaceItem(draft, {
      id: "pool:1", catalogItemId: "item:pool",
      x: 2, y: 2, width: 4, height: 4, rotation: 0,
    });
    const malformed = {
      ...draft,
      items: [{ ...draft.items[0], ...geometry }],
    };

    const startedAt = performance.now();
    const result = validatePublicSpace(malformed);
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(result.blocking.map(({ message }) => message)).toContain(expectedGeometryIssue);
    expect(result.blocking.map(({ message }) => message)).toContain(
      "泳池必须设置连续池岸",
    );
    expect(Object.values(result.metrics).every(Number.isSafeInteger)).toBe(true);
  });

  it("requires one connected deck ring around a pool", () => {
    const draft = playablePool();
    expect(validatePublicSpace(draft).blocking.map(({ message }) => message)).toEqual([]);

    const broken = paintSpaceRectangle(
      eraseDeckCell(draft, 2, 4),
      { x: 2, y: 4, width: 1, height: 1 },
      "zone:wet",
    );
    expect(validatePublicSpace(broken).blocking.map(({ message }) => message)).toContain(
      "泳池必须设置连续池岸",
    );
  });

  it("dispatches all 12 catalog definitions and returns safe deterministic metrics", () => {
    for (const definition of FACILITY_CATALOG) {
      const draft = playableDraft(definition.type);
      const first = validatePublicSpace(draft);
      const second = validatePublicSpace(draft);
      expect(second).toEqual(first);
      expect(Object.values(first.metrics).every(Number.isSafeInteger)).toBe(true);
      expect(first.metrics.constructionCostCents).toBeGreaterThanOrEqual(
        definition.constructionCostCents.minimum,
      );
      expect(first.metrics.capacity).toBeGreaterThanOrEqual(
        definition.defaultCapacity.minimum,
      );
      expect(first.metrics.capacity).toBeLessThanOrEqual(
        definition.defaultCapacity.maximum,
      );
    }
  });

  it("derives construction, capacity, appeal, privacy and service distance from catalog rules", () => {
    const diningDefinition = FACILITY_CATALOG.find(({ type }) => type === "all-day-dining")!;
    const dining = playableDining("all-day-dining");
    const diningMetrics = validatePublicSpace(dining).metrics;
    const expectedConstruction = Math.min(
      diningDefinition.constructionCostCents.maximum,
      diningDefinition.constructionCostCents.minimum +
        dining.cells.length * diningDefinition.metrics.constructionCellCostCents +
        dining.items.length * diningDefinition.metrics.constructionItemCostCents,
    );
    expect(diningMetrics.constructionCostCents).toBe(expectedConstruction);
    expect(diningMetrics.capacity).toBe(32);
    expect(diningMetrics.serviceDistance).toBe(8);

    const privateSpa = validatePublicSpace(playableSpa()).metrics;
    const exposedSpa = validatePublicSpace(invalidSpaWithoutPrivacy()).metrics;
    expect(privateSpa.privacyBps).toBeGreaterThan(exposedSpa.privacyBps);
    expect(validatePublicSpace(playablePool()).metrics.guestAppealBps).not.toBe(
      diningMetrics.guestAppealBps,
    );
  });

  it("clamps an imported service-distance average that exceeds the safe integer range", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const draft: SpaceDraft = {
      type: "executive-lounge",
      columns: maximum,
      rows: maximum,
      cells: [
        { x: 0, y: 0, zoneId: "zone:quiet" },
        { x: maximum - 2, y: maximum - 2, zoneId: "zone:quiet" },
      ],
      items: [
        {
          id: "service:1", catalogItemId: "item:service-counter",
          x: 0, y: 0, width: 1, height: 1, rotation: 0,
        },
        {
          id: "seat:1", catalogItemId: "item:lounge-seat",
          x: maximum - 2, y: maximum - 2, width: 1, height: 1, rotation: 0,
        },
      ],
      walls: [],
      doors: [],
      windows: [],
    };

    const result = validatePublicSpace(draft);

    expect(result.metrics.serviceDistance).toBe(maximum);
    expect(result.advisory.map(({ code }) => code)).toContain("service-distance");
  });

  it("excludes unknown and colliding items from every metric", () => {
    const draft = playableDraft("gym");
    const baseline = validatePublicSpace(draft).metrics;
    const malformed = {
      ...draft,
      items: [
        ...draft.items,
        {
          id: "station:collision", catalogItemId: "item:fitness-station",
          x: 0, y: 1, width: 1, height: 1, rotation: 0 as const,
        },
        {
          id: "unknown:1", catalogItemId: "item:unknown",
          x: 8, y: 1, width: 1, height: 1, rotation: 0 as const,
        },
      ],
    };
    expect(validatePublicSpace(malformed).metrics).toEqual(baseline);
  });

  it("bounds oversized imported collections and keeps all aggregates safe", () => {
    const draft = playableDraft("gym");
    const oversized = {
      ...draft,
      cells: Array.from({ length: 4_098 }, (_, index) => ({
        x: index % 10,
        y: Math.floor(index / 10) % 8,
        zoneId: "zone:fitness",
      })),
      items: Array.from({ length: 514 }, (_, index) => ({
        id: `station:oversized:${index}`,
        catalogItemId: "item:fitness-station",
        x: index % 10,
        y: 1 + (Math.floor(index / 10) % 7),
        width: 1,
        height: 1,
        rotation: 0 as const,
      })),
    };
    const first = validatePublicSpace(oversized);
    const second = validatePublicSpace(oversized);
    expect(second).toEqual(first);
    expect(Object.values(first.metrics).every(Number.isSafeInteger)).toBe(true);
    expect(first.blocking.map(({ message }) => message)).toEqual(expect.arrayContaining([
      "空间单元数量超过上限",
      "空间物件数量超过上限",
    ]));
  });
});

function eraseDeckCell(draft: SpaceDraft, x: number, y: number): SpaceDraft {
  return { ...draft, cells: draft.cells.filter((cell) => cell.x !== x || cell.y !== y) };
}
