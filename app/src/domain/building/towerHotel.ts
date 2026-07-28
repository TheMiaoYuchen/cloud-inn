import { projectContentUnlocks, reconcileCatalogProgress } from "../content/contentUnlocks";
import { FLOOR_TEMPLATE_CATALOG, TOWER_CATALOG } from "../content/contentCatalog";
import { prototypeConfig } from "../config/prototypeConfig";
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

function snapshotTemplateId(targetFloorId: StableId): StableId {
  return assertStableId(`template-snapshot:${targetFloorId}`);
}

function cloneTemplate(
  template: Readonly<ScaleFloorTemplate>,
  templateId: StableId = template.id,
): ScaleFloorTemplate {
  return {
    ...template,
    id: templateId,
    roomPlacements: template.roomPlacements.map((placement) => ({ ...placement })),
    publicSpaceSlots: template.publicSpaceSlots.map((slot) => ({
      ...slot,
      permittedTypes: [...slot.permittedTypes],
    })),
  };
}

function validateTemplateIdentity(
  template: Readonly<ScaleFloorTemplate>,
): void {
  const placementIds = new Set<StableId>();
  for (const placement of template.roomPlacements) {
    assertStableId(placement.id);
    if (!placementIds.add(placement.id)) {
      throw new Error(`模板 ${template.id} 的客房放置编号重复`);
    }
  }
}

function existingRoomIds(state: Readonly<ContentScaleState>): Set<StableId> {
  const roomIds = new Set<StableId>();
  for (const floor of state.floors) {
    for (const room of floor.rooms) {
      if (!roomIds.add(room.id)) throw new Error(`客房编号冲突：${room.id}`);
    }
  }
  return roomIds;
}

function validateGeneratedRooms(
  rooms: readonly ScaleRoomInstance[],
  occupiedRoomIds: Set<StableId>,
): void {
  for (const room of rooms) {
    if (!occupiedRoomIds.add(room.id)) throw new Error(`客房编号冲突：${room.id}`);
  }
}

function withGuestFloorSnapshots(
  state: Readonly<ContentScaleState>,
): Record<string, ScaleFloorTemplate> {
  const floorTemplates = Object.fromEntries(
    Object.entries(state.floorTemplates).map(([key, template]) => [
      key,
      cloneTemplate(template),
    ]),
  );
  for (const floor of state.floors) {
    if (floor.use !== "guest") continue;
    const appliedId = snapshotTemplateId(floor.id);
    if (floorTemplates[appliedId]) continue;
    const canonical = floorTemplates[floor.templateId];
    if (!canonical) throw new Error(`楼层 ${floor.id} 引用了未知模板`);
    floorTemplates[appliedId] = cloneTemplate(canonical, appliedId);
  }
  return floorTemplates;
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
  validateTemplateIdentity(template);
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

function phase3VariantDimensions(
  cells: ReadonlyArray<{ x: number; y: number }>,
  areaSquareMeters: number,
  rotation: ScaleRoomPlacement["rotation"],
): { width: number; height: number } {
  if (cells.length === 0) throw new Error("二期客房变体没有可迁移格子");
  const xs = cells.map(({ x }) => x);
  const ys = cells.map(({ y }) => y);
  const footprintWidth = Math.max(...xs) - Math.min(...xs) + 1;
  const footprintHeight = Math.max(...ys) - Math.min(...ys) + 1;
  const uniqueCells = new Set(cells.map(({ x, y }) => `${x},${y}`));
  if (uniqueCells.size !== cells.length || cells.length !== footprintWidth * footprintHeight) {
    throw new Error("二期客房变体必须是无重叠矩形才能迁移到 1 平方米网格");
  }
  if (cells.length * prototypeConfig.cellAreaSquareMeters !== areaSquareMeters) {
    throw new Error("二期客房变体面积与格子不一致");
  }
  const dimensions = placementDimensions(areaSquareMeters);
  return rotation === 90 || rotation === 270
    ? { width: dimensions.height, height: dimensions.width }
    : dimensions;
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
  const phase2Placements = new Map(
    (state.phase2?.floorPlacements ?? []).map((placement) => [placement.slotId, placement]),
  );
  if (
    phase2Placements.size > 0 &&
    stableLegacyRooms.some(({ room }) => !phase2Placements.has(room.slotId))
  ) {
    throw new Error("旧酒店客房的二期放置不完整");
  }
  const corridorSlots = new Map(
    (state.phase2?.corridorTemplate?.slots ?? []).map((slot) => [slot.id, slot]),
  );
  const roomPlacements: ScaleRoomPlacement[] = stableLegacyRooms.map(({ room, stableSlotId }, index) => {
    const phase2Placement = phase2Placements.get(room.slotId);
    if (phase2Placement) {
      const slot = corridorSlots.get(room.slotId);
      const variant = state.phase2?.roomVariants.find(
        ({ id }) => id === phase2Placement.variantId,
      );
      if (!slot || !variant) throw new Error(`旧酒店客房 ${room.id} 的二期放置引用无效`);
      const roomMaster = state.phase2?.roomMaster;
      if (
        !roomMaster ||
        variant.masterId !== roomMaster.id ||
        !state.roomBlueprint ||
        room.roomBlueprintId !== state.roomBlueprint.id ||
        !variant.metrics
      ) {
        throw new Error(`旧酒店客房 ${room.id} 的二期设计引用无效`);
      }
      const dimensions = phase3VariantDimensions(
        variant.cells,
        variant.metrics.areaSquareMeters,
        phase2Placement.rotation,
      );
      if (dimensions.width > slot.width || dimensions.height > slot.height) {
        throw new Error(`旧酒店客房 ${room.id} 的二期放置尺寸无效`);
      }
      return {
        id: stableSlotId,
        roomBlueprintId: assertStableId(roomMaster.id),
        variantId: assertStableId(phase2Placement.variantId),
        anchorX: slot.anchor.x,
        anchorY: slot.anchor.y,
        width: dimensions.width,
        height: dimensions.height,
        rotation: phase2Placement.rotation,
        mirrored: phase2Placement.mirrored,
      };
    }
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
      ...(placement.variantId === undefined ? {} : { variantId: placement.variantId }),
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
  phase4.floorTemplates[snapshotTemplateId(guestFloorId)] = cloneTemplate(
    guestTemplate,
    snapshotTemplateId(guestFloorId),
  );
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
  const canonicalTemplate = state.floorTemplates[source.templateId];
  if (!canonicalTemplate) throw new Error(`楼层 ${source.id} 引用了未知模板`);
  const sourcePlacementIds = canonicalTemplate.roomPlacements.map(({ id }) => id);
  if (new Set(sourcePlacementIds).size !== sourcePlacementIds.length) {
    throw new Error(`模板 ${canonicalTemplate.id} 的客房放置编号重复`);
  }
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
  const occupiedRoomIds = existingRoomIds(state);
  for (const room of floor.rooms) {
    if (occupiedRoomIds.has(room.id)) throw new Error(`客房编号冲突：${room.id}`);
    occupiedRoomIds.add(room.id);
  }
  const floors = [...state.floors.map(cloneFloor), floor]
    .sort((left, right) => left.floorNumber - right.floorNumber || left.id.localeCompare(right.id));
  assertFloorCount(floors.length);
  assertRoomCount(floors.reduce((total, candidate) => total + candidate.rooms.length, 0));
  const floorTemplates = withGuestFloorSnapshots(state);
  const sourceSnapshotId = snapshotTemplateId(source.id);
  const targetSnapshotId = snapshotTemplateId(targetFloorId);
  floorTemplates[targetSnapshotId] = cloneTemplate(
    floorTemplates[sourceSnapshotId],
    targetSnapshotId,
  );
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
      floorTemplates,
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

function placementSnapshotMatchesTemplate(
  applied: Readonly<ScaleFloorTemplate>,
  canonical: Readonly<ScaleFloorTemplate>,
): boolean {
  const appliedById = new Map(
    applied.roomPlacements.map((placement) => [placement.id, placement]),
  );
  return appliedById.size === canonical.roomPlacements.length &&
    canonical.roomPlacements.every((placement) => {
      const prior = appliedById.get(placement.id);
      return prior?.roomBlueprintId === placement.roomBlueprintId &&
        prior.variantId === placement.variantId &&
        prior.anchorX === placement.anchorX &&
        prior.anchorY === placement.anchorY &&
        prior.width === placement.width &&
        prior.height === placement.height &&
        prior.rotation === placement.rotation &&
        prior.mirrored === placement.mirrored;
    });
}

export function previewTemplateSync(
  state: Readonly<ContentScaleState>,
  templateId: string,
): TemplateSyncPreview[] {
  const stableTemplateId = assertStableId(templateId);
  const template = state.floorTemplates[stableTemplateId];
  if (!template) throw new Error("未知楼层模板");
  validateTemplateIdentity(template);
  return state.floors
    .filter((floor) => floor.templateId === stableTemplateId)
    .sort((left, right) => left.floorNumber - right.floorNumber || left.id.localeCompare(right.id))
    .map((floor) => {
      const applied =
        state.floorTemplates[snapshotTemplateId(floor.id)] ??
        cloneTemplate(template, snapshotTemplateId(floor.id));
      return {
        floorId: floor.id,
        templateId: stableTemplateId,
        previousRoomCount: applied.roomPlacements.length,
        nextRoomCount: template.roomPlacements.length,
        changed: !placementSnapshotMatchesTemplate(applied, template),
      };
    });
}

export function applyTemplateSync(
  state: Readonly<ContentScaleState>,
  selectedFloorIds: readonly string[],
): ContentScaleState {
  const selected = new Set(selectedFloorIds.map(assertStableId));
  if (selected.size === 0) return state;
  const occupiedRoomIds = new Set<StableId>();
  for (const floor of state.floors) {
    for (const room of floor.rooms) {
      if (occupiedRoomIds.has(room.id)) throw new Error(`客房编号冲突：${room.id}`);
      occupiedRoomIds.add(room.id);
    }
  }
  for (const selectedFloorId of selected) {
    const selectedFloor = state.floors.find(({ id }) => id === selectedFloorId);
    if (!selectedFloor) throw new Error(`未知楼层：${selectedFloorId}`);
    const selectedTemplate = state.floorTemplates[selectedFloor.templateId];
    if (!selectedTemplate) throw new Error(`楼层 ${selectedFloorId} 引用了未知模板`);
    const placementIds = selectedTemplate.roomPlacements.map(({ id }) => id);
    if (new Set(placementIds).size !== placementIds.length) {
      throw new Error(`模板 ${selectedTemplate.id} 的客房放置编号重复`);
    }
  }
  const floorTemplates = Object.fromEntries(
    Object.entries(state.floorTemplates).map(([key, template]) => [
      key,
      cloneTemplate(template),
    ]),
  );
  const floors = state.floors.map((floor) => {
    if (!selected.has(floor.id)) return cloneFloor(floor);
    const template = floorTemplates[floor.templateId];
    if (!template) throw new Error(`楼层 ${floor.id} 引用了未知模板`);
    if (floor.use !== "guest" || template.use !== "guest") throw new Error("仅客房楼层可以同步模板");
    const appliedId = snapshotTemplateId(floor.id);
    floorTemplates[appliedId] = cloneTemplate(template, appliedId);
    const rooms = roomsForTemplate(floor.id, template, floor.rooms);
    for (const previous of floor.rooms) occupiedRoomIds.delete(previous.id);
    validateGeneratedRooms(rooms, occupiedRoomIds);
    return {
      ...floor,
      rooms,
      publicSpaceInstanceIds: [...floor.publicSpaceInstanceIds],
    };
  });
  assertRoomCount(floors.reduce((total, floor) => total + floor.rooms.length, 0));
  return { ...state, floorTemplates, floors };
}
