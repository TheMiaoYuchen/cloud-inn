import type {
  CorridorSlot,
  CorridorTemplate,
  GridPoint,
  RoomVariant,
} from "../design/designTypes";

export type CorridorTemplateKind = "complete-ring" | "partial-ring";

export interface RoomFootprint {
  slotId: string;
  anchor: GridPoint;
  width: number;
  height: number;
  cells: GridPoint[];
}

export interface CorridorValidation {
  ok: boolean;
  reasons: string[];
}

export type CorridorHint =
  | {
      kind: "service-distance";
      severity: "warning";
      advisory: true;
      slotId: string;
      value: number;
      message: string;
    }
  | {
      kind: "congestion";
      severity: "warning";
      advisory: true;
      value: number;
      message: string;
    };

export interface CorridorAnalysis {
  serviceDistances: Record<string, number>;
  corridorUsage: Record<string, number>;
  maxCongestion: number;
  hints: CorridorHint[];
}

export interface CorridorAnalysisOptions {
  serviceDistanceWarning?: number;
  congestionWarning?: number;
}

const CORE_MIN = 28;
const CORE_MAX = 35;
const RING_MIN = 15;
const RING_MAX = 48;
const DIRECTIONS: readonly GridPoint[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

function pointKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

function makeCore(): GridPoint[] {
  const core: GridPoint[] = [];
  for (let y = CORE_MIN; y <= CORE_MAX; y += 1) {
    for (let x = CORE_MIN; x <= CORE_MAX; x += 1) core.push({ x, y });
  }
  return core;
}

function makeRing(kind: CorridorTemplateKind): GridPoint[] {
  const ring: GridPoint[] = [];
  for (let x = RING_MIN; x <= RING_MAX; x += 1) {
    ring.push({ x, y: RING_MIN });
    ring.push({ x, y: RING_MAX });
  }
  for (let y = RING_MIN + 1; y < RING_MAX; y += 1) {
    ring.push({ x: RING_MIN, y });
    ring.push({ x: RING_MAX, y });
  }
  if (kind === "partial-ring") {
    return ring.filter((point) => !(point.y === RING_MAX && (point.x === 31 || point.x === 32)));
  }
  return ring;
}

function makeSlots(kind: CorridorTemplateKind): CorridorSlot[] {
  const slots: CorridorSlot[] = [
    { id: "north-west", anchor: { x: 15, y: 2 }, width: 9, height: 13 },
    { id: "north-east", anchor: { x: 25, y: 6 }, width: 13, height: 9 },
    { id: "east-north", anchor: { x: 49, y: 15 }, width: 10, height: 12 },
    { id: "east-south", anchor: { x: 49, y: 28 }, width: 12, height: 10 },
    { id: "south-east", anchor: { x: 36, y: 49 }, width: 8, height: 12 },
    { id: "south-west", anchor: { x: 23, y: 49 }, width: 12, height: 8 },
    { id: "west-south", anchor: { x: 2, y: 36 }, width: 13, height: 8 },
    { id: "west-north", anchor: { x: 7, y: 23 }, width: 8, height: 13 },
  ];
  return kind === "partial-ring"
    ? slots.filter(({ id }) => !id.startsWith("south"))
    : slots;
}

export function createCorridorTemplate(kind: CorridorTemplateKind): CorridorTemplate {
  return {
    id: kind,
    name: kind === "complete-ring" ? "完整方形环廊" : "南侧开口环廊",
    width: 64,
    height: 64,
    core: makeCore(),
    corridor: makeRing(kind),
    entrances: Array.from({ length: CORE_MIN - RING_MIN - 1 }, (_, index) => ({
      x: 31,
      y: RING_MIN + 1 + index,
    })),
    slots: makeSlots(kind),
  };
}

export function getTransformedRoomSize(
  cells: RoomVariant["cells"],
  rotation: RoomVariant["rotation"],
): { width: number; height: number } {
  if (cells.length === 0) throw new Error("客房变体没有可放置格子");
  const xs = cells.map(({ x }) => x);
  const ys = cells.map(({ y }) => y);
  const width = Math.max(...xs) - Math.min(...xs) + 1;
  const height = Math.max(...ys) - Math.min(...ys) + 1;
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

export function createRoomFootprint(
  slot: CorridorSlot,
  size: { width: number; height: number },
): RoomFootprint {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error("房间尺寸必须是正整数");
  }
  if (size.width > slot.width || size.height > slot.height) throw new Error("房间尺寸超出槽位");
  const cells: GridPoint[] = [];
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      cells.push({ x: slot.anchor.x + x, y: slot.anchor.y + y });
    }
  }
  return { slotId: slot.id, anchor: { ...slot.anchor }, width: size.width, height: size.height, cells };
}

function neighbors(point: GridPoint): GridPoint[] {
  return DIRECTIONS.map(({ x, y }) => ({ x: point.x + x, y: point.y + y }));
}

function isAdjacentTo(point: GridPoint, points: Set<string>): boolean {
  return neighbors(point).some((neighbor) => points.has(pointKey(neighbor)));
}

function connected(start: GridPoint, targets: Set<string>, traversable: Set<string>): boolean {
  const queue = [start];
  const seen = new Set<string>([pointKey(start)]);
  while (queue.length) {
    const current = queue.shift()!;
    if (targets.has(pointKey(current))) return true;
    for (const next of neighbors(current)) {
      const nextKey = pointKey(next);
      if (traversable.has(nextKey) && !seen.has(nextKey)) {
        seen.add(nextKey);
        queue.push(next);
      }
    }
  }
  return false;
}

export function validateCorridorTemplate(template: CorridorTemplate): CorridorValidation {
  const reasons: string[] = [];
  const core = new Set(template.core.map(pointKey));
  const corridor = new Set(template.corridor.map(pointKey));
  const entrances = new Set(template.entrances.map(pointKey));
  const traversable = new Set([...core, ...corridor, ...entrances]);
  const inBounds = ({x,y}:GridPoint) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < template.width && y < template.height;

  if (template.width <= 0 || template.height <= 0 || !Number.isInteger(template.width) || !Number.isInteger(template.height)) {
    reasons.push("模板尺寸必须是正整数");
  }
  if (!template.core.length || !template.corridor.length) reasons.push("核心筒和走廊不能为空");
  if ([...template.core,...template.corridor,...template.entrances].some(point=>!inBounds(point))) reasons.push("模板坐标超出边界");
  if (template.entrances.length === 0 || !template.entrances.some((entrance) => connected(entrance, core, traversable) && isAdjacentTo(entrance, corridor))) {
    reasons.push("入口未连接核心筒与走廊");
  }

  const occupied = new Set([...core, ...corridor]);
  const slotIds = new Set<string>();
  for (const slot of template.slots) {
    if (!slotIds.add(slot.id)) reasons.push(`槽位 ${slot.id} 编号重复`);
    if (!Number.isInteger(slot.width) || !Number.isInteger(slot.height) || slot.width <= 0 || slot.height <= 0) {
      reasons.push(`槽位 ${slot.id} 尺寸无效`);
      continue;
    }
    const footprint = createRoomFootprint(slot, slot);
    if (footprint.cells.some(cell=>!inBounds(cell))) reasons.push(`槽位 ${slot.id} 超出模板边界`);
    const overlap = footprint.cells.some((cell) => occupied.has(pointKey(cell)));
    if (overlap) reasons.push(`槽位 ${slot.id} 与核心筒或走廊重叠`);
    if (!footprint.cells.some((cell) => isAdjacentTo(cell, corridor))) reasons.push(`槽位 ${slot.id} 未连接走廊`);
    footprint.cells.forEach(cell=>occupied.add(pointKey(cell)));
  }

  if (template.corridor.length) {
    const seen = new Set<string>([pointKey(template.corridor[0])]);
    const queue = [template.corridor[0]];
    while (queue.length) {
      for (const next of neighbors(queue.shift()!)) {
        const nextKey = pointKey(next);
        if (corridor.has(nextKey) && !seen.has(nextKey)) {
          seen.add(nextKey);
          queue.push(next);
        }
      }
    }
    if (seen.size !== corridor.size) reasons.push("走廊存在不连通区段");
  }
  return { ok: reasons.length === 0, reasons };
}

function shortestPathDistances(template: CorridorTemplate): Map<string, number> {
  const corridor = new Set(template.corridor.map(pointKey));
  const queue: GridPoint[] = [];
  const distances = new Map<string, number>();
  for (const entrance of template.entrances) {
    for (const next of [entrance, ...neighbors(entrance)]) {
      const nextKey = pointKey(next);
      if (corridor.has(nextKey) && !distances.has(nextKey)) {
        distances.set(nextKey, 0);
        queue.push(next);
      }
    }
  }
  while (queue.length) {
    const current = queue.shift()!;
    const currentDistance = distances.get(pointKey(current))!;
    for (const next of neighbors(current)) {
      const nextKey = pointKey(next);
      if (corridor.has(nextKey) && !distances.has(nextKey)) {
        distances.set(nextKey, currentDistance + 1);
        queue.push(next);
      }
    }
  }
  return distances;
}

export function analyzeCorridorTemplate(
  template: CorridorTemplate,
  options: CorridorAnalysisOptions = {},
): CorridorAnalysis {
  const serviceDistanceWarning = options.serviceDistanceWarning ?? 16;
  const congestionWarning = options.congestionWarning ?? 6;
  const corridor = new Set(template.corridor.map(pointKey));
  const distances = shortestPathDistances(template);
  const serviceDistances: Record<string, number> = {};
  const routeUsage = new Map<string, number>();

  for (const slot of template.slots) {
    const footprint = createRoomFootprint(slot, slot);
    const access = footprint.cells
      .flatMap((cell) => neighbors(cell))
      .filter((neighbor) => corridor.has(pointKey(neighbor)));
    const distance = access.reduce((best, point) => Math.min(best, (distances.get(pointKey(point)) ?? Number.POSITIVE_INFINITY) + 1), Number.POSITIVE_INFINITY);
    serviceDistances[slot.id] = Number.isFinite(distance) ? distance : -1;
    const chosen = access
      .filter((point) => distances.has(pointKey(point)))
      .sort((a, b) => distances.get(pointKey(a))! - distances.get(pointKey(b))! || a.y - b.y || a.x - b.x)[0];
    if (chosen) {
      let current = chosen;
      while (true) {
        const currentKey = pointKey(current);
        routeUsage.set(currentKey, (routeUsage.get(currentKey) ?? 0) + 1);
        const currentDistance = distances.get(currentKey)!;
        if (currentDistance === 0) break;
        const previous = neighbors(current)
          .filter((point) => distances.get(pointKey(point)) === currentDistance - 1)
          .sort((a, b) => a.y - b.y || a.x - b.x)[0];
        if (!previous) break;
        current = previous;
      }
    }
  }

  const maxCongestion = Math.max(0, ...routeUsage.values());
  const hints: CorridorHint[] = [];
  for (const slot of template.slots) {
    const value = serviceDistances[slot.id];
    if (value >= serviceDistanceWarning) hints.push({ kind: "service-distance", severity: "warning", advisory: true, slotId: slot.id, value, message: `${slot.id} 距服务入口 ${value} 格` });
  }
  if (maxCongestion >= congestionWarning) hints.push({ kind: "congestion", severity: "warning", advisory: true, value: maxCongestion, message: `入口附近预计有 ${maxCongestion} 条服务动线重叠` });
  const corridorUsage = Object.fromEntries(
    [...routeUsage.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return { serviceDistances, corridorUsage, maxCongestion, hints };
}
