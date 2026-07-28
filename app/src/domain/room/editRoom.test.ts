import { describe, expect, it } from "vitest";

import type { Cell } from "../game/state";
import {
  addDoor,
  addWall,
  addWindow,
  createRoomDraft,
  createRoomHistory,
  eraseRoomCell,
  paintRoomCell,
  redoRoomEdit,
  roomDraftToSpaceDraft,
  selectionBounds,
  spaceDraftToRoomDraft,
  undoRoomEdit,
  validateRoomDraft,
} from "./editRoom";
import {
  mirrorRoom,
  resizeRoom,
  rotateRoom,
} from "./transformRoom";
import { SPACE_EDITOR_HISTORY_LIMIT } from "../spaces/spaceTypes";

const cells: Cell[] = [
  { x: 0, y: 0, zone: "bedroom" },
  { x: 1, y: 0, zone: "bedroom" },
  { x: 0, y: 1, zone: "bathroom" },
  { x: 1, y: 1, zone: "bathroom" },
];

function markedRoomDraft(marker: number) {
  return createRoomDraft(cells, marker + 1, 1);
}

function poisonRoomDraft(message: string) {
  const draft = createRoomDraft(cells, 1, 1);
  Object.defineProperty(draft.cells, "map", {
    value: () => { throw new Error(message); },
  });
  return draft;
}

describe("room editing primitives", () => {
  it("round-trips through the neutral editor with deep-independent zone adapters", () => {
    const room = createRoomDraft(cells, 8, 12);
    const space = roomDraftToSpaceDraft(room);
    const restored = spaceDraftToRoomDraft(space);

    expect(space.cells[0]).toEqual({ x: 0, y: 0, zoneId: "bedroom" });
    expect(restored).toEqual(room);
    space.cells[0].zoneId = "mutated";
    space.doors.push({ x: 0, y: 0, side: "north" });
    expect(room.cells[0]).toEqual({ x: 0, y: 0, zone: "bedroom" });
    expect(room.doors).toEqual([]);
    expect(restored.cells[0]).toEqual({ x: 0, y: 0, zone: "bedroom" });
  });

  it("rejects neutral zones that are not valid legacy room zones", () => {
    const space = roomDraftToSpaceDraft(createRoomDraft(cells, 8, 12));
    space.cells[0].zoneId = "zone:arrival";

    expect(() => spaceDraftToRoomDraft(space)).toThrow(
      "客房分区必须是卧室或卫浴",
    );
  });

  it("paints and erases immutably, and reports selection bounds", () => {
    const draft = createRoomDraft(cells, 8, 12);
    const painted = paintRoomCell(draft, { x: 2, y: 1, zone: "bedroom" });
    const erased = eraseRoomCell(painted, 0, 1);

    expect(draft.cells).toHaveLength(4);
    expect(painted.cells).toContainEqual({ x: 2, y: 1, zone: "bedroom" });
    expect(erased.cells).not.toContainEqual({ x: 0, y: 1, zone: "bathroom" });
    expect(selectionBounds(painted, [{ x: 0, y: 0 }, { x: 2, y: 1 }])).toEqual({
      x: 0,
      y: 0,
      width: 3,
      height: 2,
    });
  });

  it("keeps walls and openings immutable and validates boundary openings", () => {
    const draft = createRoomDraft(cells, 8, 12);
    const edited = addWindow(
      addDoor(
        addWall(draft, { x: 0, y: 0, side: "north" }),
        { x: 0, y: 0, side: "west" },
      ),
      { x: 1, y: 1, side: "east" },
    );
    expect(edited.walls).toHaveLength(1);
    expect(edited.doors).toHaveLength(1);
    expect(validateRoomDraft(edited).ok).toBe(true);
    expect(() => addDoor(draft, { x: 0, y: 0, side: "east" })).toThrow(
      "开口必须位于房间边界",
    );
  });

  it("rejects an edge already occupied by another opening kind", () => {
    const draft = addWall(createRoomDraft(cells, 8, 12), {
      x: 0,
      y: 0,
      side: "north",
    });

    expect(() =>
      addDoor(draft, { x: 0, y: 0, side: "north" }),
    ).toThrow("这条边已有其他开口");
    expect(() =>
      addWindow(draft, { x: 0, y: 0, side: "north" }),
    ).toThrow("这条边已有其他开口");
  });

  it.each([
    {
      label: "the same kind",
      openings: {
        walls: [],
        doors: [
          { x: 0, y: 0, side: "north" as const },
          { x: 0, y: 0, side: "north" as const },
        ],
        windows: [],
      },
    },
    {
      label: "different kinds",
      openings: {
        walls: [{ x: 0, y: 0, side: "north" as const }],
        doors: [{ x: 0, y: 0, side: "north" as const }],
        windows: [],
      },
    },
  ])("rejects duplicate opening edges across $label", ({ openings }) => {
    const draft = { ...createRoomDraft(cells, 8, 12), ...openings };

    expect(validateRoomDraft(draft)).toEqual({
      ok: false,
      reason: "同一房间边只能设置一个开口",
    });
  });

  it("rejects disconnected required zones", () => {
    const draft = createRoomDraft(
      [
        { x: 0, y: 0, zone: "bedroom" },
        { x: 3, y: 3, zone: "bathroom" },
      ],
      8,
      12,
    );
    expect(validateRoomDraft(draft)).toEqual({
      ok: false,
      reason: "房间轮廓必须连续",
    });
  });

  it("supports immutable undo and redo", () => {
    const initial = createRoomDraft(cells, 8, 12);
    const first = paintRoomCell(initial, { x: 2, y: 1, zone: "bedroom" });
    const second = paintRoomCell(first, { x: 3, y: 1, zone: "bedroom" });
    const history = createRoomHistory(initial, [first, second]);
    expect(undoRoomEdit(history).present.cells).toHaveLength(5);
    expect(redoRoomEdit(undoRoomEdit(history)).present.cells).toHaveLength(6);
  });

  it("returns deep-independent room histories for empty undo and redo", () => {
    const history = createRoomHistory(createRoomDraft(cells, 8, 12));
    const undone = undoRoomEdit(history);
    const redone = redoRoomEdit(history);
    expect(undone).not.toBe(history);
    expect(redone).not.toBe(history);
    undone.present.cells[0].zone = "bathroom";
    redone.present.doors.push({ x: 0, y: 0, side: "north" });
    expect(history.present.cells[0].zone).toBe("bedroom");
    expect(history.present.doors).toEqual([]);
  });

  it("slices imported room history in undo directions before adapting snapshots", () => {
    const past = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedRoomDraft(index));
    const future = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedRoomDraft(300 + index));
    past[0] = poisonRoomDraft("discarded room undo past was adapted");
    future[SPACE_EDITOR_HISTORY_LIMIT - 1] = poisonRoomDraft(
      "discarded room undo future was adapted",
    );

    const undone = undoRoomEdit({ past, present: markedRoomDraft(200), future });

    expect(undone.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(undone.present.columns).toBe(102);
    expect(undone.future).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
  });

  it("slices imported room history in redo directions before adapting snapshots", () => {
    const past = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedRoomDraft(index));
    const future = Array.from({ length: SPACE_EDITOR_HISTORY_LIMIT + 2 }, (_, index) =>
      markedRoomDraft(300 + index));
    past[0] = poisonRoomDraft("discarded room redo past was adapted");
    future[SPACE_EDITOR_HISTORY_LIMIT + 1] = poisonRoomDraft(
      "discarded room redo future was adapted",
    );

    const redone = redoRoomEdit({ past, present: markedRoomDraft(200), future });

    expect(redone.past).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
    expect(redone.present.columns).toBe(301);
    expect(redone.future).toHaveLength(SPACE_EDITOR_HISTORY_LIMIT);
  });
});

describe("room transforms", () => {
  it.each([90, 180, 270] as const)("rotates %s degrees and remaps openings", (degrees) => {
    const draft = addDoor(
      createRoomDraft(cells, 8, 12),
      { x: 0, y: 0, side: "west" },
    );
    const rotated = rotateRoom(draft, degrees);
    expect(rotated.cells).toHaveLength(4);
    expect(validateRoomDraft(rotated).ok).toBe(true);
    expect(rotated.doors).toHaveLength(1);
  });

  it("mirrors cells and swaps east/west sides", () => {
    const draft = addWindow(createRoomDraft(cells, 8, 12), {
      x: 0,
      y: 0,
      side: "west",
    });
    const mirrored = mirrorRoom(draft, "horizontal");
    expect(mirrored.cells[0]).toEqual({ x: 0, y: 0, zone: "bedroom" });
    expect(mirrored.windows[0].side).toBe("east");
  });

  it("normalizes mirrored non-origin coordinates to the room footprint", () => {
    const draft = createRoomDraft([
      { x: 3, y: 2, zone: "bedroom" },
      { x: 4, y: 2, zone: "bedroom" },
      { x: 5, y: 2, zone: "bathroom" },
    ], 8, 12);
    const mirrored = mirrorRoom(draft, "horizontal");
    expect(mirrored.cells.map(({ x, y }) => [x, y])).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  it("normalizes rotated non-origin cells and openings using their bounding box", () => {
    const draft = {
      ...createRoomDraft([
        { x: 3, y: 4, zone: "bedroom" },
        { x: 4, y: 4, zone: "bedroom" },
        { x: 3, y: 5, zone: "bathroom" },
        { x: 4, y: 5, zone: "bathroom" },
      ], 8, 12),
      doors: [{ x: 3, y: 4, side: "west" as const }],
    };

    const rotated = rotateRoom(draft, 90);

    expect(rotated.cells.map(({ x, y }) => [x, y])).toEqual([
      [0, 0], [1, 0], [0, 1], [1, 1],
    ]);
    expect(rotated.doors).toEqual([{ x: 1, y: 0, side: "north" }]);
    expect(validateRoomDraft(rotated).ok).toBe(true);
  });

  it("normalizes both axes and openings when mirroring non-origin rooms", () => {
    const draft = {
      ...createRoomDraft([
        { x: 3, y: 4, zone: "bedroom" },
        { x: 4, y: 4, zone: "bedroom" },
        { x: 3, y: 5, zone: "bathroom" },
        { x: 4, y: 5, zone: "bathroom" },
      ], 8, 12),
      windows: [{ x: 3, y: 4, side: "west" as const }],
    };

    const mirrored = mirrorRoom(draft, "horizontal");

    expect(mirrored.cells.map(({ x, y }) => [x, y])).toEqual([
      [0, 0], [1, 0], [0, 1], [1, 1],
    ]);
    expect(mirrored.windows).toEqual([{ x: 1, y: 0, side: "east" }]);
    expect(validateRoomDraft(mirrored).ok).toBe(true);
  });

  it("resizes a non-origin footprint without treating its offset as room size", () => {
    const draft = {
      ...createRoomDraft([
        { x: 3, y: 4, zone: "bedroom" },
        { x: 4, y: 4, zone: "bedroom" },
        { x: 3, y: 5, zone: "bathroom" },
        { x: 4, y: 5, zone: "bathroom" },
      ], 8, 12),
      doors: [{ x: 3, y: 5, side: "south" as const }],
    };

    const resized = resizeRoom(draft, { width: 3, height: 2 });

    expect(resized.cells).toHaveLength(6);
    expect(resized.cells.every(({ x, y }) => x >= 0 && x < 3 && y >= 0 && y < 2)).toBe(true);
    expect(resized.doors).toEqual([{ x: 0, y: 1, side: "south" }]);
    expect(validateRoomDraft(resized).ok).toBe(true);
  });

  it("resizes only within the grid and preserves a valid footprint", () => {
    const draft = createRoomDraft(cells, 8, 12);
    const resized = resizeRoom(draft, { width: 3, height: 2 });
    expect(resized.cells).toHaveLength(6);
    expect(() => resizeRoom(draft, { width: 1, height: 1 })).toThrow(
      "缩放会裁剪房间",
    );
  });

  it("moves boundary openings with a resized footprint", () => {
    const draft = addDoor(
      addWindow(createRoomDraft(cells, 8, 12), {
        x: 1,
        y: 0,
        side: "east",
      }),
      { x: 0, y: 1, side: "south" },
    );

    const resized = resizeRoom(draft, { width: 3, height: 3 });

    expect(resized.windows).toEqual([{ x: 2, y: 0, side: "east" }]);
    expect(resized.doors).toEqual([{ x: 0, y: 2, side: "south" }]);
    expect(validateRoomDraft(resized).ok).toBe(true);
  });
});
