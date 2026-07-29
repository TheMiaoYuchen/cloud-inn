import { describe, expect, it } from "vitest";
import { assertStableId } from "../building/buildingTypes";
import { createApprovedOperations } from "../operations/operationsFixtures";
import { GUEST_SEGMENT_IDS } from "../operations/operationsTypes";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { projectFlowSnapshot } from "./flowProjection";

function flowState() {
  const state = createPhase4AcceptanceState("flow-projection");
  const floor = state.phase4!.floors.find(({ rooms }) => rooms.length > 0)!;
  const oldFloorId = floor.id;
  floor.id = assertStableId("floor:28");
  for (const room of floor.rooms) room.floorId = floor.id;
  state.phase4!.building.purchasedFloorIds = state.phase4!.building.purchasedFloorIds
    .map((id) => id === oldFloorId ? floor.id : id);
  state.operations = createApprovedOperations();
  state.currentDay = 1;
  state.operations.dailyReports = [{
    day: 1,
    segments: GUEST_SEGMENT_IDS.map((segmentId) => ({
      segmentId, demand: 20, soldRooms: 10, averageRateCents: 80_000,
      revenueCents: 800_000, satisfactionBps: 7_000,
    })),
    revenueCents: 4_800_000,
    operatingCostCents: 1_000_000,
    financeCostCents: 0,
    netIncomeCents: 3_800_000,
    endingCashCents: state.cashCents,
    reputationBps: 5_100,
    bookings: floor.rooms.slice(0, 8).map((room, index) => ({
      segmentId: GUEST_SEGMENT_IDS[index % GUEST_SEGMENT_IDS.length],
      roomId: room.id,
      offerId: `offer:${room.id}`,
      rateCents: 80_000,
    })),
  }];
  for (const facility of Object.values(state.phase4!.facilities)) {
    facility.dailyResults = [{
      day: 1, visits: 24, revenueCents: 100_000, operatingCostCents: 20_000,
      utilizationBps: 7_500, satisfactionDeltaBps: 50, appealDeltaBps: 25,
      reasonCodes: [],
    }];
  }
  return state;
}

describe("aggregate hotel flow projection", () => {
  it("is deterministic, bounded, immutable, and covers player-facing flow kinds", () => {
    const state = flowState();
    const before = structuredClone(state);

    const first = projectFlowSnapshot(state, "floor:28");
    const second = projectFlowSnapshot(state, "floor:28");

    expect(second).toEqual(first);
    expect(first.events.length).toBeLessThanOrEqual(150);
    expect(new Set(first.events.map(({ kind }) => kind))).toEqual(new Set([
      "guest", "staff", "luggage", "cleaning", "room-service",
    ]));
    expect(first.events.every(({ x, y, targetX, targetY, count, label }) =>
      x >= 0 && x <= first.width && y >= 0 && y <= first.height
      && targetX >= 0 && targetX <= first.width && targetY >= 0 && targetY <= first.height
      && Number.isSafeInteger(count) && count > 0 && label.length <= 64)).toBe(true);
    expect(state).toEqual(before);
  });

  it("returns a safe empty projection for an unknown or unpurchased floor", () => {
    const state = flowState();
    state.phase4!.floors.find(({ id }) => id === "floor:28")!.purchased = false;

    expect(projectFlowSnapshot(state, "floor:28").events).toEqual([]);
    expect(projectFlowSnapshot(state, "floor:missing").events).toEqual([]);
  });
});
