import type {
  SpaceTypeDefinition as CatalogSpaceTypeDefinition,
} from "../content/contentCatalog";
import type {
  PublicSpaceBlueprint as CatalogPublicSpaceBlueprint,
  PublicSpaceType,
} from "../facilities/facilityTypes";

export const SPACE_EDITOR_MAX_CELLS = 4_096;
export const SPACE_EDITOR_MAX_ITEMS = 512;
export const SPACE_EDITOR_MAX_OPENINGS = 1_024;
export const SPACE_EDITOR_HISTORY_LIMIT = 100;

export type SpaceSide = "north" | "east" | "south" | "west";
export type SpaceRotation = 0 | 90 | 180 | 270;

export interface SpaceCell {
  x: number;
  y: number;
  zoneId: string;
}

export interface PlacedItem {
  id: string;
  catalogItemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: SpaceRotation;
}

export interface SpaceOpening {
  x: number;
  y: number;
  side: SpaceSide;
}

export interface SpaceOpenings {
  walls: SpaceOpening[];
  doors: SpaceOpening[];
  windows: SpaceOpening[];
}

export interface SpaceDraft extends SpaceOpenings {
  type: PublicSpaceType;
  columns: number;
  rows: number;
  cells: SpaceCell[];
  items: PlacedItem[];
}

export interface SpaceHistory {
  past: SpaceDraft[];
  present: SpaceDraft;
  future: SpaceDraft[];
}

export type PublicSpaceBlueprint = CatalogPublicSpaceBlueprint & SpaceOpenings;

export type SpaceTypeDefinition = CatalogSpaceTypeDefinition;

export interface PlanningIssue {
  code: string;
  message: string;
}

export interface SpaceMetrics {
  constructionCostCents: number;
  capacity: number;
  guestAppealBps: number;
  privacyBps: number;
  serviceDistance: number;
}

export interface PublicSpaceValidation {
  blocking: PlanningIssue[];
  advisory: PlanningIssue[];
  metrics: SpaceMetrics;
}
