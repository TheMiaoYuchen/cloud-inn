import type { ContentScaleState } from "../building/buildingTypes";
import { projectContentUnlocks, reconcileCatalogProgress } from "../content/contentUnlocks";
import { settleFacilityOperations } from "../facilities/facilityOperations";
import type { GameState } from "../game/state";
import type { RoomOffer } from "./roomOffer";
import type { OperationsState } from "./operationsTypes";
import {
  finalizeOperationsSettlement,
  type OperationsSettlementResult,
} from "./settleOperationsDay";
import { settleRoomDemand } from "./settleRoomDemand";

export interface HotelDaySettlementInput {
  day: number;
  seed: string;
  cashCents: number;
  operations: Readonly<OperationsState>;
  offers: ReadonlyArray<Readonly<RoomOffer>>;
  phase4: Readonly<ContentScaleState>;
}

export interface HotelDaySettlementResult extends OperationsSettlementResult {
  phase4: ContentScaleState;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function settleHotelDay(
  input: Readonly<HotelDaySettlementInput>,
): HotelDaySettlementResult {
  const room = settleRoomDemand({
    day: input.day,
    operations: input.operations,
    offers: input.offers,
  });
  const facility = settleFacilityOperations({
    day: input.day,
    seed: input.seed,
    occupiedRooms: room.soldRooms,
    availableRooms: room.availableRooms,
    segmentMix: room.segmentMix ?? input.operations.segmentMix ?? {},
    reputationBps: input.operations.reputationBps,
    departments: input.operations.departments,
    facilities: input.phase4.facilities,
    publicSpaces: input.phase4.publicSpaces,
    blueprints: input.phase4.spaceBlueprints,
  });
  const finalized = finalizeOperationsSettlement({
    day: input.day,
    cashCents: input.cashCents,
    operations: input.operations,
    room,
    publicSpaceRevenueCents: facility.publicSpaceRevenueCents,
    facilityOperatingCostCents: facility.facilityOperatingCostCents,
    facilityReputationDeltaBps: facility.reputationDeltaBps,
    includePhase4Categories: true,
  });
  const resultByFacilityId = new Map(
    facility.results.map((result) => [result.facilityId, result]),
  );
  const facilities = Object.fromEntries(
    Object.entries(input.phase4.facilities)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, value]) => {
        const result = resultByFacilityId.get(value.id);
        if (!result) return [key, structuredClone(value)];
        const { facilityId: _facilityId, residentVisits: _resident, nonResidentVisits: _nonResident, ...dailyResult } = result;
        return [key, {
          ...structuredClone(value),
          dailyResults: [...value.dailyResults.map((item) => structuredClone(item)), dailyResult],
        }];
      }),
  );
  let phase4: ContentScaleState = {
    ...structuredClone(input.phase4),
    facilities,
    recentFlowSnapshot: {
      day: input.day,
      visibleFloorId: input.phase4.recentFlowSnapshot?.visibleFloorId
        ?? input.phase4.floors[0].id,
      events: facility.flowEvents.map((event) => ({ ...event })),
    },
  };
  const unlockState = {
    operations: finalized.operations,
    phase4,
  } as Readonly<GameState>;
  phase4 = reconcileCatalogProgress(phase4, projectContentUnlocks(unlockState));
  return { ...finalized, phase4 };
}
