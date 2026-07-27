import {
  assertFloorCount,
  assertPublicSpaceCount,
  assertRoomCount,
  assertStableId,
  type ContentScaleState,
  type HotelFloor,
  type ScaleFloorTemplate,
} from "../domain/building/buildingTypes";
import {
  type FacilityState,
  type PublicSpaceBlueprint,
  type PublicSpaceInstance,
  type PublicSpaceType,
} from "../domain/facilities/facilityTypes";
import { createNewGame, type GameState } from "../domain/game/state";
import {
  GUEST_SEGMENT_IDS,
  type GuestSegmentId,
} from "../domain/operations/operationsTypes";
import type { SaveId } from "../domain/primitives";

const FACILITY_TYPES: readonly PublicSpaceType[] = [
  "sky-lobby",
  "all-day-dining",
  "chinese-restaurant",
  "bar",
  "executive-lounge",
  "spa",
  "pool",
  "gym",
  "ballroom",
  "meeting-room",
  "garden-terrace",
  "boutique",
];

const OPERATING_FACILITY_TYPES = new Set<PublicSpaceType>(
  FACILITY_TYPES.slice(0, 6),
);

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableRecord<T extends { id: string }>(values: T[]): Record<string, T> {
  return Object.fromEntries(
    [...values]
      .sort((left, right) => compareStableIds(left.id, right.id))
      .map((value) => [value.id, value]),
  );
}

function createSegmentInputs(): FacilityState["segmentInputs"] {
  return Object.fromEntries(
    GUEST_SEGMENT_IDS.map((segmentId, index) => [
      segmentId,
      {
        appealBps: 5_000 + index * 250,
        satisfactionBps: 5_500 + index * 200,
        dailyDemand: 12 + index,
      },
    ]),
  ) as Record<GuestSegmentId, FacilityState["segmentInputs"][GuestSegmentId]>;
}

function createGuestTemplate(): ScaleFloorTemplate {
  return {
    id: "template:guest:dense-ring",
    use: "guest",
    roomPlacements: Array.from({ length: 10 }, (_, index) => ({
      id: `placement:${String(index + 1).padStart(3, "0")}`,
      roomBlueprintId: "room-blueprint:standard-king",
    })),
    publicSpaceSlots: [],
  };
}

function createFloors(guestTemplate: ScaleFloorTemplate): HotelFloor[] {
  return Array.from({ length: 16 }, (_, index): HotelFloor => {
    const floorNumber = index + 1;
    const floorId = assertStableId(
      `floor:${String(floorNumber).padStart(2, "0")}`,
    );
    const use =
      floorNumber === 1
        ? "entrance"
        : floorNumber === 2
          ? "sky-lobby"
          : floorNumber <= 4
            ? "facility"
            : "guest";
    const rooms =
      use === "guest"
        ? guestTemplate.roomPlacements.map((placement) => ({
            id: assertStableId(`room:${floorId}:${placement.id}`),
            floorId,
            localPlacementId: placement.id,
            roomBlueprintId: placement.roomBlueprintId,
            committedBuildCostCents: 2_500_000,
          }))
        : [];

    return {
      id: floorId,
      floorNumber,
      use,
      templateId:
        use === "guest" ? guestTemplate.id : `template:${use}:standard`,
      purchased: true,
      rooms: rooms.sort((left, right) => compareStableIds(left.id, right.id)),
      publicSpaceInstanceIds: [],
    };
  }).sort(
    (left, right) =>
      left.floorNumber - right.floorNumber ||
      compareStableIds(left.id, right.id),
  );
}

function createPublicSpaceRecords(floors: HotelFloor[]): {
  blueprints: Record<string, PublicSpaceBlueprint>;
  instances: Record<string, PublicSpaceInstance>;
  facilities: Record<string, FacilityState>;
} {
  const facilityFloorIds = [floors[1].id, floors[2].id, floors[3].id];
  const blueprints: PublicSpaceBlueprint[] = [];
  const instances: PublicSpaceInstance[] = [];
  const facilities: FacilityState[] = [];

  FACILITY_TYPES.forEach((type, index) => {
    const floorId = facilityFloorIds[Math.min(Math.floor(index / 4), 2)];
    const localPlacementId = `space:${String((index % 4) + 1).padStart(2, "0")}`;
    const blueprintId = assertStableId(`space-blueprint:${type}`);
    const instanceId = assertStableId(
      `public-space:${floorId}:${localPlacementId}`,
    );
    const facilityId = assertStableId(`facility:${floorId}:${type}`);

    blueprints.push({
      id: blueprintId,
      type,
      name: type,
      columns: 8,
      rows: 8,
      cells: [{ x: 0, y: 0, zoneId: "zone:guest" }],
      placedItems: [],
      committedBuildCostCents: 5_000_000 + index * 100_000,
    });
    instances.push({
      id: instanceId,
      floorId,
      localPlacementId,
      blueprintId,
      type,
      committedBuildCostCents: 5_000_000 + index * 100_000,
    });
    facilities.push({
      id: facilityId,
      type,
      publicSpaceInstanceId: instanceId,
      status: OPERATING_FACILITY_TYPES.has(type) ? "operating" : "planned",
      enabled: OPERATING_FACILITY_TYPES.has(type),
      capacity: 20 + index * 5,
      dailyOperatingCostCents: 50_000 + index * 2_500,
      segmentInputs: createSegmentInputs(),
      selectedChoiceIds: [`choice:${type}:standard`],
    });

    floors.find((floor) => floor.id === floorId)?.publicSpaceInstanceIds.push(
      instanceId,
    );
  });

  for (const floor of floors) {
    floor.publicSpaceInstanceIds.sort();
  }

  return {
    blueprints: stableRecord(blueprints),
    instances: stableRecord(instances),
    facilities: stableRecord(facilities),
  };
}

function createPhase4State(): ContentScaleState {
  const guestTemplate = createGuestTemplate();
  const floors = createFloors(guestTemplate);
  const { blueprints, instances, facilities } = createPublicSpaceRecords(floors);

  assertFloorCount(floors.length);
  assertRoomCount(floors.reduce((total, floor) => total + floor.rooms.length, 0));
  assertPublicSpaceCount(Object.keys(instances).length);

  const floorTemplates = stableRecord<ScaleFloorTemplate>([
    guestTemplate,
    {
      id: "template:entrance:standard",
      use: "entrance",
      roomPlacements: [],
      publicSpaceSlots: [],
    },
    {
      id: "template:facility:standard",
      use: "facility",
      roomPlacements: [],
      publicSpaceSlots: FACILITY_TYPES.map((type, index) => ({
        id: `space:${String(index + 1).padStart(2, "0")}`,
        permittedTypes: [type],
      })),
    },
    {
      id: "template:sky-lobby:standard",
      use: "sky-lobby",
      roomPlacements: [],
      publicSpaceSlots: [{ id: "space:01", permittedTypes: ["sky-lobby"] }],
    },
  ]);

  return {
    rulesetVersion: "content-scale-v1",
    building: {
      templateId: "building-template:first-tower",
      entranceFloorId: floors[0].id,
      skyLobbyFloorIds: [floors[1].id],
      purchasedFloorIds: floors.map((floor) => floor.id),
      availableExpansionFloorNumbers: [17, 18, 19, 20],
    },
    floorTemplates,
    floors,
    spaceBlueprints: blueprints,
    publicSpaces: instances,
    facilities,
    catalogProgress: {
      unlockedIds: FACILITY_TYPES.map((type) => `facility:${type}`).sort(),
      discoveredMarketEntryIds: GUEST_SEGMENT_IDS.map(
        (segmentId) => `market:${segmentId}`,
      ).sort(),
    },
    recentFlowSnapshot: {
      day: 0,
      visibleFloorId: floors[4].id,
      events: Array.from({ length: 12 }, (_, index) => ({
        id: `flow:${String(index + 1).padStart(3, "0")}`,
        kind: index % 3 === 0 ? "staff" : "guest",
        fromId: floors[4 + (index % 12)].id,
        toId: floors[1].id,
        count: index + 1,
      })),
    },
  };
}

export function createPhase4AcceptanceState(saveId: SaveId): GameState {
  return {
    ...createNewGame(saveId),
    phase4: createPhase4State(),
  };
}

export function projectFixtureRoomIds(state: GameState): string[] {
  return (state.phase4?.floors ?? [])
    .flatMap((floor) => floor.rooms.map((room) => room.id));
}
