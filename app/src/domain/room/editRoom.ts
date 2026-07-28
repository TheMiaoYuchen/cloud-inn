import type { Cell, ZoneKind } from "../game/state";
import {
  addSpaceOpening,
  createSpaceHistory,
  eraseSpaceCellUnchecked,
  redoSpaceEdit,
  replaceSpaceCell,
  spaceSelectionBounds,
  undoSpaceEdit,
} from "../spaces/spaceEditor";
import {
  SPACE_EDITOR_HISTORY_LIMIT,
  type SpaceDraft,
  type SpaceHistory,
} from "../spaces/spaceTypes";
import { validateRoomCells } from "./grid";

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

export function roomDraftToSpaceDraft(draft: RoomDraft): SpaceDraft {
  return {
    type: "sky-lobby",
    columns: draft.columns,
    rows: draft.rows,
    cells: draft.cells.map(({ x, y, zone }) => ({ x, y, zoneId: zone })),
    items: [],
    walls: draft.walls.map((opening) => ({ ...opening })),
    doors: draft.doors.map((opening) => ({ ...opening })),
    windows: draft.windows.map((opening) => ({ ...opening })),
  };
}

export function spaceDraftToRoomDraft(draft: SpaceDraft): RoomDraft {
  const cells = draft.cells.map(({ x, y, zoneId }) => {
    if (zoneId !== "bedroom" && zoneId !== "bathroom") {
      throw new Error("客房分区必须是卧室或卫浴");
    }
    const zone: ZoneKind = zoneId;
    return { x, y, zone };
  });
  return {
    cells,
    columns: draft.columns,
    rows: draft.rows,
    walls: draft.walls.map((opening) => ({ ...opening })),
    doors: draft.doors.map((opening) => ({ ...opening })),
    windows: draft.windows.map((opening) => ({ ...opening })),
  };
}

function addOpening(
  draft: RoomDraft,
  opening: Opening,
  property: "walls" | "doors" | "windows",
): RoomDraft {
  try {
    return spaceDraftToRoomDraft(addSpaceOpening(
      roomDraftToSpaceDraft(draft),
      opening,
      property,
    ));
  } catch (error) {
    if (error instanceof Error && error.message === "开口必须位于空间边界") {
      throw new Error("开口必须位于房间边界");
    }
    throw error;
  }
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
  const space = roomDraftToSpaceDraft(draft);
  space.cells = replaceSpaceCell(space.cells, {
    x: cell.x,
    y: cell.y,
    zoneId: cell.zone,
  });
  return spaceDraftToRoomDraft(space);
}

export function eraseRoomCell(draft: RoomDraft, x: number, y: number): RoomDraft {
  return spaceDraftToRoomDraft(eraseSpaceCellUnchecked(
    roomDraftToSpaceDraft(draft),
    x,
    y,
  ));
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
  return spaceSelectionBounds(selection);
}

export function validateRoomDraft(draft: RoomDraft) {
  const validation = validateRoomCells(draft.cells, draft.columns, draft.rows);
  if (!validation.ok) return validation;
  const openings = [...draft.walls, ...draft.doors, ...draft.windows];
  const openingKeys = new Set<string>();
  for (const opening of openings) {
    const key = `${opening.x},${opening.y},${opening.side}`;
    if (openingKeys.has(key)) {
      return { ok: false as const, reason: "同一房间边只能设置一个开口" };
    }
    openingKeys.add(key);
    try {
      addSpaceOpening(
        { ...roomDraftToSpaceDraft(draft), walls: [], doors: [], windows: [] },
        opening,
        "doors",
      );
    } catch {
      return { ok: false as const, reason: "开口必须位于房间边界" };
    }
  }
  return validation;
}

export function createRoomHistory(initial: RoomDraft, edits: RoomDraft[] = []): RoomHistory {
  const boundedEdits = edits.slice(-(SPACE_EDITOR_HISTORY_LIMIT + 1));
  return spaceHistoryToRoomHistory(createSpaceHistory(
    roomDraftToSpaceDraft(initial),
    boundedEdits.map(roomDraftToSpaceDraft),
  ));
}

export function undoRoomEdit(history: RoomHistory): RoomHistory {
  const hasPast = history.past.length > 0;
  return spaceHistoryToRoomHistory(undoSpaceEdit(
    roomHistoryToSpaceHistory({
      ...history,
      past: history.past.slice(-(hasPast
        ? SPACE_EDITOR_HISTORY_LIMIT + 1
        : SPACE_EDITOR_HISTORY_LIMIT)),
      future: history.future.slice(0, hasPast
        ? SPACE_EDITOR_HISTORY_LIMIT - 1
        : SPACE_EDITOR_HISTORY_LIMIT),
    }),
  ));
}

export function redoRoomEdit(history: RoomHistory): RoomHistory {
  const hasFuture = history.future.length > 0;
  return spaceHistoryToRoomHistory(redoSpaceEdit(
    roomHistoryToSpaceHistory({
      ...history,
      past: history.past.slice(-(hasFuture
        ? SPACE_EDITOR_HISTORY_LIMIT - 1
        : SPACE_EDITOR_HISTORY_LIMIT)),
      future: history.future.slice(0, hasFuture
        ? SPACE_EDITOR_HISTORY_LIMIT + 1
        : SPACE_EDITOR_HISTORY_LIMIT),
    }),
  ));
}

function roomHistoryToSpaceHistory(history: RoomHistory): SpaceHistory {
  return {
    past: history.past.map(roomDraftToSpaceDraft),
    present: roomDraftToSpaceDraft(history.present),
    future: history.future.map(roomDraftToSpaceDraft),
  };
}

function spaceHistoryToRoomHistory(history: SpaceHistory): RoomHistory {
  return {
    past: history.past.map(spaceDraftToRoomDraft),
    present: spaceDraftToRoomDraft(history.present),
    future: history.future.map(spaceDraftToRoomDraft),
  };
}

export function zoneForCell(draft: RoomDraft, x: number, y: number): ZoneKind | undefined {
  return draft.cells.find((cell) => cell.x === x && cell.y === y)?.zone;
}
