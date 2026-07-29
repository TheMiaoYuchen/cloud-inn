import type { HotelFloor, ScaleFloorTemplate } from "../building/buildingTypes";
import type { GameState } from "../game/state";
import { calculateServiceCapacity, type ServiceBottleneck } from "../operations/serviceCapacity";

export type FlowProjectionKind =
  | "guest"
  | "staff"
  | "luggage"
  | "cleaning"
  | "room-service";

export interface FlowProjectionEvent {
  id: string;
  kind: FlowProjectionKind;
  label: string;
  count: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
}

export interface FlowProjectionSnapshot {
  day: number;
  floorId: string;
  width: number;
  height: number;
  events: readonly FlowProjectionEvent[];
}

const WORLD_SCALE = 10;
const MAX_PROJECTED_EVENTS = 150;

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function templateForFloor(state: GameState, floor: HotelFloor): ScaleFloorTemplate | undefined {
  return state.phase4?.floorTemplates[`template-snapshot:${floor.id}`]
    ?? state.phase4?.floorTemplates[floor.templateId];
}

function center(columns: number, rows: number) {
  return { x: columns * WORLD_SCALE / 2, y: rows * WORLD_SCALE / 2 };
}

function boundedCount(value: number): number {
  if (value <= 0) return 0;
  return Math.min(999, Math.max(1, Math.round(value)));
}

function flowLabel(base: string, bottleneck: ServiceBottleneck | undefined): string {
  return bottleneck ? `${base} · 部门瓶颈` : base;
}

function bottleneckFlowCount(
  baseline: number,
  demand: number,
  bottleneck: ServiceBottleneck | undefined,
): number {
  return boundedCount(bottleneck
    ? Math.ceil(demand * (10_000 - bottleneck.capacityBps) / 10_000)
    : baseline);
}

export function projectFlowSnapshot(
  state: Readonly<GameState>,
  floorId: string,
): FlowProjectionSnapshot {
  const phase4 = state.phase4;
  const floor = phase4?.floors.find((candidate) => candidate.id === floorId);
  const template = floor && phase4 ? templateForFloor(state, floor) : undefined;
  const width = Math.max(1, (template?.columns ?? 1) * WORLD_SCALE);
  const height = Math.max(1, (template?.rows ?? 1) * WORLD_SCALE);
  const empty = { day: state.currentDay, floorId, width, height, events: [] as FlowProjectionEvent[] };
  if (!phase4 || !floor?.purchased || !phase4.building.purchasedFloorIds.includes(floor.id) || !template) {
    return empty;
  }

  const lift = center(template.columns, template.rows);
  const latestReport = [...(state.operations?.dailyReports ?? [])]
    .filter((report) => report.day <= state.currentDay)
    .sort((left, right) => right.day - left.day)[0];
  const bookings = latestReport?.bookings ?? [];
  const bookingByRoom = new Map(bookings.flatMap((booking) => [
    [booking.roomId, booking],
    [booking.offerId, booking],
  ]));
  const placements = new Map(template.roomPlacements.map((placement) => [placement.id, placement]));
  const housekeeping = state.operations?.departments.housekeeping;
  const foodAndBeverage = state.operations?.departments.foodAndBeverage;
  const frontOffice = state.operations?.departments.frontOffice;
  const occupiedRooms = Math.max(0, latestReport?.soldRooms ?? bookings.length);
  const availableRooms = Math.max(
    occupiedRooms,
    latestReport?.availableRooms ?? phase4.floors.reduce((total, item) => total + item.rooms.length, 0),
  );
  const bottleneckByDepartment = new Map(
    state.operations
      ? calculateServiceCapacity(state.operations.departments, { occupiedRooms, availableRooms })
        .bottlenecks.map((bottleneck) => [bottleneck.departmentId, bottleneck])
      : [],
  );
  const housekeepingBottleneck = bottleneckByDepartment.get("housekeeping");
  const foodBottleneck = bottleneckByDepartment.get("foodAndBeverage");
  const frontOfficeBottleneck = bottleneckByDepartment.get("frontOffice");
  const events: FlowProjectionEvent[] = [];

  for (const room of floor.rooms) {
    const booking = bookingByRoom.get(room.id);
    const placement = placements.get(room.localPlacementId);
    if (!booking || !placement) continue;
    const roomCenter = {
      x: (placement.anchorX + placement.width / 2) * WORLD_SCALE,
      y: (placement.anchorY + placement.height / 2) * WORLD_SCALE,
    };
    const suffix = `${room.id}:${booking.segmentId}`;
    events.push(
      { id: `flow:guest:${suffix}`, kind: "guest", label: "入住宾客", count: 1, ...lift, targetX: roomCenter.x, targetY: roomCenter.y },
      { id: `flow:luggage:${suffix}`, kind: "luggage", label: "抵店行李", count: 1, ...lift, targetX: roomCenter.x, targetY: roomCenter.y },
      { id: `flow:cleaning:${suffix}`, kind: "cleaning", label: flowLabel("客房清洁", housekeepingBottleneck), count: bottleneckFlowCount((housekeeping?.staffing ?? 1) / Math.max(1, bookings.length), bookings.length, housekeepingBottleneck), x: roomCenter.x, y: roomCenter.y, targetX: lift.x, targetY: lift.y },
      { id: `flow:room-service:${suffix}`, kind: "room-service", label: flowLabel("客房送餐", foodBottleneck), count: bottleneckFlowCount((foodAndBeverage?.staffing ?? 1) / Math.max(1, bookings.length), bookings.length, foodBottleneck), ...lift, targetX: roomCenter.x, targetY: roomCenter.y },
    );
  }

  if (events.length > 0) {
    events.push({
      id: `flow:staff:${floor.id}`,
      kind: "staff",
      label: flowLabel("楼层服务员工", frontOfficeBottleneck),
      count: bottleneckFlowCount(frontOffice?.staffing ?? 1, occupiedRooms, frontOfficeBottleneck),
      x: lift.x,
      y: lift.y,
      targetX: Math.min(width, lift.x + WORLD_SCALE),
      targetY: lift.y,
    });
  }

  const slots = new Map(template.publicSpaceSlots.map((slot) => [slot.id, slot]));
  for (const publicSpaceId of floor.publicSpaceInstanceIds) {
    const space = phase4.publicSpaces[publicSpaceId];
    const facility = Object.values(phase4.facilities)
      .find((candidate) => candidate.publicSpaceInstanceId === publicSpaceId);
    const slot = space ? slots.get(space.localPlacementId) : undefined;
    const result = facility?.dailyResults
      .filter((candidate) => candidate.day <= state.currentDay)
      .sort((left, right) => right.day - left.day)[0];
    if (!space || !facility || !slot || !result || slot.anchorX === undefined || slot.anchorY === undefined) continue;
    const destination = {
      x: (slot.anchorX + (slot.width ?? 1) / 2) * WORLD_SCALE,
      y: (slot.anchorY + (slot.height ?? 1) / 2) * WORLD_SCALE,
    };
    const visitorCount = boundedCount(result.visits);
    const staffCount = boundedCount((facility.policy?.capacity ?? 1) * result.utilizationBps / 10_000);
    if (visitorCount > 0) events.push(
      { id: `flow:guest:${facility.id}`, kind: "guest", label: "设施访客", count: visitorCount, ...lift, targetX: destination.x, targetY: destination.y },
    );
    if (staffCount > 0) events.push(
      { id: `flow:staff:${facility.id}`, kind: "staff", label: "设施服务员工", count: staffCount, x: destination.x, y: destination.y, targetX: lift.x, targetY: lift.y },
    );
  }

  const samplingSeed = `${state.saveId}:${state.currentDay}:${floor.id}`;
  const sampled = events
    .sort((left, right) => {
      const hashDelta = stableHash(`${samplingSeed}:${left.id}`) - stableHash(`${samplingSeed}:${right.id}`);
      return hashDelta || left.id.localeCompare(right.id);
    })
    .slice(0, MAX_PROJECTED_EVENTS);

  return { day: state.currentDay, floorId, width, height, events: sampled };
}
