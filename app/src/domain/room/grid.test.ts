import { describe, expect, it } from "vitest";

import type { Cell } from "../game/state";
import {
  addCell,
  createRectangle,
  eraseCell,
  validateRoomCells,
} from "./grid";

describe("createRectangle", () => {
  it("creates cells ordered by row then column", () => {
    expect(createRectangle(2, 3, 2, 2, "bedroom")).toEqual([
      { x: 2, y: 3, zone: "bedroom" },
      { x: 3, y: 3, zone: "bedroom" },
      { x: 2, y: 4, zone: "bedroom" },
      { x: 3, y: 4, zone: "bedroom" },
    ]);
    expect(createRectangle(0, 0, 0, 2, "bedroom")).toEqual([]);
  });
});

describe("cell editing", () => {
  it("adds, replaces, and erases cells without mutating the input", () => {
    const empty: Cell[] = [];
    const bedroom = addCell(empty, { x: 0, y: 0, zone: "bedroom" });
    const duplicate = addCell(bedroom, {
      x: 0,
      y: 0,
      zone: "bedroom",
    });
    const replaced = addCell(duplicate, {
      x: 0,
      y: 0,
      zone: "bathroom",
    });
    const sorted = addCell(
      [{ x: 1, y: 1, zone: "bedroom" }],
      { x: 0, y: 0, zone: "bathroom" },
    );

    expect(empty).toEqual([]);
    expect(duplicate).toHaveLength(1);
    expect(replaced).toEqual([{ x: 0, y: 0, zone: "bathroom" }]);
    expect(sorted).toEqual([
      { x: 0, y: 0, zone: "bathroom" },
      { x: 1, y: 1, zone: "bedroom" },
    ]);
    expect(eraseCell(replaced, 0, 0)).toEqual([]);
    expect(eraseCell([], 0, 0)).toEqual([]);
    expect(replaced).toEqual([{ x: 0, y: 0, zone: "bathroom" }]);
  });
});

describe("validateRoomCells", () => {
  it("accepts a continuous bedroom and bathroom room", () => {
    const bedroom = createRectangle(0, 0, 8, 8, "bedroom");
    const bathroom = createRectangle(0, 8, 8, 4, "bathroom");

    expect(validateRoomCells([...bedroom, ...bathroom], 8, 12)).toEqual({
      ok: true,
      areaSquareMeters: 24,
    });
  });

  it("rejects disconnected room cells", () => {
    expect(
      validateRoomCells(
        [
          { x: 0, y: 0, zone: "bedroom" },
          { x: 7, y: 11, zone: "bathroom" },
        ],
        8,
        12,
      ),
    ).toEqual({ ok: false, reason: "房间轮廓必须连续" });
  });

  it("requires both prototype room zones", () => {
    expect(
      validateRoomCells([{ x: 0, y: 0, zone: "bedroom" }], 8, 12),
    ).toEqual({ ok: false, reason: "原型房型需要卧室和卫浴" });
  });

  it("rejects empty and out-of-bounds rooms", () => {
    expect(validateRoomCells([], 8, 12)).toEqual({
      ok: false,
      reason: "房间不能为空",
    });
    expect(
      validateRoomCells(
        [
          { x: -1, y: 0, zone: "bedroom" },
          { x: 0, y: 0, zone: "bathroom" },
        ],
        8,
        12,
      ),
    ).toEqual({ ok: false, reason: "房间超出网格边界" });
  });

  it("uses the last zone and counts duplicate coordinates once", () => {
    expect(
      validateRoomCells(
        [
          { x: 0, y: 0, zone: "bathroom" },
          { x: 0, y: 0, zone: "bedroom" },
          { x: 1, y: 0, zone: "bathroom" },
        ],
        8,
        12,
      ),
    ).toEqual({ ok: true, areaSquareMeters: 0.5 });
  });
});
