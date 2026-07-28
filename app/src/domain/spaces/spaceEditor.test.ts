import { describe, expect, it } from "vitest";

import type { Cell } from "../game/state";
import { createRoomDraft, validateRoomDraft } from "../room/editRoom";
import {
  addSpaceDoor,
  addSpaceWall,
  addSpaceWindow,
  alignPlacedItems,
  commitSpaceEdit,
  createSpaceDraft,
  createSpaceHistory,
  eraseSpaceCell,
  paintSpaceRectangle,
  paintSpaceCell,
  placeSpaceItem,
  redoSpaceEdit,
  rotatePlacedItem,
  spaceSelectionBounds,
  snapPlacedItem,
  undoSpaceEdit,
  validateSpaceDraft,
  validateSpaceConnectivity,
  zoneAt,
} from "./spaceEditor";
import {
  SPACE_EDITOR_HISTORY_LIMIT,
  SPACE_EDITOR_MAX_CELLS,
  SPACE_EDITOR_MAX_ITEMS,
} from "./spaceTypes";

function legacyValidRoomDraft() {
  const cells: Cell[] = [
    { x: 0, y: 0, zone: "bedroom" },
    { x: 1, y: 0, zone: "bathroom" },
  ];
  return createRoomDraft(cells, 8, 12);
}

function legacyDisconnectedBathroomDraft() {
  const cells: Cell[] = [
    { x: 0, y: 0, zone: "bedroom" },
    { x: 3, y: 3, zone: "bathroom" },
  ];
  return createRoomDraft(cells, 8, 12);
}

function diningDraftWithServiceRoute() {
  let draft = paintSpaceRectangle(
    createSpaceDraft("all-day-dining", 12, 12),
    { x: 0, y: 0, width: 12, height: 12 },
    "zone:service-route",
  );
  draft = placeSpaceItem(draft, {
    id: "table:1",
    catalogItemId: "item:dining-table",
    x: 2,
    y: 6,
    width: 1,
    height: 1,
    rotation: 0,
  });
  return placeSpaceItem(draft, {
    id: "table:2",
    catalogItemId: "item:dining-table",
    x: 7,
    y: 8,
    width: 1,
    height: 1,
    rotation: 0,
  });
}

describe("shared space editor compatibility", () => {
  it("edits arbitrary zone IDs without weakening room validation", () => {
    const lobby = createSpaceDraft("sky-lobby", 40, 30);
    const next = paintSpaceRectangle(
      lobby,
      { x: 2, y: 2, width: 8, height: 5 },
      "reception",
    );

    expect(zoneAt(next, 2, 2)).toBe("reception");
    expect(validateRoomDraft(legacyValidRoomDraft()).ok).toBe(true);
    expect(validateRoomDraft(legacyDisconnectedBathroomDraft())).toEqual({
      ok: false,
      reason: "房间轮廓必须连续",
    });
  });

  it("snaps, aligns and preserves a connected service route", () => {
    const draft = diningDraftWithServiceRoute();
    const aligned = alignPlacedItems(
      snapPlacedItem(draft, "table:1", { x: 4, y: 6 }),
      ["table:1", "table:2"],
      "left",
    );

    expect(aligned.items.find((item) => item.id === "table:2")?.x).toBe(4);
    expect(validateSpaceConnectivity(aligned).serviceRouteConnected).toBe(true);
  });
});

describe("shared space editor boundaries", () => {
  it.each([
    [0, 1], [-1, 1], [1.5, 1], [Number.NaN, 1], [1, 0], [1, Infinity],
  ])("rejects invalid grid dimensions (%s, %s)", (columns, rows) => {
    expect(() => createSpaceDraft("gym", columns, rows)).toThrow(
      "空间网格尺寸必须是正安全整数",
    );
  });

  it("paints and erases individual cells with independent selection data", () => {
    const original = createSpaceDraft("gym", 8, 8);
    const painted = paintSpaceCell(original, { x: 2, y: 3, zoneId: "zone:fitness" });
    const selection = [{ x: 2, y: 3 }, { x: 4, y: 5 }];
    const bounds = spaceSelectionBounds(selection);
    selection[0].x = 99;

    expect(original.cells).toEqual([]);
    expect(bounds).toEqual({ x: 2, y: 3, width: 3, height: 3 });
    expect(eraseSpaceCell(painted, 2, 3).cells).toEqual([]);
    expect(() => paintSpaceCell(original, { x: 0, y: 0, zoneId: "" })).toThrow(
      "分区编号不能为空",
    );
  });

  it("rejects invalid rectangles, coordinates, and the first cell beyond the cap", () => {
    const draft = createSpaceDraft("gym", SPACE_EDITOR_MAX_CELLS + 1, 1);
    expect(() => paintSpaceCell(draft, { x: -1, y: 0, zoneId: "zone:fitness" })).toThrow(
      "空间坐标超出网格边界",
    );
    expect(() => paintSpaceRectangle(draft, { x: 0, y: 0, width: 1.5, height: 1 }, "zone:fitness")).toThrow(
      "矩形参数必须是有限整数且宽高不能为负数",
    );
    const full = paintSpaceRectangle(
      draft,
      { x: 0, y: 0, width: SPACE_EDITOR_MAX_CELLS, height: 1 },
      "zone:fitness",
    );
    expect(full.cells).toHaveLength(SPACE_EDITOR_MAX_CELLS);
    expect(() => paintSpaceCell(full, {
      x: SPACE_EDITOR_MAX_CELLS, y: 0, zoneId: "zone:fitness",
    })).toThrow("空间单元数量超过上限");
  });

  it("rejects duplicate opening edges and removes openings with erased cells", () => {
    const draft = paintSpaceRectangle(
      createSpaceDraft("sky-lobby", 2, 2),
      { x: 0, y: 0, width: 2, height: 2 },
      "zone:arrival",
    );
    const walled = addSpaceWall(draft, { x: 0, y: 0, side: "north" });
    expect(() => addSpaceWindow(walled, { x: 0, y: 0, side: "north" })).toThrow(
      "这条边已有其他开口",
    );
    expect(eraseSpaceCell(walled, 0, 0).walls).toEqual([]);
    expect(() => addSpaceDoor(draft, { x: 0, y: 0, side: "east" })).toThrow(
      "开口必须位于空间边界",
    );
  });

  it("places and rotates bounded, non-colliding items", () => {
    const draft = createSpaceDraft("gym", 8, 8);
    const first = placeSpaceItem(draft, {
      id: "station:1", catalogItemId: "item:fitness-station",
      x: 1, y: 1, width: 2, height: 1, rotation: 0,
    });
    const rotated = rotatePlacedItem(first, "station:1", 90);
    expect(rotated.items[0]).toMatchObject({ width: 1, height: 2, rotation: 90 });
    expect(first.items[0]).toMatchObject({ width: 2, height: 1, rotation: 0 });
    expect(() => placeSpaceItem(first, {
      id: "station:1", catalogItemId: "item:fitness-station",
      x: 4, y: 4, width: 1, height: 1, rotation: 0,
    })).toThrow("物件编号不能重复");
    expect(() => placeSpaceItem(first, {
      id: "station:2", catalogItemId: "item:fitness-station",
      x: 2, y: 1, width: 1, height: 1, rotation: 0,
    })).toThrow("物件不能互相重叠");
    expect(() => placeSpaceItem(draft, {
      id: "station:2", catalogItemId: "item:fitness-station",
      x: 7, y: 7, width: 2, height: 1, rotation: 0,
    })).toThrow("物件超出空间边界");
  });

  it("rejects an alignment that would create an item collision", () => {
    let draft = createSpaceDraft("gym", 8, 8);
    draft = placeSpaceItem(draft, {
      id: "station:1", catalogItemId: "item:fitness-station",
      x: 1, y: 1, width: 1, height: 1, rotation: 0,
    });
    draft = placeSpaceItem(draft, {
      id: "station:2", catalogItemId: "item:fitness-station",
      x: 2, y: 1, width: 1, height: 1, rotation: 0,
    });

    expect(() => alignPlacedItems(draft, ["station:1", "station:2"], "left")).toThrow(
      "物件不能互相重叠",
    );
    expect(draft.items.map(({ x }) => x)).toEqual([1, 2]);
  });

  it("rejects invalid item geometry and the first item beyond the cap", () => {
    const invalid = {
      id: "station:bad", catalogItemId: "item:fitness-station",
      x: 0, y: 0, width: 1, height: 1, rotation: 45,
    };
    expect(() => placeSpaceItem(createSpaceDraft("gym", 8, 8), invalid as never)).toThrow(
      "物件 rotation 必须是 0、90、180 或 270",
    );
    expect(() => placeSpaceItem(createSpaceDraft("gym", 8, 8), {
      id: "", catalogItemId: "item:fitness-station",
      x: 0, y: 0, width: 1, height: 1, rotation: 0,
    })).toThrow("物件编号不能为空");
    expect(() => placeSpaceItem(createSpaceDraft("gym", 8, 8), {
      id: "station:bad", catalogItemId: "",
      x: 0, y: 0, width: 1, height: 1, rotation: 0,
    })).toThrow("物件目录引用不能为空");
    let draft = createSpaceDraft("gym", SPACE_EDITOR_MAX_ITEMS, 1);
    for (let index = 0; index < SPACE_EDITOR_MAX_ITEMS; index += 1) {
      draft = placeSpaceItem(draft, {
        id: `station:${index}`, catalogItemId: "item:fitness-station",
        x: index, y: 0, width: 1, height: 1, rotation: 0,
      });
    }
    expect(() => placeSpaceItem(draft, {
      id: "station:overflow", catalogItemId: "item:fitness-station",
      x: 0, y: 0, width: 1, height: 1, rotation: 0,
    })).toThrow("空间物件数量超过上限");
  });

  it("reports disconnected footprints, zones, and service routes", () => {
    let draft = createSpaceDraft("all-day-dining", 8, 8);
    for (const cell of [
      { x: 0, y: 0, zoneId: "zone:service-route" },
      { x: 1, y: 0, zoneId: "zone:seating" },
      { x: 7, y: 7, zoneId: "zone:service-route" },
    ]) draft = paintSpaceCell(draft, cell);

    expect(validateSpaceConnectivity(draft)).toMatchObject({
      connected: false,
      serviceRouteConnected: false,
      zoneConnectivity: { "zone:service-route": false, "zone:seating": true },
    });
    expect(validateSpaceDraft(draft)).toEqual({
      ok: false,
      reasons: ["空间轮廓必须连续", "分区 zone:service-route 必须连续", "服务路线必须连续"],
    });
  });

  it("collects bounds, collision, duplicate ID, and opening errors from imported drafts", () => {
    const draft = paintSpaceRectangle(
      createSpaceDraft("gym", 2, 2),
      { x: 0, y: 0, width: 2, height: 2 },
      "zone:fitness",
    );
    const malformed = {
      ...draft,
      cells: [...draft.cells, { x: 2, y: 0, zoneId: "zone:fitness" }],
      items: [
        { id: "station:1", catalogItemId: "item:fitness-station", x: 0, y: 0, width: 2, height: 1, rotation: 0 as const },
        { id: "station:1", catalogItemId: "item:fitness-station", x: 1, y: 0, width: 2, height: 1, rotation: 0 as const },
      ],
      walls: [{ x: 0, y: 0, side: "north" as const }],
      doors: [
        { x: 0, y: 0, side: "north" as const },
        { x: 0, y: 0, side: "east" as const },
      ],
    };

    expect(validateSpaceDraft(malformed)).toEqual({
      ok: false,
      reasons: [
        "空间坐标超出网格边界",
        "物件编号不能重复",
        "物件超出空间边界",
        "物件不能互相重叠",
        "同一空间边只能设置一个开口",
        "开口必须位于空间边界",
      ],
    });
  });

  it("reports an invalid imported opening side instead of throwing", () => {
    const draft = paintSpaceCell(createSpaceDraft("gym", 2, 2), {
      x: 0, y: 0, zoneId: "zone:fitness",
    });
    const malformed = {
      ...draft,
      doors: [{ x: 0, y: 0, side: "diagonal" as never }],
    };
    expect(validateSpaceDraft(malformed)).toEqual({
      ok: false,
      reasons: ["开口方向无效", "开口必须位于空间边界"],
    });
  });

  it("bounds history, clears redo on commit, and safely handles empty undo/redo", () => {
    const initial = createSpaceDraft("gym", SPACE_EDITOR_HISTORY_LIMIT + 2, 1);
    let history = createSpaceHistory(initial);
    expect(undoSpaceEdit(history)).toBe(history);
    expect(redoSpaceEdit(history)).toBe(history);
    for (let index = 0; index < SPACE_EDITOR_HISTORY_LIMIT + 2; index += 1) {
      history = commitSpaceEdit(history, paintSpaceCell(history.present, {
        x: index, y: 0, zoneId: "zone:fitness",
      }));
    }
    expect(history.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    const undone = undoSpaceEdit(history);
    const branched = commitSpaceEdit(undone, eraseSpaceCell(undone.present, 0, 0));
    expect(branched.future).toEqual([]);
    branched.present.cells[0].zoneId = "mutated";
    expect(branched.past[branched.past.length - 1]?.cells[0]?.zoneId).not.toBe("mutated");
  });
});
