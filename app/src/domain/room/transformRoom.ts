import type { Cell } from "../game/state";
import type { Opening, RoomDraft, RoomSide } from "./editRoom";
import { validateRoomDraft } from "./editRoom";

type Degrees = 90 | 180 | 270;

function rotatePoint(x: number, y: number, width: number, height: number, degrees: Degrees) {
  if (degrees === 90) return { x: height - 1 - y, y: x };
  if (degrees === 180) return { x: width - 1 - x, y: height - 1 - y };
  return { x: y, y: width - 1 - x };
}

function rotateSide(side: RoomSide, degrees: Degrees): RoomSide {
  const sides: RoomSide[] = ["north", "east", "south", "west"];
  return sides[(sides.indexOf(side) + degrees / 90) % 4];
}

function mapOpening(opening: Opening, width: number, height: number, degrees: Degrees): Opening {
  const point = rotatePoint(opening.x, opening.y, width, height, degrees);
  return { ...point, side: rotateSide(opening.side, degrees) };
}

function roomBounds(draft: RoomDraft) {
  if (draft.cells.length === 0) throw new Error("房间不能为空");
  const xs = draft.cells.map(({ x }) => x);
  const ys = draft.cells.map(({ y }) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    minX,
    minY,
    width: Math.max(...xs) - minX + 1,
    height: Math.max(...ys) - minY + 1,
  };
}

function normalizeDraft(draft: RoomDraft): RoomDraft {
  const { minX, minY } = roomBounds(draft);
  const mapOpening = (opening: Opening): Opening => ({
    ...opening,
    x: opening.x - minX,
    y: opening.y - minY,
  });
  return {
    ...draft,
    cells: draft.cells.map((cell) => ({
      ...cell,
      x: cell.x - minX,
      y: cell.y - minY,
    })),
    walls: draft.walls.map(mapOpening),
    doors: draft.doors.map(mapOpening),
    windows: draft.windows.map(mapOpening),
  };
}

export function rotateRoom(draft: RoomDraft, degrees: Degrees): RoomDraft {
  const normalized = normalizeDraft(draft);
  const { width, height } = roomBounds(normalized);
  const cells = normalized.cells.map((cell): Cell => ({
    ...rotatePoint(cell.x, cell.y, width, height, degrees),
    zone: cell.zone,
  }));
  const rotated: RoomDraft = {
    ...draft,
    cells: cells.sort((a, b) => a.y - b.y || a.x - b.x),
    columns: draft.columns,
    rows: draft.rows,
    walls: normalized.walls.map((opening) => mapOpening(opening, width, height, degrees)),
    doors: normalized.doors.map((opening) => mapOpening(opening, width, height, degrees)),
    windows: normalized.windows.map((opening) => mapOpening(opening, width, height, degrees)),
  };
  if (!validateRoomDraft(rotated).ok) throw new Error("旋转后房间无效");
  return rotated;
}

export function mirrorRoom(draft: RoomDraft, axis: "horizontal" | "vertical"): RoomDraft {
  const normalized = normalizeDraft(draft);
  const { width, height } = roomBounds(normalized);
  const map = (opening: Opening): Opening => {
    if (axis === "horizontal") {
      const side: RoomSide = opening.side === "west" ? "east" : opening.side === "east" ? "west" : opening.side;
      return { ...opening, x: width - 1 - opening.x, side };
    }
    const side: RoomSide = opening.side === "north" ? "south" : opening.side === "south" ? "north" : opening.side;
    return { ...opening, y: height - 1 - opening.y, side };
  };
  const mirrored: RoomDraft = {
    ...draft,
    cells: normalized.cells
      .map((cell) => ({ ...cell, ...(axis === "horizontal" ? { x: width - 1 - cell.x } : { y: height - 1 - cell.y }) }))
      .sort((a, b) => a.y - b.y || a.x - b.x),
    walls: normalized.walls.map(map),
    doors: normalized.doors.map(map),
    windows: normalized.windows.map(map),
  };
  if (!validateRoomDraft(mirrored).ok) throw new Error("镜像后房间无效");
  return mirrored;
}

export function resizeRoom(draft: RoomDraft, size: { width: number; height: number }): RoomDraft {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error("缩放尺寸必须是正整数");
  }
  const normalized = normalizeDraft(draft);
  const bounds = roomBounds(normalized);
  if (bounds.width > size.width || bounds.height > size.height) {
    throw new Error("缩放会裁剪房间");
  }
  if (size.width > draft.columns || size.height > draft.rows) throw new Error("缩放超出网格边界");
  const existing = new Map(normalized.cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const cells: Cell[] = [];
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const exact = existing.get(`${x},${y}`);
      if (exact) cells.push({ ...exact });
      else {
        const nearest = normalized.cells.reduce((best, cell) => {
          const distance = Math.abs(cell.x - x) + Math.abs(cell.y - y);
          const bestDistance = Math.abs(best.x - x) + Math.abs(best.y - y);
          return distance < bestDistance ? cell : best;
        });
        cells.push({ x, y, zone: nearest.zone });
      }
    }
  }
  const oldMaxX = bounds.width - 1;
  const oldMaxY = bounds.height - 1;
  const resizeOpening = (opening: Opening): Opening => ({
    ...opening,
    x: opening.side === "east" && opening.x === oldMaxX
      ? size.width - 1
      : opening.x,
    y: opening.side === "south" && opening.y === oldMaxY
      ? size.height - 1
      : opening.y,
  });
  const resized = {
    ...draft,
    cells,
    walls: normalized.walls.map(resizeOpening),
    doors: normalized.doors.map(resizeOpening),
    windows: normalized.windows.map(resizeOpening),
  };
  if (!validateRoomDraft(resized).ok) throw new Error("缩放后房间无效");
  return resized;
}
