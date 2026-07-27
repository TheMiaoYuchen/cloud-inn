import type { Cell, ZoneKind } from "../game/state";
import { addCell, eraseCell, validateRoomCells } from "./grid";

export type RoomSide = "north" | "east" | "south" | "west";
export type Opening = { x: number; y: number; side: RoomSide };
export type RoomDraft = {
  cells: Cell[];
  columns: number;
  rows: number;
  walls: Opening[];
  doors: Opening[];
  windows: Opening[];
};

export type RoomHistory = {
  past: RoomDraft[];
  present: RoomDraft;
  future: RoomDraft[];
};

function cloneDraft(draft: RoomDraft): RoomDraft {
  return {
    ...draft,
    cells: draft.cells.map((cell) => ({ ...cell })),
    walls: draft.walls.map((opening) => ({ ...opening })),
    doors: draft.doors.map((opening) => ({ ...opening })),
    windows: draft.windows.map((opening) => ({ ...opening })),
  };
}

function openingKey(opening: Opening): string {
  return `${opening.x},${opening.y},${opening.side}`;
}

function hasCell(draft: RoomDraft, x: number, y: number): boolean {
  return draft.cells.some((cell) => cell.x === x && cell.y === y);
}

function boundaryCells(draft: RoomDraft, opening: Opening): boolean {
  if (!hasCell(draft, opening.x, opening.y)) return false;
  const neighbors: Record<RoomSide, [number, number]> = {
    north: [opening.x, opening.y - 1],
    east: [opening.x + 1, opening.y],
    south: [opening.x, opening.y + 1],
    west: [opening.x - 1, opening.y],
  };
  const [neighborX, neighborY] = neighbors[opening.side];
  return !hasCell(draft, neighborX, neighborY);
}

function addOpening(
  draft: RoomDraft,
  opening: Opening,
  property: "walls" | "doors" | "windows",
): RoomDraft {
  if (!boundaryCells(draft, opening)) {
    throw new Error("开口必须位于房间边界");
  }
  const key = openingKey(opening);
  const hasOtherOpening = (["walls", "doors", "windows"] as const)
    .filter((candidate) => candidate !== property)
    .some((candidate) =>
      draft[candidate].some((entry) => openingKey(entry) === key),
    );
  if (hasOtherOpening) {
    throw new Error("这条边已有其他开口");
  }
  if (draft[property].some((entry) => openingKey(entry) === openingKey(opening))) {
    return cloneDraft(draft);
  }
  return { ...cloneDraft(draft), [property]: [...draft[property], { ...opening }] };
}

export function createRoomDraft(
  cells: Cell[],
  columns: number,
  rows: number,
): RoomDraft {
  return {
    cells: cells.map((cell) => ({ ...cell })),
    columns,
    rows,
    walls: [],
    doors: [],
    windows: [],
  };
}

export function paintRoomCell(draft: RoomDraft, cell: Cell): RoomDraft {
  return { ...cloneDraft(draft), cells: addCell(draft.cells, { ...cell }) };
}

export function eraseRoomCell(draft: RoomDraft, x: number, y: number): RoomDraft {
  const next = cloneDraft(draft);
  next.cells = eraseCell(draft.cells, x, y);
  for (const property of ["walls", "doors", "windows"] as const) {
    next[property] = next[property].filter((opening) => opening.x !== x || opening.y !== y);
  }
  return next;
}

export function addWall(draft: RoomDraft, opening: Opening): RoomDraft {
  return addOpening(draft, opening, "walls");
}
export function addDoor(draft: RoomDraft, opening: Opening): RoomDraft {
  return addOpening(draft, opening, "doors");
}
export function addWindow(draft: RoomDraft, opening: Opening): RoomDraft {
  return addOpening(draft, opening, "windows");
}

export function selectionBounds(
  draft: RoomDraft,
  selection: Array<{ x: number; y: number }>,
): { x: number; y: number; width: number; height: number } | null {
  void draft;
  if (selection.length === 0) return null;
  const xs = selection.map(({ x }) => x);
  const ys = selection.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 };
}

export function validateRoomDraft(draft: RoomDraft) {
  const validation = validateRoomCells(draft.cells, draft.columns, draft.rows);
  if (!validation.ok) return validation;
  const openings = [...draft.walls, ...draft.doors, ...draft.windows];
  const openingKeys = new Set<string>();
  for (const opening of openings) {
    const key = openingKey(opening);
    if (openingKeys.has(key)) {
      return { ok: false as const, reason: "同一房间边只能设置一个开口" };
    }
    openingKeys.add(key);
    if (!boundaryCells(draft, opening)) {
      return { ok: false as const, reason: "开口必须位于房间边界" };
    }
  }
  return validation;
}

export function createRoomHistory(initial: RoomDraft, edits: RoomDraft[] = []): RoomHistory {
  const snapshots = [initial, ...edits].map(cloneDraft);
  return {
    past: snapshots.slice(0, -1),
    present: snapshots[snapshots.length - 1] ?? cloneDraft(initial),
    future: [],
  };
}

export function undoRoomEdit(history: RoomHistory): RoomHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1).map(cloneDraft),
    present: cloneDraft(previous),
    future: [cloneDraft(history.present), ...history.future.map(cloneDraft)],
  };
}

export function redoRoomEdit(history: RoomHistory): RoomHistory {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    past: [...history.past.map(cloneDraft), cloneDraft(history.present)],
    present: cloneDraft(next),
    future: history.future.slice(1).map(cloneDraft),
  };
}

export function zoneForCell(draft: RoomDraft, x: number, y: number): ZoneKind | undefined {
  return draft.cells.find((cell) => cell.x === x && cell.y === y)?.zone;
}
