import type { Cell, RoomMetrics } from "../game/state";
import type { Opening } from "../room/editRoom";

/** Shared visual language inherited by a hotel, series, and room variant. */
export interface DesignGene {
  palette: string;
  materials: string[];
  metal: string;
  lighting: string;
  mood: string;
}

export interface StylePreset {
  id: string;
  name: string;
  gene: DesignGene;
}

export type RoomVariantOverride =
  | "bedType"
  | "area"
  | "view"
  | "furniture"
  | "featureIntensity"
  | "gene";

export interface RoomVariant {
  id: string;
  name: string;
  masterId: string;
  cells: Cell[];
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
  overrides: RoomVariantOverride[];
  gene: DesignGene;
  variantKind?: "king" | "twin" | "corner";
  metrics?: RoomMetrics;
  openings?: { walls: Opening[]; doors: Opening[]; windows: Opening[] };
}

export interface GridPoint {
  x: number;
  y: number;
}

export interface CorridorSlot {
  id: string;
  anchor: GridPoint;
  width: number;
  height: number;
}

export interface CorridorTemplate {
  id: string;
  name: string;
  width: number;
  height: number;
  core: GridPoint[];
  corridor: GridPoint[];
  entrances: GridPoint[];
  slots: CorridorSlot[];
}

export interface FloorVariantPlacement {
  slotId: string;
  variantId: string;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
}
