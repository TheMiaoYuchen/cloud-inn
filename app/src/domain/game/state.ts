import { prototypeConfig } from "../config/prototypeConfig";
import type {
  BasisPoints,
  GameDay,
  MoneyCents,
  Revision,
  RoomBlueprintId,
  RoomInstanceId,
  SaveId,
} from "../primitives";
import type {
  CorridorTemplate,
  DesignGene,
  RoomVariant,
  FloorVariantPlacement,
} from "../design/designTypes";
import type { RoomMaster } from "../design/roomSeries";

export type ZoneKind = "bedroom" | "bathroom";

export interface Cell {
  x: number;
  y: number;
  zone: ZoneKind;
}

export interface RoomMetrics {
  areaSquareMeters: number;
  buildCostCents: MoneyCents;
  suggestedRateCents: MoneyCents;
  businessFitBps: BasisPoints;
}

export type VisualState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; assetPath: string }
  | { status: "error"; message: string };

export interface RoomBlueprint {
  id: RoomBlueprintId;
  name: string;
  columns: number;
  rows: number;
  cells: Cell[];
  metrics: RoomMetrics;
  visual: VisualState;
}

export interface RoomInstance {
  id: RoomInstanceId;
  slotId: string;
  roomBlueprintId: RoomBlueprintId;
  committedBuildCostCents: MoneyCents;
}

export interface DailyReport {
  day: GameDay;
  availableRooms: number;
  soldRooms: number;
  occupancyBps: BasisPoints;
  rateCents: MoneyCents;
  revenueCents: MoneyCents;
  operatingCostCents: MoneyCents;
  netIncomeCents: number;
  endingCashCents: MoneyCents;
  reasons: string[];
}

/** Optional Phase 2 envelope; absent in and compatible with Phase 1 saves. */
export interface Phase2DesignState {
  hotelGene: DesignGene;
  roomMaster: RoomMaster | null;
  roomVariants: RoomVariant[];
  corridorTemplate: CorridorTemplate | null;
  floorPlacements?: FloorVariantPlacement[];
}

export interface GameState {
  schemaVersion: 1;
  rulesetVersion: typeof prototypeConfig.rulesetVersion;
  saveId: SaveId;
  revision: Revision;
  phase: "design" | "floor" | "ready" | "open";
  currentDay: GameDay;
  cashCents: MoneyCents;
  rateCents: MoneyCents;
  roomBlueprint: RoomBlueprint | null;
  floor: {
    id: "prototype-floor";
    rooms: RoomInstance[];
  };
  reports: DailyReport[];
  latestReport: DailyReport | null;
  phase2?: Phase2DesignState;
}

export function createNewGame(saveId: SaveId): GameState {
  const prototypeRoomAreaSquareMeters =
    prototypeConfig.roomColumns *
    prototypeConfig.roomRows *
    prototypeConfig.cellAreaSquareMeters;
  const initialRateCents =
    prototypeConfig.suggestedRateBaseCents +
    prototypeRoomAreaSquareMeters *
      prototypeConfig.suggestedRatePerSquareMeterCents;

  return {
    schemaVersion: 1,
    rulesetVersion: prototypeConfig.rulesetVersion,
    saveId,
    revision: 0,
    phase: "design",
    currentDay: 0,
    cashCents: prototypeConfig.startingCashCents,
    rateCents: initialRateCents,
    roomBlueprint: null,
    floor: {
      id: "prototype-floor",
      rooms: [],
    },
    reports: [],
    latestReport: null,
  };
}
