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

export function rotateRoom(draft: RoomDraft, degrees: Degrees): RoomDraft {
  const minX = Math.min(...draft.cells.map((cell) => cell.x), 0);
  const minY = Math.min(...draft.cells.map((cell) => cell.y), 0);
  const width = Math.max(...draft.cells.map((cell) => cell.x), 0) - minX + 1;
  const height = Math.max(...draft.cells.map((cell) => cell.y), 0) - minY + 1;
  const cells = draft.cells.map((cell): Cell => ({
    ...rotatePoint(cell.x - minX, cell.y - minY, width, height, degrees),
    zone: cell.zone,
  }));
  const rotated: RoomDraft = {
    ...draft,
    cells: cells.sort((a, b) => a.y - b.y || a.x - b.x),
    columns: draft.columns,
    rows: draft.rows,
    walls: draft.walls.map((opening) => mapOpening({ ...opening, x: opening.x - minX, y: opening.y - minY }, width, height, degrees)),
    doors: draft.doors.map((opening) => mapOpening({ ...opening, x: opening.x - minX, y: opening.y - minY }, width, height, degrees)),
    windows: draft.windows.map((opening) => mapOpening({ ...opening, x: opening.x - minX, y: opening.y - minY }, width, height, degrees)),
  };
  if (!validateRoomDraft(rotated).ok) throw new Error("旋转后房间无效");
  return rotated;
}

export function mirrorRoom(draft: RoomDraft, axis: "horizontal" | "vertical"): RoomDraft {
  const minX = Math.min(...draft.cells.map((cell) => cell.x), 0);
  const minY = Math.min(...draft.cells.map((cell) => cell.y), 0);
  const maxX = Math.max(...draft.cells.map((cell) => cell.x), 0);
  const maxY = Math.max(...draft.cells.map((cell) => cell.y), 0);
  const map = (opening: Opening): Opening => {
    if (axis === "horizontal") {
      const side: RoomSide = opening.side === "west" ? "east" : opening.side === "east" ? "west" : opening.side;
      return { ...opening, x: maxX + minX - opening.x, side };
    }
    const side: RoomSide = opening.side === "north" ? "south" : opening.side === "south" ? "north" : opening.side;
    return { ...opening, y: maxY + minY - opening.y, side };
  };
  const mirrored: RoomDraft = {
    ...draft,
    cells: draft.cells
      .map((cell) => ({ ...cell, ...(axis === "horizontal" ? { x: maxX + minX - cell.x } : { y: maxY + minY - cell.y }) }))
      .sort((a, b) => a.y - b.y || a.x - b.x),
    walls: draft.walls.map(map),
    doors: draft.doors.map(map),
    windows: draft.windows.map(map),
  };
  if (!validateRoomDraft(mirrored).ok) throw new Error("镜像后房间无效");
  return mirrored;
}

export function resizeRoom(draft: RoomDraft, size: { width: number; height: number }): RoomDraft {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error("缩放尺寸必须是正整数");
  }
  if (draft.cells.some((cell) => cell.x >= size.width || cell.y >= size.height)) {
    throw new Error("缩放会裁剪房间");
  }
  if (size.width > draft.columns || size.height > draft.rows) throw new Error("缩放超出网格边界");
  const existing = new Map(draft.cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const cells: Cell[] = [];
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const exact = existing.get(`${x},${y}`);
      if (exact) cells.push({ ...exact });
      else {
        const nearest = draft.cells.reduce((best, cell) => {
          const distance = Math.abs(cell.x - x) + Math.abs(cell.y - y);
          const bestDistance = Math.abs(best.x - x) + Math.abs(best.y - y);
          return distance < bestDistance ? cell : best;
        });
        cells.push({ x, y, zone: nearest.zone });
      }
    }
  }
  const resized = {
    ...draft,
    cells,
    walls: draft.walls.map((opening) => ({ ...opening })),
    doors: draft.doors.map((opening) => ({ ...opening })),
    windows: draft.windows.map((opening) => ({ ...opening })),
  };
  if (!validateRoomDraft(resized).ok) throw new Error("缩放后房间无效");
  return resized;
}
