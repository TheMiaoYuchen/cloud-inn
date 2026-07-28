import type { PublicSpaceType } from "../facilities/facilityTypes";
import type {
  PlacedItem,
  SpaceCell,
  SpaceDraft,
  SpaceHistory,
  SpaceOpening,
  SpaceSide,
} from "./spaceTypes";
import {
  SPACE_EDITOR_HISTORY_LIMIT,
  SPACE_EDITOR_MAX_CELLS,
  SPACE_EDITOR_MAX_ITEMS,
  SPACE_EDITOR_MAX_OPENINGS,
} from "./spaceTypes";

export interface SpaceRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpaceConnectivity {
  connected: boolean;
  zoneConnectivity: Record<string, boolean>;
  serviceRouteConnected: boolean;
}

const key = (x: number, y: number) => `${x},${y}`;
const rotations = new Set([0, 90, 180, 270]);
const alignments = new Set([
  "left", "right", "top", "bottom", "horizontal-center", "vertical-center",
]);

function isSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

function assertCoordinate(draft: SpaceDraft, x: number, y: number): void {
  if (!isSafeInteger(x) || !isSafeInteger(y) || x < 0 || y < 0 || x >= draft.columns || y >= draft.rows) {
    throw new Error("空间坐标超出网格边界");
  }
}

export function cloneSpaceDraft(draft: SpaceDraft): SpaceDraft {
  return {
    ...draft,
    cells: draft.cells.map((cell) => ({ ...cell })),
    items: draft.items.map((item) => ({ ...item })),
    walls: draft.walls.map((opening) => ({ ...opening })),
    doors: draft.doors.map((opening) => ({ ...opening })),
    windows: draft.windows.map((opening) => ({ ...opening })),
  };
}

function boundaryCell(draft: SpaceDraft, opening: SpaceOpening): boolean {
  if (!draft.cells.some(({ x, y }) => x === opening.x && y === opening.y)) return false;
  const offset: Record<SpaceSide, readonly [number, number]> = {
    north: [0, -1],
    east: [1, 0],
    south: [0, 1],
    west: [-1, 0],
  };
  const neighborOffset = offset[opening.side];
  if (!neighborOffset) return false;
  const [dx, dy] = neighborOffset;
  return !draft.cells.some(({ x, y }) => x === opening.x + dx && y === opening.y + dy);
}

export function addSpaceOpening(
  draft: SpaceDraft,
  opening: SpaceOpening,
  property: "walls" | "doors" | "windows",
): SpaceDraft {
  if (draft.walls.length + draft.doors.length + draft.windows.length >= SPACE_EDITOR_MAX_OPENINGS) {
    throw new Error("空间开口数量超过上限");
  }
  if (!boundaryCell(draft, opening)) throw new Error("开口必须位于空间边界");
  const openingKey = `${opening.x},${opening.y},${opening.side}`;
  const duplicateProperty = (["walls", "doors", "windows"] as const).find((candidate) =>
    draft[candidate].some(
      (entry) => `${entry.x},${entry.y},${entry.side}` === openingKey,
    ));
  if (duplicateProperty) {
    if (duplicateProperty === property) return cloneSpaceDraft(draft);
    throw new Error("这条边已有其他开口");
  }
  const next = cloneSpaceDraft(draft);
  next[property].push({ ...opening });
  return next;
}

export function createSpaceDraft(
  type: PublicSpaceType,
  columns: number,
  rows: number,
): SpaceDraft {
  if (!isSafeInteger(columns) || !isSafeInteger(rows) || columns <= 0 || rows <= 0) {
    throw new Error("空间网格尺寸必须是正安全整数");
  }
  return { type, columns, rows, cells: [], items: [], walls: [], doors: [], windows: [] };
}

export function paintSpaceCell(draft: SpaceDraft, cell: SpaceCell): SpaceDraft {
  assertCoordinate(draft, cell.x, cell.y);
  if (!cell.zoneId.trim()) throw new Error("分区编号不能为空");
  const exists = draft.cells.some(({ x, y }) => x === cell.x && y === cell.y);
  if (!exists && draft.cells.length >= SPACE_EDITOR_MAX_CELLS) {
    throw new Error("空间单元数量超过上限");
  }
  const next = cloneSpaceDraft(draft);
  next.cells = replaceSpaceCell(next.cells, cell);
  return next;
}

export function replaceSpaceCell(cells: SpaceCell[], cell: SpaceCell): SpaceCell[] {
  return [
    ...cells.filter(({ x, y }) => x !== cell.x || y !== cell.y).map((value) => ({ ...value })),
    { ...cell },
  ].sort((left, right) => left.y - right.y || left.x - right.x);
}

export function removeSpaceCellAt(cells: SpaceCell[], x: number, y: number): SpaceCell[] {
  return cells
    .filter((cell) => cell.x !== x || cell.y !== y)
    .map((cell) => ({ ...cell }))
    .sort((left, right) => left.y - right.y || left.x - right.x);
}

export function eraseSpaceCellUnchecked(draft: SpaceDraft, x: number, y: number): SpaceDraft {
  const next = cloneSpaceDraft(draft);
  next.cells = removeSpaceCellAt(next.cells, x, y);
  for (const property of ["walls", "doors", "windows"] as const) {
    next[property] = next[property].filter((opening) => opening.x !== x || opening.y !== y);
  }
  return next;
}

export function eraseSpaceCell(draft: SpaceDraft, x: number, y: number): SpaceDraft {
  assertCoordinate(draft, x, y);
  return eraseSpaceCellUnchecked(draft, x, y);
}

export function spaceSelectionBounds(
  selection: Array<{ x: number; y: number }>,
): SpaceRectangle | null {
  if (selection.length === 0) return null;
  if (selection.length > SPACE_EDITOR_MAX_CELLS) throw new Error("选择单元数量超过上限");
  let minimumX = Number.MAX_SAFE_INTEGER;
  let minimumY = Number.MAX_SAFE_INTEGER;
  let maximumX = Number.MIN_SAFE_INTEGER;
  let maximumY = Number.MIN_SAFE_INTEGER;
  for (const { x, y } of selection) {
    if (!isSafeInteger(x) || !isSafeInteger(y)) throw new Error("选择坐标必须是安全整数");
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
  }
  const width = BigInt(maximumX) - BigInt(minimumX) + 1n;
  const height = BigInt(maximumY) - BigInt(minimumY) + 1n;
  if (width > BigInt(Number.MAX_SAFE_INTEGER) || height > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("选择范围超出安全整数边界");
  }
  return { x: minimumX, y: minimumY, width: Number(width), height: Number(height) };
}

export function paintSpaceRectangle(
  draft: SpaceDraft,
  rectangle: SpaceRectangle,
  zoneId: string,
): SpaceDraft {
  const cells = createSpaceRectangleCells(rectangle, zoneId);
  if (rectangle.width === 0 || rectangle.height === 0) return cloneSpaceDraft(draft);
  assertCoordinate(draft, rectangle.x, rectangle.y);
  assertCoordinate(draft, rectangle.x + rectangle.width - 1, rectangle.y + rectangle.height - 1);
  let next = cloneSpaceDraft(draft);
  for (const cell of cells) next = paintSpaceCell(next, cell);
  return next;
}

export function createSpaceRectangleCells(
  rectangle: SpaceRectangle,
  zoneId: string,
  maximumCells = SPACE_EDITOR_MAX_CELLS,
): SpaceCell[] {
  if (![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isSafeInteger) ||
      rectangle.width < 0 || rectangle.height < 0) {
    throw new Error("矩形参数必须是有限整数且宽高不能为负数");
  }
  if (!zoneId.trim()) throw new Error("分区编号不能为空");
  const maximumExclusive = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  if (BigInt(rectangle.x) + BigInt(rectangle.width) > maximumExclusive ||
      BigInt(rectangle.y) + BigInt(rectangle.height) > maximumExclusive) {
    throw new Error("矩形范围超出安全整数边界");
  }
  if (!Number.isSafeInteger(maximumCells) || maximumCells < 1) {
    throw new Error("空间单元上限必须是正安全整数");
  }
  const area = BigInt(rectangle.width) * BigInt(rectangle.height);
  if (area > BigInt(maximumCells)) throw new Error("空间单元数量超过上限");
  const cells: SpaceCell[] = [];
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
      cells.push({ x, y, zoneId });
    }
  }
  return cells;
}

export function zoneAt(draft: SpaceDraft, x: number, y: number): string | undefined {
  return draft.cells.find((cell) => cell.x === x && cell.y === y)?.zoneId;
}

export function placeSpaceItem(draft: SpaceDraft, item: PlacedItem): SpaceDraft {
  if (draft.items.length >= SPACE_EDITOR_MAX_ITEMS) throw new Error("空间物件数量超过上限");
  if (!item.id.trim()) throw new Error("物件编号不能为空");
  if (!item.catalogItemId.trim()) throw new Error("物件目录引用不能为空");
  if (draft.items.some(({ id }) => id === item.id)) throw new Error("物件编号不能重复");
  assertItemGeometry(draft, item);
  assertNoItemCollision(draft.items, item);
  const next = cloneSpaceDraft(draft);
  next.items.push({ ...item });
  return next;
}

function assertItemGeometry(draft: SpaceDraft, item: PlacedItem): void {
  if (!rotations.has(item.rotation)) throw new Error("物件 rotation 必须是 0、90、180 或 270");
  if (![item.x, item.y, item.width, item.height].every(isSafeInteger) || item.width <= 0 || item.height <= 0) {
    throw new Error("物件尺寸和坐标必须是有效整数");
  }
  if (item.x < 0 || item.y < 0 || item.x + item.width > draft.columns || item.y + item.height > draft.rows) {
    throw new Error("物件超出空间边界");
  }
}

function overlaps(left: PlacedItem, right: PlacedItem): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y;
}

function assertNoItemCollision(items: PlacedItem[], candidate: PlacedItem): void {
  if (items.some((item) => item.id !== candidate.id && overlaps(item, candidate))) {
    throw new Error("物件不能互相重叠");
  }
}

function replaceItem(draft: SpaceDraft, item: PlacedItem): SpaceDraft {
  assertItemGeometry(draft, item);
  assertNoItemCollision(draft.items, item);
  const next = cloneSpaceDraft(draft);
  const index = next.items.findIndex(({ id }) => id === item.id);
  if (index < 0) throw new Error("找不到要移动的物件");
  next.items[index] = { ...item };
  return next;
}

export function snapPlacedItem(
  draft: SpaceDraft,
  itemId: string,
  point: { x: number; y: number },
): SpaceDraft {
  const next = cloneSpaceDraft(draft);
  const item = next.items.find(({ id }) => id === itemId);
  if (!item) throw new Error("找不到要移动的物件");
  return replaceItem(draft, { ...item, x: Math.round(point.x), y: Math.round(point.y) });
}

export function rotatePlacedItem(
  draft: SpaceDraft,
  itemId: string,
  rotation: PlacedItem["rotation"],
): SpaceDraft {
  if (!rotations.has(rotation)) throw new Error("物件 rotation 必须是 0、90、180 或 270");
  const item = draft.items.find(({ id }) => id === itemId);
  if (!item) throw new Error("找不到要旋转的物件");
  const swapsDimensions = Math.abs(rotation - item.rotation) % 180 === 90;
  return replaceItem(draft, {
    ...item,
    rotation,
    width: swapsDimensions ? item.height : item.width,
    height: swapsDimensions ? item.width : item.height,
  });
}

export function alignPlacedItems(
  draft: SpaceDraft,
  itemIds: string[],
  alignment: "left" | "right" | "top" | "bottom" | "horizontal-center" | "vertical-center",
): SpaceDraft {
  if (!alignments.has(alignment)) throw new Error("物件对齐方式无效");
  const next = cloneSpaceDraft(draft);
  const selected = itemIds.map((id) => next.items.find((item) => item.id === id));
  if (selected.some((item) => !item)) throw new Error("找不到要对齐的物件");
  const items = selected as PlacedItem[];
  if (items.length < 2) return next;
  const anchor = items[0];
  for (const item of items.slice(1)) {
    if (alignment === "left") item.x = anchor.x;
    else if (alignment === "right") item.x = anchor.x + anchor.width - item.width;
    else if (alignment === "top") item.y = anchor.y;
    else if (alignment === "bottom") item.y = anchor.y + anchor.height - item.height;
    else if (alignment === "horizontal-center") {
      item.x = Math.round(anchor.x + anchor.width / 2 - item.width / 2);
    } else item.y = Math.round(anchor.y + anchor.height / 2 - item.height / 2);
  }
  for (const item of next.items) assertItemGeometry(next, item);
  for (let left = 0; left < next.items.length; left += 1) {
    for (let right = left + 1; right < next.items.length; right += 1) {
      if (overlaps(next.items[left], next.items[right])) throw new Error("物件不能互相重叠");
    }
  }
  return next;
}

export function addSpaceWall(draft: SpaceDraft, opening: SpaceOpening): SpaceDraft {
  return addSpaceOpening(draft, opening, "walls");
}

export function addSpaceDoor(draft: SpaceDraft, opening: SpaceOpening): SpaceDraft {
  return addSpaceOpening(draft, opening, "doors");
}

export function addSpaceWindow(draft: SpaceDraft, opening: SpaceOpening): SpaceDraft {
  return addSpaceOpening(draft, opening, "windows");
}

function connected(cells: SpaceCell[]): boolean {
  if (cells.length === 0) return true;
  const coordinates = new Set(cells.map((cell) => key(cell.x, cell.y)));
  const visited = new Set<string>();
  const pending = [cells[0]];
  while (pending.length > 0) {
    const cell = pending.pop();
    if (!cell || visited.has(key(cell.x, cell.y))) continue;
    visited.add(key(cell.x, cell.y));
    for (const [x, y] of [[cell.x - 1, cell.y], [cell.x + 1, cell.y], [cell.x, cell.y - 1], [cell.x, cell.y + 1]]) {
      if (coordinates.has(key(x, y)) && !visited.has(key(x, y))) pending.push({ x, y, zoneId: cell.zoneId });
    }
  }
  return visited.size === coordinates.size;
}

export function validateSpaceConnectivity(draft: SpaceDraft): SpaceConnectivity {
  const cells = draft.cells.slice(0, SPACE_EDITOR_MAX_CELLS);
  const items = draft.items.slice(0, SPACE_EDITOR_MAX_ITEMS);
  const zoneIds = [...new Set(cells.map(({ zoneId }) => zoneId))].sort();
  const zoneConnectivity = Object.fromEntries(
    zoneIds.map((zoneId) => [zoneId, connected(cells.filter((cell) => cell.zoneId === zoneId))]),
  );
  const serviceCells = cells.filter(({ zoneId }) =>
    zoneId === "zone:service-route" || zoneId === "service-route",
  );
  const traversableServiceCells = serviceCells.filter((cell) => !items.some((item) =>
    [item.x, item.y, item.width, item.height].every(isSafeInteger) &&
    item.width > 0 && item.height > 0 &&
    cell.x >= item.x && cell.x < item.x + item.width &&
    cell.y >= item.y && cell.y < item.y + item.height,
  ));
  return {
    connected: connected(cells),
    zoneConnectivity,
    serviceRouteConnected: serviceCells.length > 0 &&
      traversableServiceCells.length > 0 &&
      connected(traversableServiceCells),
  };
}

export function validateSpaceDraft(
  draft: SpaceDraft,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (!isSafeInteger(draft.columns) || !isSafeInteger(draft.rows) || draft.columns <= 0 || draft.rows <= 0) {
    addReason("空间网格尺寸必须是正安全整数");
  }
  if (draft.cells.length > SPACE_EDITOR_MAX_CELLS) addReason("空间单元数量超过上限");
  const boundedCells = draft.cells.slice(0, SPACE_EDITOR_MAX_CELLS);
  const cellKeys = new Set<string>();
  for (const cell of boundedCells) {
    if (!isSafeInteger(cell.x) || !isSafeInteger(cell.y) || cell.x < 0 || cell.y < 0 ||
        cell.x >= draft.columns || cell.y >= draft.rows) addReason("空间坐标超出网格边界");
    const coordinate = key(cell.x, cell.y);
    if (cellKeys.has(coordinate)) addReason("同一坐标只能设置一个分区");
    cellKeys.add(coordinate);
    if (!cell.zoneId.trim()) addReason("分区编号不能为空");
  }
  if (draft.items.length > SPACE_EDITOR_MAX_ITEMS) addReason("空间物件数量超过上限");
  const boundedItems = draft.items.slice(0, SPACE_EDITOR_MAX_ITEMS);
  const itemIds = new Set<string>();
  for (const item of boundedItems) {
    if (!item.id.trim()) addReason("物件编号不能为空");
    if (!item.catalogItemId.trim()) addReason("物件目录引用不能为空");
    if (itemIds.has(item.id)) addReason("物件编号不能重复");
    itemIds.add(item.id);
  }
  for (const item of boundedItems) {
    if (!rotations.has(item.rotation)) addReason("物件 rotation 必须是 0、90、180 或 270");
    if (![item.x, item.y, item.width, item.height].every(isSafeInteger) || item.width <= 0 || item.height <= 0) {
      addReason("物件尺寸和坐标必须是有效整数");
    } else if (item.x < 0 || item.y < 0 || item.x + item.width > draft.columns || item.y + item.height > draft.rows) {
      addReason("物件超出空间边界");
    }
  }
  for (let left = 0; left < boundedItems.length; left += 1) {
    for (let right = left + 1; right < boundedItems.length; right += 1) {
      if (overlaps(boundedItems[left], boundedItems[right])) addReason("物件不能互相重叠");
    }
  }
  const openingCount = draft.walls.length + draft.doors.length + draft.windows.length;
  if (openingCount > SPACE_EDITOR_MAX_OPENINGS) addReason("空间开口数量超过上限");
  const boundedOpenings = [...draft.walls, ...draft.doors, ...draft.windows]
    .slice(0, SPACE_EDITOR_MAX_OPENINGS);
  const openingKeys = new Set<string>();
  for (const opening of boundedOpenings) {
    if (!(["north", "east", "south", "west"] as string[]).includes(opening.side)) {
      addReason("开口方向无效");
    }
    const openingCoordinate = `${opening.x},${opening.y},${opening.side}`;
    if (openingKeys.has(openingCoordinate)) addReason("同一空间边只能设置一个开口");
    openingKeys.add(openingCoordinate);
  }
  for (const opening of boundedOpenings) {
    if (!boundaryCell({ ...draft, cells: boundedCells }, opening)) {
      addReason("开口必须位于空间边界");
    }
  }
  const connectivity = validateSpaceConnectivity(draft);
  if (!connectivity.connected) reasons.push("空间轮廓必须连续");
  for (const [zoneId, isConnected] of Object.entries(connectivity.zoneConnectivity)) {
    if (!isConnected) addReason(`分区 ${zoneId} 必须连续`);
  }
  if (boundedCells.some(({ zoneId }) => zoneId === "zone:service-route" || zoneId === "service-route") &&
      !connectivity.serviceRouteConnected) addReason("服务路线必须连续");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function createSpaceHistory(
  initial: SpaceDraft,
  edits: SpaceDraft[] = [],
  limit = SPACE_EDITOR_HISTORY_LIMIT,
): SpaceHistory {
  assertHistoryLimit(limit);
  const presentReference = edits.length > 0 ? edits[edits.length - 1] : initial;
  const pastReferences = edits.length === 0
    ? []
    : edits.length <= limit
      ? [initial, ...edits.slice(0, -1)]
      : edits.slice(edits.length - limit - 1, -1);
  return {
    past: pastReferences.map(cloneSpaceDraft),
    present: cloneSpaceDraft(presentReference),
    future: [],
  };
}

function assertHistoryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SPACE_EDITOR_HISTORY_LIMIT) {
    throw new Error("历史上限必须是 1-100 的安全整数");
  }
}

function lastSnapshots(snapshots: SpaceDraft[], count: number): SpaceDraft[] {
  return count === 0 ? [] : snapshots.slice(-count);
}

function cloneSpaceHistory(history: SpaceHistory, limit: number): SpaceHistory {
  return {
    past: lastSnapshots(history.past, limit).map(cloneSpaceDraft),
    present: cloneSpaceDraft(history.present),
    future: history.future.slice(0, limit).map(cloneSpaceDraft),
  };
}

export function commitSpaceEdit(
  history: SpaceHistory,
  next: SpaceDraft,
  limit = SPACE_EDITOR_HISTORY_LIMIT,
): SpaceHistory {
  assertHistoryLimit(limit);
  return {
    past: [
      ...lastSnapshots(history.past, limit - 1).map(cloneSpaceDraft),
      cloneSpaceDraft(history.present),
    ],
    present: cloneSpaceDraft(next),
    future: [],
  };
}

export function undoSpaceEdit(
  history: SpaceHistory,
  limit = SPACE_EDITOR_HISTORY_LIMIT,
): SpaceHistory {
  assertHistoryLimit(limit);
  if (history.past.length === 0) return cloneSpaceHistory(history, limit);
  const boundedPast = lastSnapshots(history.past, limit + 1);
  const previous = boundedPast[boundedPast.length - 1];
  if (!previous) return history;
  return {
    past: boundedPast.slice(0, -1).map(cloneSpaceDraft),
    present: cloneSpaceDraft(previous),
    future: [
      cloneSpaceDraft(history.present),
      ...history.future.slice(0, limit - 1).map(cloneSpaceDraft),
    ],
  };
}

export function redoSpaceEdit(
  history: SpaceHistory,
  limit = SPACE_EDITOR_HISTORY_LIMIT,
): SpaceHistory {
  assertHistoryLimit(limit);
  const next = history.future[0];
  if (!next) return cloneSpaceHistory(history, limit);
  return {
    past: [
      ...lastSnapshots(history.past, limit - 1).map(cloneSpaceDraft),
      cloneSpaceDraft(history.present),
    ],
    present: cloneSpaceDraft(next),
    future: history.future.slice(1, limit + 1).map(cloneSpaceDraft),
  };
}
