import type { GuestSegmentId } from "../operations/operationsTypes";
import type { StableId } from "../building/buildingTypes";

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
  zoneId: StableId;
}

export interface PublicSpacePlacedItem {
  id: StableId;
  catalogItemId: StableId;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface PublicSpaceBlueprint {
  id: StableId;
  type: PublicSpaceType;
  name: string;
  columns: number;
  rows: number;
  cells: PublicSpaceCell[];
  placedItems: PublicSpacePlacedItem[];
  committedBuildCostCents: number;
}

export interface PublicSpaceInstance {
  id: StableId;
  floorId: StableId;
  localPlacementId: StableId;
  blueprintId: StableId;
  type: PublicSpaceType;
  committedBuildCostCents: number;
}

export type FacilityStatus = "planned" | "operating" | "closed";

export interface FacilitySegmentInput {
  appealBps: number;
  satisfactionBps: number;
  dailyDemand: number;
}

export interface FacilityPolicy {
  positioningId: StableId;
  priceBandId: StableId;
  capacity: number;
  openingPolicyId: StableId;
  serviceBudgetCents: number;
  signatureOfferingId?: StableId;
}

export interface FacilityMenuSelection {
  menuStructureId: StableId;
  selectedItemIds: StableId[];
}

export interface FacilitySignatureOffering {
  id: StableId;
  kind: "dish" | "drink" | "service-package";
  developmentCostCents: number;
  unitCostCents: number;
  segmentAppealBps: Record<GuestSegmentId, number>;
  reputationBps: number;
}

export interface FacilityDailyResult {
  day: number;
  visits: number;
  revenueCents: number;
  operatingCostCents: number;
  utilizationBps: number;
  satisfactionDeltaBps: number;
  appealDeltaBps: number;
  reasonCodes: StableId[];
}

export interface FacilityState {
  id: StableId;
  type: PublicSpaceType;
  publicSpaceInstanceId: StableId;
  status: FacilityStatus;
  enabled: boolean;
  capacity: number;
  dailyOperatingCostCents: number;
  segmentInputs: Record<GuestSegmentId, FacilitySegmentInput>;
  policy: FacilityPolicy | null;
  menuSelection: FacilityMenuSelection | null;
  selectedSignatureOfferingId: StableId | null;
  developedOfferingIds: StableId[];
  dailyResults: FacilityDailyResult[];
}
