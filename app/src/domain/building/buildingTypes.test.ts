import { describe, expect, it } from "vitest";

import {
  assertFloorCount,
  assertPublicSpaceCount,
  assertRoomCount,
  assertStableId,
  type FloorUse,
} from "./buildingTypes";
import { GUEST_SEGMENT_IDS } from "../operations/operationsTypes";
import type { PublicSpaceType } from "../facilities/facilityTypes";
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

describe("Phase 4 state contracts", () => {
  it("exports the exact floor and public-space catalogs", () => {
    expect(floorUseIsExact).toBe(true);
    expect(publicSpaceTypeIsExact).toBe(true);
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
});
