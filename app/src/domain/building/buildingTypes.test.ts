import { describe, expect, it } from "vitest";

import {
  assertFloorCount,
  assertPublicSpaceCount,
  assertRoomCount,
  assertStableId,
  type CatalogProgress,
  type FlowEvent,
  type FloorUse,
  type HotelFloor,
  type ScalePublicSpaceSlot,
  type ScaleRoomInstance,
  type StableId,
  type TowerBuildingState,
} from "./buildingTypes";
import { GUEST_SEGMENT_IDS } from "../operations/operationsTypes";
import type {
  FacilityDailyResult,
  FacilityMenuSelection,
  FacilityPolicy,
  FacilitySignatureOffering,
  FacilityState,
  PublicSpaceInstance,
  PublicSpaceType,
} from "../facilities/facilityTypes";
import {
  createPhase4AcceptanceState,
  projectFixtureRoomIds,
} from "../../testing/phase4Fixtures";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

type ApprovedFloorUse =
  | "entrance"
  | "sky-lobby"
  | "guest"
  | "facility"
  | "service";
type FloorUseIsExact = Expect<Equal<FloorUse, ApprovedFloorUse>>;
const floorUseIsExact: FloorUseIsExact = true;

type ApprovedPublicSpaceType =
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
type PublicSpaceTypeIsExact = Expect<
  Equal<PublicSpaceType, ApprovedPublicSpaceType>
>;
const publicSpaceTypeIsExact: PublicSpaceTypeIsExact = true;

type StoredRoomIdIsBranded = Expect<
  Equal<ScaleRoomInstance["id"], StableId>
>;
type StoredFloorIdIsBranded = Expect<Equal<HotelFloor["id"], StableId>>;
type StoredSlotIdIsBranded = Expect<
  Equal<ScalePublicSpaceSlot["id"], StableId>
>;
type StoredBuildingIdIsBranded = Expect<
  Equal<TowerBuildingState["templateId"], StableId>
>;
type StoredUnlockIdIsBranded = Expect<
  Equal<CatalogProgress["unlockedIds"][number], StableId>
>;
type StoredFlowIdIsBranded = Expect<Equal<FlowEvent["id"], StableId>>;
type StoredFacilityIdIsBranded = Expect<Equal<FacilityState["id"], StableId>>;
type StoredSpaceReferenceIsBranded = Expect<
  Equal<PublicSpaceInstance["blueprintId"], StableId>
>;
type StoredPolicyIdIsBranded = Expect<
  Equal<FacilityPolicy["positioningId"], StableId>
>;
const storedIdsAreBranded: [
  StoredRoomIdIsBranded,
  StoredFloorIdIsBranded,
  StoredSlotIdIsBranded,
  StoredBuildingIdIsBranded,
  StoredUnlockIdIsBranded,
  StoredFlowIdIsBranded,
  StoredFacilityIdIsBranded,
  StoredSpaceReferenceIsBranded,
  StoredPolicyIdIsBranded,
] = [true, true, true, true, true, true, true, true, true];

describe("Phase 4 state contracts", () => {
  it("exports the exact floor and public-space catalogs", () => {
    expect(floorUseIsExact).toBe(true);
    expect(publicSpaceTypeIsExact).toBe(true);
    expect(storedIdsAreBranded).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("accepts stable IDs and bounded collection counts", () => {
    expect(assertStableId("room:floor:16:placement-008")).toBe(
      "room:floor:16:placement-008",
    );
    expect(assertFloorCount(1)).toBe(1);
    expect(assertFloorCount(64)).toBe(64);
    expect(assertRoomCount(0)).toBe(0);
    expect(assertRoomCount(240)).toBe(240);
    expect(assertPublicSpaceCount(0)).toBe(0);
    expect(assertPublicSpaceCount(32)).toBe(32);
  });

  it.each([
    "",
    "Uppercase",
    "contains space",
    `a${"b".repeat(96)}`,
  ])("rejects invalid stable ID %s", (value) => {
    expect(() => assertStableId(value)).toThrow("稳定 ID");
  });

  it.each([
    [assertFloorCount, 0],
    [assertFloorCount, 65],
    [assertRoomCount, -1],
    [assertRoomCount, 241],
    [assertPublicSpaceCount, -1],
    [assertPublicSpaceCount, 33],
    [assertRoomCount, 1.5],
  ])("rejects an out-of-bound count", (assertCount, value) => {
    expect(() => assertCount(value)).toThrow("数量");
  });

  it("creates a valid maximum-density fixture with stable floor-scoped IDs", () => {
    const state = createPhase4AcceptanceState("phase4-acceptance");
    const phase4 = state.phase4;
    const roomIds = projectFixtureRoomIds(state);

    expect(phase4?.floors).toHaveLength(16);
    expect(roomIds).toHaveLength(120);
    expect(new Set(roomIds).size).toBe(120);
    expect(Object.keys(phase4?.facilities ?? {})).toHaveLength(12);
    expect(
      Object.values(phase4?.facilities ?? {}).filter(
        (facility) => facility.status === "operating",
      ),
    ).toHaveLength(6);
    expect(
      Object.values(phase4?.facilities ?? {}).map((facility) => facility.type),
    ).toEqual([
      "all-day-dining",
      "bar",
      "chinese-restaurant",
      "sky-lobby",
      "executive-lounge",
      "gym",
      "pool",
      "spa",
      "ballroom",
      "boutique",
      "garden-terrace",
      "meeting-room",
    ] satisfies PublicSpaceType[]);
    for (const facility of Object.values(phase4?.facilities ?? {})) {
      expect(Object.keys(facility.segmentInputs)).toEqual(GUEST_SEGMENT_IDS);
    }

    expect(phase4?.floors.map((floor) => floor.floorNumber)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    for (const floor of phase4?.floors ?? []) {
      expect(floor.rooms.map((room) => room.id)).toEqual(
        [...floor.rooms.map((room) => room.id)].sort(),
      );
      for (const room of floor.rooms) {
        expect(room.id).toBe(`room:${floor.id}:${room.localPlacementId}`);
        expect(room.floorId).toBe(floor.id);
      }
    }

    expect(phase4?.catalogProgress.unlockedIds.length).toBeLessThanOrEqual(64);
    expect(phase4?.recentFlowSnapshot?.events.length).toBeLessThanOrEqual(150);
  });

  it("resolves every public space to one compatible floor-template slot", () => {
    const phase4 = createPhase4AcceptanceState("phase4-space-slots").phase4!;

    for (const publicSpace of Object.values(phase4.publicSpaces)) {
      const floor = phase4.floors.find(
        (candidate) => candidate.id === publicSpace.floorId,
      )!;
      const template = phase4.floorTemplates[floor.templateId];
      const matchingSlots = template.publicSpaceSlots.filter(
        (slot) => slot.id === publicSpace.localPlacementId,
      );

      expect(matchingSlots, publicSpace.id).toHaveLength(1);
      expect(
        matchingSlots[0].permittedTypes,
        publicSpace.id,
      ).toContain(publicSpace.type);
    }
  });

  it("persists distinct facility policy, menu, offering, and daily-result state", () => {
    const phase4 = createPhase4AcceptanceState("phase4-facility-state").phase4!;
    const facility = Object.values(phase4.facilities)[0];
    const policy: FacilityPolicy | null = facility.policy;
    const menuSelection: FacilityMenuSelection | null = facility.menuSelection;
    const offering: FacilitySignatureOffering = {
      id: assertStableId("offering:fixture"),
      kind: "dish",
      developmentCostCents: 100_000,
      unitCostCents: 2_000,
      segmentAppealBps: Object.fromEntries(
        GUEST_SEGMENT_IDS.map((segmentId) => [segmentId, 5_000]),
      ) as FacilitySignatureOffering["segmentAppealBps"],
      reputationBps: 100,
    };
    const dailyResult: FacilityDailyResult | undefined =
      facility.dailyResults[0];

    expect(policy).toMatchObject({
      positioningId: expect.any(String),
      priceBandId: expect.any(String),
      capacity: facility.capacity,
      openingPolicyId: expect.any(String),
      serviceBudgetCents: expect.any(Number),
      signatureOfferingId: facility.selectedSignatureOfferingId,
    });
    expect(menuSelection).toMatchObject({
      menuStructureId: expect.any(String),
    });
    expect(facility.selectedSignatureOfferingId).toEqual(expect.any(String));
    expect(facility.developedOfferingIds).toContain(
      facility.selectedSignatureOfferingId,
    );
    expect(facility.dailyResults).toEqual([]);
    expect(offering.kind).toBe("dish");
    expect(dailyResult).toBeUndefined();
    expect(() => JSON.stringify(facility)).not.toThrow();
  });

  it("defines integer true-size transforms for all 120 room placements", () => {
    const phase4 = createPhase4AcceptanceState("phase4-room-geometry").phase4!;
    let resolvedRoomCount = 0;

    for (const floor of phase4.floors) {
      const template = phase4.floorTemplates[floor.templateId];
      expect(template.cellAreaSquareMeters).toBe(1);
      for (const room of floor.rooms) {
        const placements = template.roomPlacements.filter(
          (placement) => placement.id === room.localPlacementId,
        );

        expect(placements, room.id).toHaveLength(1);
        expect(placements[0]).toMatchObject({
          anchorX: expect.any(Number),
          anchorY: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
          rotation: expect.any(Number),
          mirrored: expect.any(Boolean),
        });
        expect(Number.isInteger(placements[0].anchorX)).toBe(true);
        expect(Number.isInteger(placements[0].anchorY)).toBe(true);
        expect(Number.isInteger(placements[0].width)).toBe(true);
        expect(Number.isInteger(placements[0].height)).toBe(true);
        expect(placements[0].anchorX).toBeGreaterThanOrEqual(0);
        expect(placements[0].anchorY).toBeGreaterThanOrEqual(0);
        expect(placements[0].width).toBeGreaterThan(0);
        expect(placements[0].height).toBeGreaterThan(0);
        expect([0, 90, 180, 270]).toContain(placements[0].rotation);
        expect(placements[0].anchorX + placements[0].width).toBeLessThanOrEqual(
          template.columns,
        );
        expect(
          placements[0].anchorY + placements[0].height,
        ).toBeLessThanOrEqual(template.rows);
        resolvedRoomCount += 1;
      }
    }

    expect(resolvedRoomCount).toBe(120);
  });

  it("resolves every scaled room to an authoritative Phase 2 design", () => {
    const state = createPhase4AcceptanceState("phase4-room-designs");
    const designs = [
      ...(state.phase2?.roomMaster ? [state.phase2.roomMaster] : []),
      ...(state.phase2?.roomVariants ?? []),
    ];

    expect(designs).not.toHaveLength(0);
    for (const floor of state.phase4!.floors) {
      for (const room of floor.rooms) {
        expect(
          designs.some((design) => design.id === room.roomBlueprintId),
          room.id,
        ).toBe(true);
      }
    }
  });

  it("keeps the acceptance fixture deeply independent between calls", () => {
    const first = createPhase4AcceptanceState("phase4-independent");
    const second = createPhase4AcceptanceState("phase4-independent");
    const firstFacility = Object.values(first.phase4!.facilities)[0];
    const firstBlueprint = Object.values(first.phase4!.spaceBlueprints)[0];

    first.phase2!.roomMaster!.cells[0].zone = "bathroom";
    first.phase4!.floors[0].publicSpaceInstanceIds.push(
      assertStableId("public-space:mutated"),
    );
    firstFacility.segmentInputs.business.appealBps = 0;
    firstFacility.developedOfferingIds.push(assertStableId("offering:mutated"));
    firstBlueprint.cells[0].zoneId = assertStableId("zone:mutated");
    first.phase4!.catalogProgress.unlockedIds.push(
      assertStableId("unlock:mutated"),
    );
    first.phase4!.recentFlowSnapshot!.events[0].count = 999;

    expect(second).toEqual(createPhase4AcceptanceState("phase4-independent"));
  });

  it("keeps all fixture-owned critical references resolvable", () => {
    const state = createPhase4AcceptanceState("phase4-reference-graph");
    const phase4 = state.phase4!;
    const floorIds = new Set(phase4.floors.map((floor) => floor.id));
    const blueprintIds = new Set(Object.keys(phase4.spaceBlueprints));
    const publicSpaceIds = new Set(Object.keys(phase4.publicSpaces));
    const roomDesignIds = new Set([
      ...(state.phase2?.roomMaster ? [state.phase2.roomMaster.id] : []),
      ...(state.phase2?.roomVariants.map((variant) => variant.id) ?? []),
    ]);

    expect(floorIds).toContain(phase4.building.entranceFloorId);
    for (const floorId of phase4.building.skyLobbyFloorIds) {
      expect(floorIds).toContain(floorId);
    }
    for (const floorId of phase4.building.purchasedFloorIds) {
      expect(floorIds).toContain(floorId);
    }
    for (const floor of phase4.floors) {
      expect(phase4.floorTemplates[floor.templateId]).toBeDefined();
      for (const room of floor.rooms) {
        expect(roomDesignIds, room.id).toContain(room.roomBlueprintId);
      }
      for (const publicSpaceId of floor.publicSpaceInstanceIds) {
        expect(publicSpaceIds).toContain(publicSpaceId);
      }
    }
    for (const publicSpace of Object.values(phase4.publicSpaces)) {
      expect(floorIds).toContain(publicSpace.floorId);
      expect(blueprintIds).toContain(publicSpace.blueprintId);
    }
    for (const facility of Object.values(phase4.facilities)) {
      expect(publicSpaceIds).toContain(facility.publicSpaceInstanceId);
    }

    // Flow endpoints currently represent floors; Task 9 may broaden the union.
    for (const event of phase4.recentFlowSnapshot?.events ?? []) {
      expect(floorIds).toContain(event.fromId);
      expect(floorIds).toContain(event.toId);
    }
  });
});
