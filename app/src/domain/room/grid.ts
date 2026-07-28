import { prototypeConfig } from "../config/prototypeConfig";
import type { Cell, ZoneKind } from "../game/state";
import {
  createSpaceRectangleCells,
  removeSpaceCellAt,
  replaceSpaceCell,
} from "../spaces/spaceEditor";

export type RoomValidation =
  | { ok: true; areaSquareMeters: number }
  | { ok: false; reason: string };

function isFiniteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value);
}

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

function compareCells(a: Cell, b: Cell): number {
  return a.y - b.y || a.x - b.x;
}

function normalizeCells(cells: Cell[]): Cell[] {
  return cells.reduce(
    (normalized, cell) => replaceSpaceCell(normalized, {
      x: cell.x,
      y: cell.y,
      zoneId: cell.zone,
    }),
    [] as Array<{ x: number; y: number; zoneId: string }>,
  ).map(({ x, y, zoneId }) => ({ x, y, zone: zoneId as ZoneKind })).sort(compareCells);
}

export function createRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
  zone: ZoneKind,
): Cell[] {
  if (
    !isFiniteInteger(x) ||
    !isFiniteInteger(y) ||
    !isFiniteInteger(width) ||
    !isFiniteInteger(height) ||
    width < 0 ||
    height < 0
  ) {
    throw new Error("矩形参数必须是有限整数，宽高不能为负数");
  }

  try {
    return createSpaceRectangleCells(
      { x, y, width, height },
      zone,
      Number.MAX_SAFE_INTEGER,
    )
      .map(({ x: cellX, y: cellY, zoneId }) => ({
        x: cellX,
        y: cellY,
        zone: zoneId as ZoneKind,
      }));
  } catch (error) {
    if (error instanceof Error && error.message === "矩形参数必须是有限整数且宽高不能为负数") {
      throw new Error("矩形参数必须是有限整数，宽高不能为负数");
    }
    throw error;
  }
}

export function addCell(cells: Cell[], cell: Cell): Cell[] {
  return normalizeCells([...cells, cell]);
}

export function eraseCell(cells: Cell[], x: number, y: number): Cell[] {
  return removeSpaceCellAt(
    normalizeCells(cells).map(({ x: cellX, y: cellY, zone }) => ({
      x: cellX,
      y: cellY,
      zoneId: zone,
    })),
    x,
    y,
  ).map(({ x: cellX, y: cellY, zoneId }) => ({
    x: cellX,
    y: cellY,
    zone: zoneId as ZoneKind,
  }));
}

export function validateRoomCells(
  cells: Cell[],
  columns: number,
  rows: number,
): RoomValidation {
  const normalizedCells = normalizeCells(cells);

  if (normalizedCells.length === 0) {
    return { ok: false, reason: "房间不能为空" };
  }

  if (
    !isFiniteInteger(columns) ||
    !isFiniteInteger(rows) ||
    columns <= 0 ||
    rows <= 0 ||
    normalizedCells.some(
      (cell) =>
        !isFiniteInteger(cell.x) ||
        !isFiniteInteger(cell.y) ||
        cell.x < 0 ||
        cell.y < 0 ||
        cell.x >= columns ||
        cell.y >= rows,
    )
  ) {
    return { ok: false, reason: "房间超出网格边界" };
  }

  const zones = new Set(normalizedCells.map((cell) => cell.zone));
  if (!zones.has("bedroom") || !zones.has("bathroom")) {
    return { ok: false, reason: "原型房型需要卧室和卫浴" };
  }

  const occupiedCoordinates = new Set(
    normalizedCells.map((cell) => coordinateKey(cell.x, cell.y)),
  );
  const visitedCoordinates = new Set<string>();
  const pendingCells = [normalizedCells[0]];

  while (pendingCells.length > 0) {
    const cell = pendingCells.pop();
    if (!cell) {
      continue;
    }

    const key = coordinateKey(cell.x, cell.y);
    if (visitedCoordinates.has(key)) {
      continue;
    }

    visitedCoordinates.add(key);
    for (const [x, y] of [
      [cell.x - 1, cell.y],
      [cell.x + 1, cell.y],
      [cell.x, cell.y - 1],
      [cell.x, cell.y + 1],
    ]) {
      const neighborKey = coordinateKey(x, y);
      if (
        occupiedCoordinates.has(neighborKey) &&
        !visitedCoordinates.has(neighborKey)
      ) {
        pendingCells.push({ x, y, zone: cell.zone });
      }
    }
  }

  if (visitedCoordinates.size !== normalizedCells.length) {
    return { ok: false, reason: "房间轮廓必须连续" };
  }

  return {
    ok: true,
    areaSquareMeters:
      normalizedCells.length * prototypeConfig.cellAreaSquareMeters,
  };
}
