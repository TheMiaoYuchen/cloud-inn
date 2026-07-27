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
  id: string;
  floorId: string;
  localPlacementId: string;
  roomBlueprintId: string;
  variantId?: string;
  committedBuildCostCents: number;
}

export interface HotelFloor {
  id: string;
  floorNumber: number;
  use: FloorUse;
  templateId: string;
  purchased: boolean;
  rooms: ScaleRoomInstance[];
  publicSpaceInstanceIds: string[];
}

export interface ScaleRoomPlacement {
  id: string;
  roomBlueprintId: string;
  variantId?: string;
}

export interface ScalePublicSpaceSlot {
  id: string;
  permittedTypes: PublicSpaceInstance["type"][];
}

export interface ScaleFloorTemplate {
  id: string;
  use: FloorUse;
  roomPlacements: ScaleRoomPlacement[];
  publicSpaceSlots: ScalePublicSpaceSlot[];
}

export interface TowerBuildingState {
  templateId: string;
  entranceFloorId: string;
  skyLobbyFloorIds: string[];
  purchasedFloorIds: string[];
  availableExpansionFloorNumbers: number[];
}

export interface CatalogProgress {
  unlockedIds: string[];
  discoveredMarketEntryIds: string[];
}

export interface FlowEvent {
  id: string;
  kind: "guest" | "staff" | "service";
  fromId: string;
  toId: string;
  count: number;
}

export interface FlowSnapshot {
  day: number;
  visibleFloorId: string;
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
