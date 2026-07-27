import { prototypeConfig } from "../config/prototypeConfig";
import type { DesignGene, RoomVariant } from "../design/designTypes";
import type { GameState } from "../game/state";
import type { GuestSegmentId } from "./operationsTypes";
import type { BedType } from "./segmentCatalog";

export interface RoomOffer {
  id: string;
  sourceRoomId: string;
  variantId?: string;
  bedType: BedType;
  capacity: number;
  areaSquareMeters: number;
  nightlyRateCents: number;
  viewBps: number;
  workspaceBps: number;
  quietBps: number;
  privacyBps: number;
  designAffinities: Record<GuestSegmentId, number>;
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function geneText(gene?: DesignGene): string {
  if (!gene) return "";
  return [gene.palette, ...gene.materials, gene.metal, gene.lighting, gene.mood]
    .join(" ")
    .toLowerCase();
}

function hasAny(text: string, cues: string[]): boolean {
  return cues.some((cue) => text.includes(cue));
}

function deriveDesignAffinities(gene?: DesignGene): Record<GuestSegmentId, number> {
  const text = geneText(gene);
  const cultural = hasAny(text, ["culturally", "walnut", "natural stone", "hand-finished", "aged bronze"]);
  const metropolitan = hasAny(text, ["metropolitan", "task lighting", "leather", "oak", "charcoal"]);
  const resort = hasAny(text, ["nature", "rattan", "limestone", "daylight", "botanical"]);

  return {
    business: metropolitan ? 8_500 : 5_000,
    couple: hasAny(text, ["private", "silk", "warm", "restful"]) ? 7_500 : 5_000,
    family: resort ? 6_500 : 5_000,
    leisure: resort || cultural ? 7_500 : 5_000,
    "high-net-worth": hasAny(text, ["refined", "composed", "luxury", "travertine"]) ? 8_000 : 5_000,
    "cultural-experience": cultural ? 9_000 : 4_500,
  };
}

function uniqueCellArea(variant: RoomVariant): number {
  const uniqueCells = new Set(variant.cells.map(({ x, y }) => `${x},${y}`));
  return uniqueCells.size * prototypeConfig.cellAreaSquareMeters;
}

function variantBedType(variant: RoomVariant): BedType {
  if (variant.variantKind === "twin") return "twin";
  if (variant.variantKind === "king" || variant.variantKind === "corner") return "king";
  return "double";
}

function projectVariant(
  state: GameState,
  roomId: string,
  variant: RoomVariant,
): RoomOffer {
  const text = geneText(variant.gene);
  const corner = variant.variantKind === "corner";
  const metropolitan = hasAny(text, ["metropolitan", "task lighting", "oak", "leather"]);
  const quiet = hasAny(text, ["quiet", "private", "restful", "low-glare"]);
  const areaSquareMeters = variant.metrics?.areaSquareMeters ?? uniqueCellArea(variant);

  return {
    id: `offer:${roomId}:${variant.id}`,
    sourceRoomId: roomId,
    variantId: variant.id,
    bedType: variantBedType(variant),
    capacity: variant.variantKind === "twin" ? 3 : 2,
    areaSquareMeters,
    nightlyRateCents: state.rateCents,
    viewBps: corner ? 9_000 : variant.overrides.includes("view") ? 7_500 : 5_500,
    workspaceBps: clampBps(metropolitan ? 8_500 : 5_000),
    quietBps: clampBps(quiet ? 8_000 : 5_500),
    privacyBps: clampBps(corner ? 8_000 : hasAny(text, ["private", "composed"]) ? 7_500 : 5_500),
    designAffinities: deriveDesignAffinities(variant.gene),
  };
}

export function projectRoomOffers(state: GameState): RoomOffer[] {
  return state.floor.rooms.flatMap((room) => {
    const placement = state.phase2?.floorPlacements?.find(
      ({ slotId }) => slotId === room.slotId,
    );
    const variant = placement
      ? state.phase2?.roomVariants.find(({ id }) => id === placement.variantId)
      : undefined;

    if (variant) {
      return [projectVariant(state, room.id, variant)];
    }

    const blueprint = state.roomBlueprint;
    if (!blueprint || blueprint.id !== room.roomBlueprintId) {
      return [];
    }

    return [{
      id: `offer:${room.id}:${blueprint.id}`,
      sourceRoomId: room.id,
      bedType: "double" as const,
      capacity: 2,
      areaSquareMeters: blueprint.metrics.areaSquareMeters,
      nightlyRateCents: state.rateCents,
      viewBps: blueprint.openings?.windows.length ? 6_000 : 5_000,
      workspaceBps: clampBps(blueprint.metrics.businessFitBps),
      quietBps: 5_500,
      privacyBps: 5_500,
      designAffinities: deriveDesignAffinities(state.phase2?.hotelGene),
    }];
  });
}
