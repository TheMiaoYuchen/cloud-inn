import { describe, expect, it } from "vitest";

import type { Cell } from "../game/state";
import { createRoomDraft, validateRoomDraft } from "../room/editRoom";
import {
  addSpaceDoor,
  addSpaceOpening,
  addSpaceWall,
  addSpaceWindow,
  alignPlacedItems,
  commitSpaceEdit,
  createSpaceDraft,
  createSpaceRectangleCells,
  createSpaceHistory,
  eraseSpaceCell,
  paintSpaceRectangle,
  paintSpaceCell,
  placeSpaceItem,
  redoSpaceEdit,
  removeSpaceCellAt,
  replaceSpaceCell,
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
  SPACE_EDITOR_MAX_OPENINGS,
  type SpaceDraft,
  type SpaceHistory,
} from "./spaceTypes";

function markedSpaceDraft(marker: number): SpaceDraft {
  return createSpaceDraft("gym", marker + 1, 1);
}

function poisonSpaceDraft(message: string): SpaceDraft {
  const draft = createSpaceDraft("gym", 1, 1);
  Object.defineProperty(draft.cells, "map", {
    value: () => { throw new Error(message); },
  });
  return draft;
}

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
  it("provides neutral geometry kernels for legacy adapters", () => {
    const rectangle = createSpaceRectangleCells(
      { x: 1, y: 2, width: 2, height: 2 },
      "legacy-zone",
    );
    const replaced = replaceSpaceCell(rectangle, {
      x: 1, y: 2, zoneId: "replacement",
    });
    expect(replaced).toContainEqual({ x: 1, y: 2, zoneId: "replacement" });
    expect(removeSpaceCellAt(replaced, 1, 2)).not.toContainEqual(
      expect.objectContaining({ x: 1, y: 2 }),
    );

    const draft = paintSpaceRectangle(
      createSpaceDraft("sky-lobby", 2, 2),
      { x: 0, y: 0, width: 2, height: 2 },
      "zone:arrival",
    );
    expect(addSpaceOpening(draft, { x: 0, y: 0, side: "north" }, "doors").doors)
      .toEqual([{ x: 0, y: 0, side: "north" }]);
  });

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
    expect(() => createSpaceRectangleCells({
      x: Number.MAX_SAFE_INTEGER,
      y: 0,
      width: 2,
      height: 0,
    }, "zone:fitness")).toThrow("矩形范围超出安全整数边界");
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

  it("repaints a full 4,096-cell rectangle in one bounded immutable batch", () => {
    const original = {
      ...createSpaceDraft("gym", SPACE_EDITOR_MAX_CELLS, 1),
      cells: createSpaceRectangleCells(
        { x: 0, y: 0, width: SPACE_EDITOR_MAX_CELLS, height: 1 },
        "zone:fitness",
      ),
    };
    const startedAt = performance.now();

    const repainted = paintSpaceRectangle(
      original,
      { x: 0, y: 0, width: SPACE_EDITOR_MAX_CELLS, height: 1 },
      "zone:quiet",
    );

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(repainted.cells).toHaveLength(SPACE_EDITOR_MAX_CELLS);
    expect(repainted.cells.every(({ zoneId }) => zoneId === "zone:quiet")).toBe(true);
    expect(original.cells.every(({ zoneId }) => zoneId === "zone:fitness")).toBe(true);
    repainted.cells[0].zoneId = "mutated";
    expect(original.cells[0].zoneId).toBe("zone:fitness");
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

  it("treats an absent service route as disconnected", () => {
    const draft = paintSpaceRectangle(
      createSpaceDraft("all-day-dining", 4, 4),
      { x: 0, y: 0, width: 4, height: 4 },
      "zone:seating",
    );
    expect(validateSpaceConnectivity(draft).serviceRouteConnected).toBe(false);
  });

  it("treats placed-item footprints as blocked service-route cells", () => {
    let draft = paintSpaceRectangle(
      createSpaceDraft("all-day-dining", 5, 1),
      { x: 0, y: 0, width: 5, height: 1 },
      "zone:service-route",
    );
    draft = placeSpaceItem(draft, {
      id: "table:blocker", catalogItemId: "item:dining-table",
      x: 2, y: 0, width: 1, height: 1, rotation: 0,
    });
    expect(validateSpaceConnectivity(draft).serviceRouteConnected).toBe(false);
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

  it("bounds imported and newly added openings", () => {
    const draft = paintSpaceCell(createSpaceDraft("gym", 2, 2), {
      x: 0, y: 0, zoneId: "zone:fitness",
    });
    const openings = Array.from(
      { length: SPACE_EDITOR_MAX_OPENINGS + 1 },
      () => ({ x: 0, y: 0, side: "north" as const }),
    );
    expect(validateSpaceDraft({ ...draft, walls: openings })).toEqual(expect.objectContaining({
      ok: false,
      reasons: expect.arrayContaining(["空间开口数量超过上限"]),
    }));
    expect(() => addSpaceOpening(
      { ...draft, walls: openings.slice(0, SPACE_EDITOR_MAX_OPENINGS) },
      { x: 0, y: 0, side: "west" },
      "doors",
    )).toThrow("空间开口数量超过上限");
  });

  it("reports oversized imported openings without reading the first discarded entry", () => {
    const draft = paintSpaceCell(createSpaceDraft("gym", 2, 2), {
      x: 0, y: 0, zoneId: "zone:fitness",
    });
    const walls = Array.from(
      { length: SPACE_EDITOR_MAX_OPENINGS + 1 },
      () => ({ x: 0, y: 0, side: "north" as const }),
    );
    Object.defineProperty(walls, SPACE_EDITOR_MAX_OPENINGS, {
      get: () => { throw new Error("discarded opening was read"); },
    });

    expect(validateSpaceDraft({ ...draft, walls })).toEqual(expect.objectContaining({
      ok: false,
      reasons: expect.arrayContaining(["空间开口数量超过上限"]),
    }));
  });

  it.each([
    ["cell zone", (draft: any) => { draft.cells[0].zoneId = null; }, "分区编号必须是字符串"],
    ["item id", (draft: any) => { draft.items[0].id = {}; }, "物件编号必须是字符串"],
    ["item catalog id", (draft: any) => { draft.items[0].catalogItemId = 7; }, "物件目录引用必须是字符串"],
    ["space type", (draft: any) => { draft.type = null; }, "公共空间类型无效"],
    ["opening side", (draft: any) => { draft.doors = [{ x: 0, y: 0, side: {} }]; }, "开口方向无效"],
  ])("returns a deterministic diagnostic for malformed runtime %s", (_label, mutate, reason) => {
    const draft: any = paintSpaceCell(createSpaceDraft("gym", 2, 2), {
      x: 0, y: 0, zoneId: "zone:fitness",
    });
    draft.items = [{
      id: "station:1", catalogItemId: "item:fitness-station",
      x: 0, y: 0, width: 1, height: 1, rotation: 0,
    }];
    mutate(draft);

    expect(validateSpaceDraft(draft)).toEqual(expect.objectContaining({
      ok: false,
      reasons: expect.arrayContaining([reason]),
    }));
  });

  it("bounds history, clears redo on commit, and safely handles empty undo/redo", () => {
    const initial = createSpaceDraft("gym", SPACE_EDITOR_HISTORY_LIMIT + 2, 1);
    let history = createSpaceHistory(initial);
    const emptyUndo = undoSpaceEdit(history);
    const emptyRedo = redoSpaceEdit(history);
    expect(emptyUndo).not.toBe(history);
    expect(emptyRedo).not.toBe(history);
    emptyUndo.present.cells.push({ x: 0, y: 0, zoneId: "mutated" });
    emptyRedo.present.doors.push({ x: 0, y: 0, side: "north" });
    expect(history.present.cells).toEqual([]);
    expect(history.present.doors).toEqual([]);
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

  it.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid history limit %s",
    (limit) => {
      expect(() => createSpaceHistory(createSpaceDraft("gym", 2, 2), [], limit)).toThrow(
        "历史上限必须是 1-100 的安全整数",
      );
    },
  );

  it("slices history to its bound before cloning discarded snapshots", () => {
    const initial = createSpaceDraft("gym", 2, 2);
    const discarded = createSpaceDraft("gym", 2, 2);
    Object.defineProperty(discarded.cells, "map", {
      value: () => { throw new Error("discarded snapshot was cloned"); },
    });
    const retained = Array.from(
      { length: SPACE_EDITOR_HISTORY_LIMIT + 1 },
      () => createSpaceDraft("gym", 2, 2),
    );
    expect(() => createSpaceHistory(initial, [discarded, ...retained])).not.toThrow();
  });

  it("bounds imported commit history before cloning its retained past", () => {
    const past = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedSpaceDraft(index));
    past[0] = poisonSpaceDraft("discarded commit past was cloned");

    const committed = commitSpaceEdit({
      past,
      present: markedSpaceDraft(200),
      future: [poisonSpaceDraft("cleared commit future was cloned")],
    }, markedSpaceDraft(300));

    expect(committed.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(committed.past[0].columns).toBe(4);
    expect(committed.past[committed.past.length - 1]?.columns).toBe(201);
    expect(committed.future).toEqual([]);
  });

  it("bounds both imported undo directions before cloning retained snapshots", () => {
    const past = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedSpaceDraft(index));
    const future = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedSpaceDraft(300 + index));
    past[0] = poisonSpaceDraft("discarded undo past was cloned");
    future[SPACE_EDITOR_HISTORY_LIMIT - 1] = poisonSpaceDraft(
      "discarded undo future was cloned",
    );

    const undone = undoSpaceEdit({ past, present: markedSpaceDraft(200), future });

    expect(undone.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(undone.past[0].columns).toBe(2);
    expect(undone.present.columns).toBe(102);
    expect(undone.future).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(undone.future[0].columns).toBe(201);
    expect(undone.future[undone.future.length - 1]?.columns).toBe(399);
  });

  it("bounds imported undo past before reading discarded prefix snapshots", () => {
    const past = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedSpaceDraft(index));
    Object.defineProperty(past, 0, {
      get: () => { throw new Error("discarded undo past prefix was read"); },
    });

    const undone = undoSpaceEdit({
      past,
      present: markedSpaceDraft(200),
      future: [],
    });

    expect(undone.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(undone.past[0].columns).toBe(2);
    expect(undone.present.columns).toBe(102);
  });

  it("returns a bounded deep clone when imported undo past is sparse", () => {
    const history: SpaceHistory = {
      past: new Array<SpaceDraft>(1),
      present: markedSpaceDraft(20),
      future: [markedSpaceDraft(30)],
    };

    const undone = undoSpaceEdit(history);

    expect(undone).not.toBe(history);
    undone.present.cells.push({ x: 0, y: 0, zoneId: "mutated" });
    undone.future[0].doors.push({ x: 0, y: 0, side: "north" });
    expect(history.present.cells).toEqual([]);
    expect(history.future[0].doors).toEqual([]);
  });

  it("bounds both imported redo directions before cloning retained snapshots", () => {
    const past = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedSpaceDraft(index));
    const future = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedSpaceDraft(300 + index));
    past[0] = poisonSpaceDraft("discarded redo past was cloned");
    future[SPACE_EDITOR_HISTORY_LIMIT + 1] = poisonSpaceDraft(
      "discarded redo future was cloned",
    );

    const redone = redoSpaceEdit({ past, present: markedSpaceDraft(200), future });

    expect(redone.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(redone.past[0].columns).toBe(4);
    expect(redone.past[redone.past.length - 1]?.columns).toBe(201);
    expect(redone.present.columns).toBe(301);
    expect(redone.future).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(redone.future[0].columns).toBe(302);
    expect(redone.future[redone.future.length - 1]?.columns).toBe(401);
  });

  it("bounds imported future before cloning an empty undo path", () => {
    const future = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 1 }, (_, index) =>
      markedSpaceDraft(index));
    future[SPACE_EDITOR_HISTORY_LIMIT] = poisonSpaceDraft(
      "discarded empty-undo future was cloned",
    );

    const undone = undoSpaceEdit({ past: [], present: markedSpaceDraft(200), future });

    expect(undone.future).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(undone.future[undone.future.length - 1]?.columns).toBe(SPACE_EDITOR_HISTORY_LIMIT);
  });

  it("bounds imported past before cloning an empty redo path", () => {
    const past = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 1 }, (_, index) =>
      markedSpaceDraft(index));
    past[0] = poisonSpaceDraft("discarded empty-redo past was cloned");

    const redone = redoSpaceEdit({ past, present: markedSpaceDraft(200), future: [] });

    expect(redone.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(redone.past[0].columns).toBe(2);
  });

  it("bounds selection input and rejects non-safe coordinates before calculating", () => {
    expect(() => spaceSelectionBounds([{ x: Number.NaN, y: 0 }])).toThrow(
      "选择坐标必须是安全整数",
    );
    expect(() => spaceSelectionBounds(Array.from(
      { length: SPACE_EDITOR_MAX_CELLS + 1 },
      (_, x) => ({ x, y: 0 }),
    ))).toThrow("选择单元数量超过上限");
  });

  it("rejects unknown runtime alignments", () => {
    const draft = diningDraftWithServiceRoute();
    expect(() => alignPlacedItems(
      draft,
      ["table:1", "table:2"],
      "diagonal" as never,
    )).toThrow("物件对齐方式无效");
  });
});
