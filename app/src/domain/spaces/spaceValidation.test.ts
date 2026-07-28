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
): SpaceDraft {
  let draft = createSpaceDraft(type, 12, 12);
  for (const zone of zones) {
    draft = paintSpaceRectangle(draft, zone, zone.id);
  }
  return draft;
}

function validLobby() {
  let draft = rectangle("sky-lobby", [
    { id: "zone:arrival", x: 0, y: 0, width: 12, height: 12 },
  ]);
  draft = addSpaceDoor(draft, { x: 0, y: 0, side: "north" });
  return placeSpaceItem(
    placeSpaceItem(draft, {
      id: "reception:1", catalogItemId: "item:reception-desk",
      x: 2, y: 2, width: 2, height: 1, rotation: 0,
    }),
    {
      id: "seat:1", catalogItemId: "item:lounge-seat",
      x: 6, y: 2, width: 1, height: 1, rotation: 0,
    },
  );
}

function invalidRestaurantWithoutKitchen() {
  let draft = rectangle("all-day-dining", [
    { id: "zone:seating", x: 0, y: 0, width: 12, height: 12 },
  ]);
  draft = placeSpaceItem(draft, {
    id: "table:1", catalogItemId: "item:dining-table",
    x: 2, y: 2, width: 1, height: 1, rotation: 0,
  });
  return draft;
}

function invalidPoolWithoutDeck() {
  return placeSpaceItem(
    rectangle("pool", [
      { id: "zone:wet", x: 2, y: 2, width: 8, height: 8 },
    ]),
    {
      id: "pool:1", catalogItemId: "item:pool",
      x: 3, y: 3, width: 6, height: 6, rotation: 0,
    },
  );
}

function invalidSpaWithoutPrivacy() {
  let draft = rectangle("spa", [
    { id: "zone:quiet", x: 0, y: 0, width: 6, height: 12 },
    { id: "zone:wet", x: 6, y: 0, width: 6, height: 12 },
  ]);
  return placeSpaceItem(draft, {
    id: "bed:1", catalogItemId: "item:treatment-bed",
    x: 5, y: 2, width: 1, height: 2, rotation: 0,
  });
}

function invalidBallroomWithoutEgress() {
  let draft = rectangle("ballroom", [
    { id: "zone:event", x: 0, y: 0, width: 9, height: 12 },
    { id: "zone:back-of-house", x: 9, y: 0, width: 3, height: 12 },
  ]);
  return placeSpaceItem(draft, {
    id: "table:1", catalogItemId: "item:event-table",
    x: 2, y: 2, width: 2, height: 2, rotation: 0,
  });
}

describe("public-space validation strategies", () => {
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
      ],
      advisory: [
        { code: "recommended-item", message: "建议至少放置一件适用物件" },
      ],
    });
  });

  it("checks lobby entry and reception while keeping waiting guidance advisory", () => {
    const result = validatePublicSpace(rectangle("sky-lobby", [
      { id: "zone:arrival", x: 0, y: 0, width: 4, height: 4 },
    ]));
    expect(result.blocking.map(({ message }) => message)).toEqual([
      "大堂必须设置入口",
      "大堂必须设置接待台",
    ]);
    expect(result.advisory.map(({ message }) => message)).toContain(
      "建议设置等候座位并靠近接待区",
    );
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
    expect(result.blocking.map(({ message }) => message)).toEqual([
      "物件超出空间边界",
      "物件不能互相重叠",
    ]);
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

  it("requires one connected deck ring around a pool", () => {
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
    expect(validatePublicSpace(draft).blocking.map(({ message }) => message)).toEqual([]);

    const broken = paintSpaceRectangle(
      eraseDeckCell(draft, 1, 3),
      { x: 1, y: 3, width: 1, height: 1 },
      "zone:wet",
    );
    expect(validatePublicSpace(broken).blocking.map(({ message }) => message)).toContain(
      "泳池必须设置连续池岸",
    );
  });

  it("dispatches all 12 catalog definitions and returns safe deterministic metrics", () => {
    for (const definition of FACILITY_CATALOG) {
      let draft = createSpaceDraft(definition.type, 12, 12);
      definition.requiredZoneIds.forEach((zoneId, index) => {
        draft = paintSpaceRectangle(
          draft,
          { x: index * 2, y: 0, width: 2, height: 2 },
          zoneId,
        );
      });
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
});

function eraseDeckCell(draft: SpaceDraft, x: number, y: number): SpaceDraft {
  return { ...draft, cells: draft.cells.filter((cell) => cell.x !== x || cell.y !== y) };
}
