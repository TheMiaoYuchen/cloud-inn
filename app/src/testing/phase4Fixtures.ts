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
import { createRoomMaster } from "../domain/design/roomSeries";
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

const OPERATING_FACILITY_TYPES = new Set<PublicSpaceType>([
  "all-day-dining",
  "chinese-restaurant",
  "bar",
  "spa",
  "ballroom",
  "gym",
]);

const RESTAURANT_TYPES = new Set<PublicSpaceType>([
  "all-day-dining",
  "chinese-restaurant",
  "bar",
]);

const SERVICE_PACKAGE_TYPES = new Set<PublicSpaceType>([
  "spa",
  "ballroom",
  "meeting-room",
]);

const PUBLIC_SPACE_PLACEMENTS = FACILITY_TYPES.map((type, index) => ({
  type,
  floorNumber: 2 + Math.min(Math.floor(index / 4), 2),
  localPlacementId: assertStableId(
    `space:${String((index % 4) + 1).padStart(2, "0")}`,
  ),
}));

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
    id: assertStableId("template:guest:dense-ring"),
    use: "guest",
    columns: 24,
    rows: 60,
    cellAreaSquareMeters: 1,
    roomPlacements: Array.from({ length: 10 }, (_, index) => ({
      id: assertStableId(
        `placement:${String(index + 1).padStart(3, "0")}`,
      ),
      roomBlueprintId: assertStableId("room-blueprint:standard-king"),
      anchorX: index % 2 === 0 ? 0 : 8,
      anchorY: Math.floor(index / 2) * 6,
      width: 4,
      height: 6,
      rotation: index % 2 === 0 ? 0 : 180,
      mirrored: index % 2 !== 0,
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
        floorNumber === 4
          ? assertStableId("template:facility:upper")
          : use === "guest"
            ? guestTemplate.id
            : assertStableId(`template:${use}:standard`),
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
  const blueprints: PublicSpaceBlueprint[] = [];
  const instances: PublicSpaceInstance[] = [];
  const facilities: FacilityState[] = [];

  PUBLIC_SPACE_PLACEMENTS.forEach(
    ({ type, floorNumber, localPlacementId }, index) => {
      const floorId = floors[floorNumber - 1].id;
      const blueprintId = assertStableId(`space-blueprint:${type}`);
      const instanceId = assertStableId(
        `public-space:${floorId}:${localPlacementId}`,
      );
      const facilityId = assertStableId(`facility:${floorId}:${type}`);
      const signatureOfferingId = RESTAURANT_TYPES.has(type)
        ? assertStableId(
            `offering:${type === "bar" ? "drink" : "dish"}:${type}`,
          )
        : SERVICE_PACKAGE_TYPES.has(type)
          ? assertStableId(`offering:service-package:${type}`)
          : undefined;

      blueprints.push({
        id: blueprintId,
        type,
        name: type,
        columns: 8,
        rows: 8,
        cells: [{ x: 0, y: 0, zoneId: assertStableId("zone:guest") }],
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
        dailyOperatingCostCents: 50_000 + index * 2_500,
        segmentInputs: createSegmentInputs(),
        policy:
          RESTAURANT_TYPES.has(type) || SERVICE_PACKAGE_TYPES.has(type)
            ? {
                positioningId: assertStableId(`positioning:${type}:standard`),
                priceBandId: assertStableId("price-band:premium"),
                capacity: 20 + index * 5,
                openingPolicyId: assertStableId("opening-policy:daily"),
                serviceBudgetCents: 50_000 + index * 2_500,
                signatureOfferingId,
              }
            : null,
        menuSelection: RESTAURANT_TYPES.has(type)
          ? {
              menuStructureId: assertStableId(`menu:${type}:standard`),
              selectedItemIds: [],
            }
          : null,
        developedOfferingIds: signatureOfferingId
          ? [signatureOfferingId]
          : [],
        dailyResults: [],
      });

      floors.find((floor) => floor.id === floorId)?.publicSpaceInstanceIds.push(
        instanceId,
      );
    },
  );

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

  const createPublicSpaceSlots = (floorNumber: number) =>
    PUBLIC_SPACE_PLACEMENTS.filter(
      (placement) => placement.floorNumber === floorNumber,
    ).map(({ localPlacementId, type }) => ({
      id: localPlacementId,
      permittedTypes: [type],
    }));

  const floorTemplates = stableRecord<ScaleFloorTemplate>([
    guestTemplate,
    {
      id: assertStableId("template:entrance:standard"),
      use: "entrance",
      columns: 24,
      rows: 24,
      cellAreaSquareMeters: 1,
      roomPlacements: [],
      publicSpaceSlots: [],
    },
    {
      id: assertStableId("template:facility:standard"),
      use: "facility",
      columns: 24,
      rows: 24,
      cellAreaSquareMeters: 1,
      roomPlacements: [],
      publicSpaceSlots: createPublicSpaceSlots(3),
    },
    {
      id: assertStableId("template:facility:upper"),
      use: "facility",
      columns: 24,
      rows: 24,
      cellAreaSquareMeters: 1,
      roomPlacements: [],
      publicSpaceSlots: createPublicSpaceSlots(4),
    },
    {
      id: assertStableId("template:sky-lobby:standard"),
      use: "sky-lobby",
      columns: 24,
      rows: 24,
      cellAreaSquareMeters: 1,
      roomPlacements: [],
      publicSpaceSlots: createPublicSpaceSlots(2),
    },
  ]);

  return {
    rulesetVersion: "content-scale-v1",
    building: {
      templateId: assertStableId("building-template:first-tower"),
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
      unlockedIds: FACILITY_TYPES.map((type) =>
        assertStableId(`facility:${type}`),
      ).sort(),
      discoveredMarketEntryIds: GUEST_SEGMENT_IDS.map(
        (segmentId) => assertStableId(`market:${segmentId}`),
      ).sort(),
    },
    recentFlowSnapshot: {
      day: 0,
      visibleFloorId: floors[4].id,
      events: Array.from({ length: 12 }, (_, index) => ({
        id: assertStableId(`flow:${String(index + 1).padStart(3, "0")}`),
        kind: index % 3 === 0 ? "staff" : "guest",
        fromId: floors[4 + (index % 12)].id,
        toId: floors[1].id,
        count: index + 1,
      })),
    },
  };
}

function createAcceptanceRoomMaster() {
  return createRoomMaster({
    id: assertStableId("room-blueprint:standard-king"),
    name: "Standard King",
    columns: 8,
    rows: 12,
    cells: Array.from({ length: 8 * 12 }, (_, index) => ({
      x: index % 8,
      y: Math.floor(index / 8),
      zone: index % 8 >= 6 ? ("bathroom" as const) : ("bedroom" as const),
    })),
    gene: {
      palette: "cloud-neutral",
      materials: ["oak", "linen"],
      metal: "brushed-brass",
      lighting: "warm",
      mood: "calm",
    },
  });
}

export function createPhase4AcceptanceState(saveId: SaveId): GameState {
  return {
    ...createNewGame(saveId),
    phase2: {
      hotelGene: {
        palette: "cloud-neutral",
        materials: ["oak", "linen"],
        metal: "brushed-brass",
        lighting: "warm",
        mood: "calm",
      },
      roomMaster: createAcceptanceRoomMaster(),
      roomVariants: [],
      corridorTemplate: null,
    },
    phase4: createPhase4State(),
  };
}

export function projectFixtureRoomIds(state: GameState): string[] {
  return (state.phase4?.floors ?? [])
    .flatMap((floor) => floor.rooms.map((room) => room.id));
}
