import { projectHotelRoomOffers } from "../building/hotelInventory";
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

/** Phase 3 compatibility name for the authoritative hotel projection. */
export function projectRoomOffers(state: GameState): RoomOffer[] {
  return projectHotelRoomOffers(state);
}
