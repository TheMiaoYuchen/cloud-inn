import { projectContentUnlocks, reconcileCatalogProgress } from "../content/contentUnlocks";
import { FLOOR_TEMPLATE_CATALOG, TOWER_CATALOG } from "../content/contentCatalog";
import { createDenseGuestFloorTemplate } from "../floor/corridorTemplate";
import type { GameState, RoomInstance } from "../game/state";
import { assertSafeMoney } from "../primitives";
import {
  assertFloorCount,
  assertRoomCount,
  assertStableId,
  type ContentScaleState,
  type HotelFloor,
  type ScaleFloorTemplate,
  type ScaleRoomInstance,
  type ScaleRoomPlacement,
  type StableId,
} from "./buildingTypes";

const FIRST_TOWER_ID = TOWER_CATALOG[0].id;
const GUEST_TEMPLATE_ID = FLOOR_TEMPLATE_CATALOG[0].id;
const EXPANSION_COST_CENTS = assertSafeMoney(25_000_000);
const MAXIMUM_TOWER_FLOOR = 64;

export interface ExpansionPreview {
  floorNumber: number;
  costCents: number;
  available: boolean;
  reason: "available" | "phase4-required" | "already-purchased" | "not-offered";
}

export interface FloorCopyResult {
  phase4: ContentScaleState;
  floor: HotelFloor;
}

export interface TemplateSyncPreview {
  floorId: StableId;
  templateId: StableId;
  previousRoomCount: number;
  nextRoomCount: number;
  changed: boolean;
}

function floorId(floorNumber: number): StableId {
  return assertStableId(`floor:${floorNumber}`);
}

function assertFloorNumber(floorNumber: number): void {
  if (!Number.isInteger(floorNumber) || floorNumber < 1 || floorNumber > MAXIMUM_TOWER_FLOOR) {
    throw new Error(`楼层编号必须是 1-${MAXIMUM_TOWER_FLOOR} 之间的整数`);
  }
}

function emptyTemplate(id: string, use: ScaleFloorTemplate["use"]): ScaleFloorTemplate {
  return {
    id: assertStableId(id),
    use,
    columns: 24,
    rows: 24,
    cellAreaSquareMeters: 1,
    roomPlacements: [],
    publicSpaceSlots: [],
  };
}

function availableExpansionFloorNumbers(firstUnownedFloor: number): number[] {
  return Array.from(
    { length: Math.max(0, MAXIMUM_TOWER_FLOOR - firstUnownedFloor + 1) },
    (_, index) => firstUnownedFloor + index,
  );
}

function cloneRoom(room: ScaleRoomInstance): ScaleRoomInstance {
  return { ...room };
}

function cloneFloor(floor: HotelFloor): HotelFloor {
  return {
    ...floor,
    rooms: floor.rooms.map(cloneRoom),
    publicSpaceInstanceIds: [...floor.publicSpaceInstanceIds],
  };
}

function roomId(targetFloorId: StableId, localPlacementId: StableId): StableId {
  return assertStableId(`room:${targetFloorId}:${localPlacementId}`);
}

function roomsForTemplate(
  targetFloorId: StableId,
  template: Readonly<ScaleFloorTemplate>,
  previousRooms: readonly ScaleRoomInstance[] = [],
): ScaleRoomInstance[] {
  const previousByPlacement = new Map(
    previousRooms.map((room) => [room.localPlacementId, room]),
  );
  return template.roomPlacements.map((placement) => {
    const previous = previousByPlacement.get(placement.id);
    return {
      id: roomId(targetFloorId, placement.id),
      floorId: targetFloorId,
      localPlacementId: placement.id,
      roomBlueprintId: placement.roomBlueprintId,
      ...(placement.variantId === undefined ? {} : { variantId: placement.variantId }),
      committedBuildCostCents:
        previous?.roomBlueprintId === placement.roomBlueprintId &&
        previous.variantId === placement.variantId
          ? previous.committedBuildCostCents
          : 0,
    };
  });
}

function placementDimensions(areaSquareMeters: number): { width: number; height: number } {
  if (!Number.isSafeInteger(areaSquareMeters) || areaSquareMeters <= 0) {
    throw new Error("客房设计面积必须是正安全整数平方米");
  }
  for (let height = Math.floor(Math.sqrt(areaSquareMeters)); height >= 1; height -= 1) {
    if (areaSquareMeters % height === 0) {
      const width = areaSquareMeters / height;
      return width >= height ? { width: height, height: width } : { width, height };
    }
  }
  throw new Error("客房设计面积无法映射到整数格");
}

function authoritativeRoomArea(state: Readonly<GameState>, room: Readonly<RoomInstance>): number {
  if (state.roomBlueprint?.id === room.roomBlueprintId) {
    return state.roomBlueprint.metrics.areaSquareMeters;
  }
  if (state.phase2?.roomMaster?.id === room.roomBlueprintId) {
    return state.phase2.roomMaster.metrics.areaSquareMeters;
  }
  const variant = state.phase2?.roomVariants.find(({ id }) => id === room.roomBlueprintId);
  if (variant?.metrics) return variant.metrics.areaSquareMeters;
  throw new Error(`找不到客房 ${room.id} 的权威设计`);
}

function createLegacyGuestTemplate(state: Readonly<GameState>): ScaleFloorTemplate {
  const dense = createDenseGuestFloorTemplate({ floorId: "floor:4", slotsPerSide: 8 });
  const stableLegacyRooms = state.floor.rooms
    .map((room) => ({ room, stableSlotId: assertStableId(room.slotId) }))
    .sort((left, right) => left.stableSlotId.localeCompare(right.stableSlotId));
  if (new Set(stableLegacyRooms.map(({ stableSlotId }) => stableSlotId)).size !== stableLegacyRooms.length) {
    throw new Error("旧酒店客房槽位编号重复");
  }
  const roomPlacements: ScaleRoomPlacement[] = stableLegacyRooms.map(({ room, stableSlotId }, index) => {
    const dimensions = placementDimensions(authoritativeRoomArea(state, room));
    const slot = dense.slots[index];
    if (!slot) throw new Error("旧酒店客房超过首层模板容量");
    const rotated = slot.width > slot.height;
    const width = rotated ? dimensions.height : dimensions.width;
    const height = rotated ? dimensions.width : dimensions.height;
    if (width > slot.width || height > slot.height) {
      throw new Error(`客房 ${room.id} 的真实尺寸超出高密度槽位`);
    }
    return {
      id: stableSlotId,
      roomBlueprintId: assertStableId(room.roomBlueprintId),
      anchorX: slot.anchor.x,
      anchorY: slot.anchor.y,
      width,
      height,
      rotation: rotated ? 90 : 0,
      mirrored: false,
    };
  });
  return {
    id: GUEST_TEMPLATE_ID,
    use: "guest",
    columns: dense.width,
    rows: dense.height,
    cellAreaSquareMeters: 1,
    roomPlacements,
    publicSpaceSlots: [],
  };
}

function legacyRoomsForFloor(
  state: Readonly<GameState>,
  targetFloorId: StableId,
  template: Readonly<ScaleFloorTemplate>,
): ScaleRoomInstance[] {
  const legacyBySlot = new Map(
    state.floor.rooms.map((room) => [assertStableId(room.slotId), room]),
  );
  return template.roomPlacements.map((placement) => {
    const legacyRoom = legacyBySlot.get(placement.id);
    if (!legacyRoom) throw new Error(`找不到旧酒店槽位：${placement.id}`);
    return {
      id: roomId(targetFloorId, placement.id),
      floorId: targetFloorId,
      localPlacementId: placement.id,
      roomBlueprintId: placement.roomBlueprintId,
      committedBuildCostCents: assertSafeMoney(
        legacyRoom.committedBuildCostCents,
      ),
    };
  });
}

export function projectScaleRooms(state: Readonly<GameState>): readonly ScaleRoomInstance[] {
  return state.phase4?.floors.flatMap(({ rooms }) => rooms) ?? [];
}

export function upgradeLegacyToPhase4(state: Readonly<GameState>): GameState {
  if (state.phase4) return state as GameState;
  assertRoomCount(state.floor.rooms.length);
  const guestTemplate = createLegacyGuestTemplate(state);
  const entranceTemplate = emptyTemplate("template:entrance:standard", "entrance");
  const skyLobbyTemplate = emptyTemplate("template:sky-lobby:standard", "sky-lobby");
  const serviceTemplate = emptyTemplate("template:service:standard", "service");
  const entranceFloorId = floorId(1);
  const skyLobbyFloorId = floorId(2);
  const serviceFloorId = floorId(3);
  const guestFloorId = floorId(4);
  const floors: HotelFloor[] = [
    { id: entranceFloorId, floorNumber: 1, use: "entrance", templateId: entranceTemplate.id, purchased: true, rooms: [], publicSpaceInstanceIds: [] },
    { id: skyLobbyFloorId, floorNumber: 2, use: "sky-lobby", templateId: skyLobbyTemplate.id, purchased: true, rooms: [], publicSpaceInstanceIds: [] },
    { id: serviceFloorId, floorNumber: 3, use: "service", templateId: serviceTemplate.id, purchased: true, rooms: [], publicSpaceInstanceIds: [] },
    { id: guestFloorId, floorNumber: 4, use: "guest", templateId: guestTemplate.id, purchased: true, rooms: legacyRoomsForFloor(state, guestFloorId, guestTemplate), publicSpaceInstanceIds: [] },
  ];
  assertFloorCount(floors.length);
  const phase4: ContentScaleState = {
    rulesetVersion: "content-scale-v1",
    building: {
      templateId: FIRST_TOWER_ID,
      entranceFloorId,
      skyLobbyFloorIds: [skyLobbyFloorId],
      purchasedFloorIds: floors.map(({ id }) => id),
      availableExpansionFloorNumbers: availableExpansionFloorNumbers(5),
    },
    floorTemplates: Object.fromEntries(
      [entranceTemplate, skyLobbyTemplate, serviceTemplate, guestTemplate]
        .map((template) => [template.id, template]),
    ),
    floors,
    spaceBlueprints: {},
    publicSpaces: {},
    facilities: {},
    catalogProgress: { unlockedIds: [], discoveredMarketEntryIds: [] },
    recentFlowSnapshot: null,
  };
  const withPhase4: GameState = { ...state, phase4 };
  return {
    ...withPhase4,
    phase4: reconcileCatalogProgress(phase4, projectContentUnlocks(withPhase4)),
  };
}

export function previewExpansion(
  state: Readonly<GameState>,
  floorNumber: number,
): ExpansionPreview {
  assertFloorNumber(floorNumber);
  if (!state.phase4) {
    return { floorNumber, costCents: EXPANSION_COST_CENTS, available: false, reason: "phase4-required" };
  }
  if (state.phase4.floors.some((floor) => floor.floorNumber === floorNumber)) {
    return { floorNumber, costCents: EXPANSION_COST_CENTS, available: false, reason: "already-purchased" };
  }
  const available = state.phase4.building.availableExpansionFloorNumbers.includes(floorNumber);
  return {
    floorNumber,
    costCents: EXPANSION_COST_CENTS,
    available,
    reason: available ? "available" : "not-offered",
  };
}

export function copyGuestFloor(
  state: Readonly<ContentScaleState>,
  sourceFloorId: string,
  floorNumber: number,
): FloorCopyResult {
  assertFloorNumber(floorNumber);
  const stableSourceFloorId = assertStableId(sourceFloorId);
  const source = state.floors.find(
    (floor) => floor.id === stableSourceFloorId && floor.use === "guest",
  );
  if (!source) throw new Error("找不到源客房楼层");
  if (state.floors.some((floor) => floor.floorNumber === floorNumber)) throw new Error("目标楼层已存在");
  const targetFloorId = floorId(floorNumber);
  if (state.floors.some(({ id }) => id === targetFloorId)) throw new Error("目标楼层编号重复");
  const floor: HotelFloor = {
    ...source,
    id: targetFloorId,
    floorNumber,
    rooms: source.rooms.map((room) => ({
      ...room,
      id: roomId(targetFloorId, room.localPlacementId),
      floorId: targetFloorId,
    })),
    publicSpaceInstanceIds: [],
  };
  const floors = [...state.floors.map(cloneFloor), floor]
    .sort((left, right) => left.floorNumber - right.floorNumber || left.id.localeCompare(right.id));
  assertFloorCount(floors.length);
  assertRoomCount(floors.reduce((total, candidate) => total + candidate.rooms.length, 0));
  return {
    floor,
    phase4: {
      ...state,
      building: {
        ...state.building,
        purchasedFloorIds: [...state.building.purchasedFloorIds, targetFloorId]
          .sort((left, right) => left.localeCompare(right)),
        availableExpansionFloorNumbers: state.building.availableExpansionFloorNumbers
          .filter((candidate) => candidate !== floorNumber),
      },
      floors,
    },
  };
}

export function applyExpansion(
  state: Readonly<ContentScaleState>,
  floorNumber: number,
): { phase4: ContentScaleState; costCents: number } {
  assertFloorNumber(floorNumber);
  if (!state.building.availableExpansionFloorNumbers.includes(floorNumber) || state.floors.some((floor) => floor.floorNumber === floorNumber)) {
    throw new Error("该楼层不可扩建");
  }
  const source = [...state.floors]
    .filter(({ use }) => use === "guest")
    .sort((left, right) => left.floorNumber - right.floorNumber)[0];
  if (!source) throw new Error("扩建前必须存在客房模板楼层");
  return {
    phase4: copyGuestFloor(state, source.id, floorNumber).phase4,
    costCents: EXPANSION_COST_CENTS,
  };
}

function roomSnapshotMatchesTemplate(
  floor: Readonly<HotelFloor>,
  template: Readonly<ScaleFloorTemplate>,
): boolean {
  const roomsByPlacement = new Map(
    floor.rooms.map((room) => [room.localPlacementId, room]),
  );
  return roomsByPlacement.size === template.roomPlacements.length &&
    template.roomPlacements.every((placement) => {
      const room = roomsByPlacement.get(placement.id);
      return room?.localPlacementId === placement.id &&
        room.roomBlueprintId === placement.roomBlueprintId &&
        room.variantId === placement.variantId;
    });
}

export function previewTemplateSync(
  state: Readonly<ContentScaleState>,
  templateId: string,
): TemplateSyncPreview[] {
  const stableTemplateId = assertStableId(templateId);
  const template = state.floorTemplates[stableTemplateId];
  if (!template) throw new Error("未知楼层模板");
  return state.floors
    .filter((floor) => floor.templateId === stableTemplateId)
    .sort((left, right) => left.floorNumber - right.floorNumber || left.id.localeCompare(right.id))
    .map((floor) => ({
      floorId: floor.id,
      templateId: stableTemplateId,
      previousRoomCount: floor.rooms.length,
      nextRoomCount: template.roomPlacements.length,
      changed: !roomSnapshotMatchesTemplate(floor, template),
    }));
}

export function applyTemplateSync(
  state: Readonly<ContentScaleState>,
  selectedFloorIds: readonly string[],
): ContentScaleState {
  const selected = new Set(selectedFloorIds.map(assertStableId));
  for (const selectedFloorId of selected) {
    if (!state.floors.some(({ id }) => id === selectedFloorId)) throw new Error(`未知楼层：${selectedFloorId}`);
  }
  const floors = state.floors.map((floor) => {
    if (!selected.has(floor.id)) return cloneFloor(floor);
    const template = state.floorTemplates[floor.templateId];
    if (!template) throw new Error(`楼层 ${floor.id} 引用了未知模板`);
    if (floor.use !== "guest" || template.use !== "guest") throw new Error("仅客房楼层可以同步模板");
    return {
      ...floor,
      rooms: roomsForTemplate(floor.id, template, floor.rooms),
      publicSpaceInstanceIds: [...floor.publicSpaceInstanceIds],
    };
  });
  assertRoomCount(floors.reduce((total, floor) => total + floor.rooms.length, 0));
  return { ...state, floors };
}
