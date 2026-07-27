import type {
  FacilityState,
  PublicSpaceBlueprint,
  PublicSpaceInstance,
} from "../facilities/facilityTypes";

export type FloorUse =
  | "entrance"
  | "sky-lobby"
  | "guest"
  | "facility"
  | "service";

export type StableId = string & { readonly __stableId: unique symbol };
export type FloorCount = number & { readonly __floorCount: unique symbol };
export type RoomCount = number & { readonly __roomCount: unique symbol };
export type PublicSpaceCount = number & {
  readonly __publicSpaceCount: unique symbol;
};

const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9:-]{0,95}$/;

export function assertStableId(value: string): StableId {
  if (!STABLE_ID_PATTERN.test(value)) {
    throw new Error("稳定 ID 必须使用小写 ASCII 字母、数字、冒号或连字符");
  }

  return value as StableId;
}

function assertBoundedCount(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}数量必须是 ${minimum}-${maximum} 之间的整数`);
  }

  return value;
}

export function assertFloorCount(value: number): FloorCount {
  return assertBoundedCount(value, 1, 64, "楼层") as FloorCount;
}

export function assertRoomCount(value: number): RoomCount {
  return assertBoundedCount(value, 0, 240, "客房") as RoomCount;
}

export function assertPublicSpaceCount(value: number): PublicSpaceCount {
  return assertBoundedCount(value, 0, 32, "公共空间") as PublicSpaceCount;
}

export interface ScaleRoomInstance {
  id: StableId;
  floorId: StableId;
  localPlacementId: StableId;
  roomBlueprintId: StableId;
  variantId?: StableId;
  committedBuildCostCents: number;
}

export interface HotelFloor {
  id: StableId;
  floorNumber: number;
  use: FloorUse;
  templateId: StableId;
  purchased: boolean;
  rooms: ScaleRoomInstance[];
  publicSpaceInstanceIds: StableId[];
}

export interface ScaleRoomPlacement {
  id: StableId;
  roomBlueprintId: StableId;
  variantId?: StableId;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
}

export interface ScalePublicSpaceSlot {
  id: StableId;
  permittedTypes: PublicSpaceInstance["type"][];
}

export interface ScaleFloorTemplate {
  id: StableId;
  use: FloorUse;
  columns: number;
  rows: number;
  cellAreaSquareMeters: 1;
  roomPlacements: ScaleRoomPlacement[];
  publicSpaceSlots: ScalePublicSpaceSlot[];
}

export interface TowerBuildingState {
  templateId: StableId;
  entranceFloorId: StableId;
  skyLobbyFloorIds: StableId[];
  purchasedFloorIds: StableId[];
  availableExpansionFloorNumbers: number[];
}

export interface CatalogProgress {
  unlockedIds: StableId[];
  discoveredMarketEntryIds: StableId[];
}

export interface FlowEvent {
  id: StableId;
  kind: "guest" | "staff" | "service";
  fromId: StableId;
  toId: StableId;
  count: number;
}

export interface FlowSnapshot {
  day: number;
  visibleFloorId: StableId;
  events: FlowEvent[];
}

export interface ContentScaleState {
  rulesetVersion: "content-scale-v1";
  building: TowerBuildingState;
  floorTemplates: Record<string, ScaleFloorTemplate>;
  floors: HotelFloor[];
  spaceBlueprints: Record<string, PublicSpaceBlueprint>;
  publicSpaces: Record<string, PublicSpaceInstance>;
  facilities: Record<string, FacilityState>;
  catalogProgress: CatalogProgress;
  recentFlowSnapshot: FlowSnapshot | null;
}
