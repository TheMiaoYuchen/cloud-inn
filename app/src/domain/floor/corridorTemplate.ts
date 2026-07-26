import type {
  CorridorSlot,
  CorridorTemplate,
  GridPoint,
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

const CORE_MIN = 14;
const CORE_MAX = 21;
const RING_MIN = 11;
const RING_MAX = 24;
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
    return ring.filter((point) => !(point.y === RING_MAX && (point.x === 17 || point.x === 18)));
  }
  return ring;
}

function makeSlots(kind: CorridorTemplateKind): CorridorSlot[] {
  const slots: CorridorSlot[] = [
    { id: "north-west", anchor: { x: 11, y: 3 }, width: 8, height: 8 },
    { id: "north-east", anchor: { x: 19, y: 1 }, width: 9, height: 10 },
    { id: "east-north", anchor: { x: 25, y: 11 }, width: 8, height: 8 },
    { id: "east-south", anchor: { x: 25, y: 19 }, width: 10, height: 8 },
    { id: "south-east", anchor: { x: 17, y: 25 }, width: 8, height: 10 },
    { id: "south-west", anchor: { x: 6, y: 25 }, width: 11, height: 7 },
    { id: "west-south", anchor: { x: 1, y: 17 }, width: 10, height: 7 },
    { id: "west-north", anchor: { x: 1, y: 8 }, width: 10, height: 8 },
  ];
  return kind === "partial-ring"
    ? slots.filter(({ id }) => !id.startsWith("south"))
    : slots;
}

export function createCorridorTemplate(kind: CorridorTemplateKind): CorridorTemplate {
  return {
    id: kind,
    name: kind === "complete-ring" ? "完整方形环廊" : "南侧开口环廊",
    width: 36,
    height: 36,
    core: makeCore(),
    corridor: makeRing(kind),
    entrances: [
      { x: 17, y: 12 },
      { x: 17, y: 13 },
    ],
    slots: makeSlots(kind),
  };
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

  if (template.width <= 0 || template.height <= 0 || !Number.isInteger(template.width) || !Number.isInteger(template.height)) {
    reasons.push("模板尺寸必须是正整数");
  }
  if (!template.core.length || !template.corridor.length) reasons.push("核心筒和走廊不能为空");
  if (template.entrances.length === 0 || !template.entrances.some((entrance) => connected(entrance, core, traversable) && isAdjacentTo(entrance, corridor))) {
    reasons.push("入口未连接核心筒与走廊");
  }

  const occupied = new Set([...core, ...corridor]);
  for (const slot of template.slots) {
    if (!Number.isInteger(slot.width) || !Number.isInteger(slot.height) || slot.width <= 0 || slot.height <= 0) {
      reasons.push(`槽位 ${slot.id} 尺寸无效`);
      continue;
    }
    const footprint = createRoomFootprint(slot, slot);
    const overlap = footprint.cells.some((cell) => occupied.has(pointKey(cell)));
    if (overlap) reasons.push(`槽位 ${slot.id} 与核心筒或走廊重叠`);
    if (!footprint.cells.some((cell) => isAdjacentTo(cell, corridor))) reasons.push(`槽位 ${slot.id} 未连接走廊`);
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
