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
  selectionBounds,
  undoRoomEdit,
  validateRoomDraft,
} from "./editRoom";
import {
  mirrorRoom,
  resizeRoom,
  rotateRoom,
} from "./transformRoom";

const cells: Cell[] = [
  { x: 0, y: 0, zone: "bedroom" },
  { x: 1, y: 0, zone: "bedroom" },
  { x: 0, y: 1, zone: "bathroom" },
  { x: 1, y: 1, zone: "bathroom" },
];

describe("room editing primitives", () => {
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

  it("resizes only within the grid and preserves a valid footprint", () => {
    const draft = createRoomDraft(cells, 8, 12);
    const resized = resizeRoom(draft, { width: 3, height: 2 });
    expect(resized.cells).toHaveLength(6);
    expect(() => resizeRoom(draft, { width: 1, height: 1 })).toThrow(
      "缩放会裁剪房间",
    );
  });
});
