import type { GuestSegmentId } from "../operations/operationsTypes";

export type PublicSpaceType =
  | "sky-lobby"
  | "all-day-dining"
  | "chinese-restaurant"
  | "bar"
  | "executive-lounge"
  | "spa"
  | "pool"
  | "gym"
  | "ballroom"
  | "meeting-room"
  | "garden-terrace"
  | "boutique";

export interface PublicSpaceCell {
  x: number;
  y: number;
  zoneId: string;
}

export interface PublicSpacePlacedItem {
  id: string;
  catalogItemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface PublicSpaceBlueprint {
  id: string;
  type: PublicSpaceType;
  name: string;
  columns: number;
  rows: number;
  cells: PublicSpaceCell[];
  placedItems: PublicSpacePlacedItem[];
  committedBuildCostCents: number;
}

export interface PublicSpaceInstance {
  id: string;
  floorId: string;
  localPlacementId: string;
  blueprintId: string;
  type: PublicSpaceType;
  committedBuildCostCents: number;
}

export type FacilityStatus = "planned" | "operating" | "closed";

export interface FacilitySegmentInput {
  appealBps: number;
  satisfactionBps: number;
  dailyDemand: number;
}

export interface FacilityState {
  id: string;
  type: PublicSpaceType;
  publicSpaceInstanceId: string;
  status: FacilityStatus;
  enabled: boolean;
  capacity: number;
  dailyOperatingCostCents: number;
  segmentInputs: Record<GuestSegmentId, FacilitySegmentInput>;
  selectedChoiceIds: string[];
}
