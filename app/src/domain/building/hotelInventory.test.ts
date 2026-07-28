import { describe, expect, it } from "vitest";

import { pricingContextForState } from "../../application/pricingContextForState";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { createOperationsState } from "../operations/createOperationsState";
import type { OperationsDailyReport } from "../operations/operationsTypes";
import { applyTemplateSync, copyGuestFloor } from "./towerHotel";
import {
  projectHotelInventory,
  projectHotelRoomOffers,
} from "./hotelInventory";

function dailyReportFixture(
  overrides: Readonly<{
    availableRooms: number;
    soldRooms: number;
    segmentDemand: Readonly<Record<string, number>>;
  }>,
): OperationsDailyReport {
  return {
    day: 1,
    segments: [
      "business",
      "couple",
      "family",
      "leisure",
      "high-net-worth",
      "cultural-experience",
    ].map((segmentId) => ({
      segmentId: segmentId as OperationsDailyReport["segments"][number]["segmentId"],
      demand: overrides.segmentDemand[segmentId] ?? 0,
      soldRooms: segmentId === "business" ? overrides.soldRooms : 0,
      averageRateCents: 88_000,
      revenueCents: segmentId === "business" ? overrides.soldRooms * 88_000 : 0,
      satisfactionBps: 7_000,
    })),
    revenueCents: overrides.soldRooms * 88_000,
    operatingCostCents: 1_000_000,
    financeCostCents: 0,
    netIncomeCents: overrides.soldRooms * 88_000 - 1_000_000,
    endingCashCents: 100_000_000,
    reputationBps: 6_000,
    availableRooms: overrides.availableRooms,
    soldRooms: overrides.soldRooms,
    occupancyBps: Math.trunc(
      (overrides.soldRooms * 10_000) / overrides.availableRooms,
    ),
    departmentCostCents: 1_000_000,
    roomRevenueCents: overrides.soldRooms * 88_000,
    loanInterestCents: 0,
    cashShortfallCents: 0,
    lostBookings: [],
    reviews: [],
    bookings: [],
    reputationDeltaBps: 0,
    discoveredNeeds: [],
  };
}

describe("authoritative hotel inventory", () => {
  it("uses Phase 4 inventory instead of double-counting legacy rooms", () => {
    const state = createPhase4AcceptanceState("inventory");
    state.floor.rooms.push({
      id: "legacy-duplicate",
      slotId: "legacy-slot",
      roomBlueprintId: "room-blueprint:standard-king",
      committedBuildCostCents: 1,
    });
    state.operations = createOperationsState();

    expect(projectHotelRoomOffers(state)).toHaveLength(120);
    expect(projectHotelInventory(state).rooms).toHaveLength(120);

    state.operations.dailyReports = [dailyReportFixture({
      availableRooms: 120,
      soldRooms: 60,
      segmentDemand: { business: 60 },
    })];

    expect(pricingContextForState(state).segmentDemandBps).toBe(5_000);
    expect(pricingContextForState(state).remainingInventoryBps).toBe(5_000);
  });

  it("uses each floor's applied placement snapshot until that floor is selected for sync", () => {
    const game = createPhase4AcceptanceState("inventory-snapshot");
    const phase4 = game.phase4!;
    const source = phase4.floors.find(({ use }) => use === "guest")!;
    const copied = copyGuestFloor(phase4, source.id, 29).phase4;
    const template = copied.floorTemplates[source.templateId];
    const changed = {
      ...copied,
      floorTemplates: {
        ...copied.floorTemplates,
        [template.id]: {
          ...template,
          roomPlacements: template.roomPlacements.map((placement, index) =>
            index === 0 ? { ...placement, width: 5 } : placement,
          ),
        },
      },
    };
    const selected = applyTemplateSync(changed, [source.id]);
    const projected = projectHotelInventory({ ...game, phase4: selected });
    const sourceRoom = projected.rooms.find(({ floorId }) => floorId === source.id)!;
    const copiedRoom = projected.rooms.find(({ floorId }) => floorId === "floor:29")!;

    expect(sourceRoom.areaSquareMeters).toBe(30);
    expect(copiedRoom.areaSquareMeters).toBe(24);
  });

  it("rejects colliding physical IDs and inconsistent design references", () => {
    const collision = createPhase4AcceptanceState("inventory-collision");
    const guestFloors = collision.phase4!.floors.filter(({ use }) => use === "guest");
    guestFloors[1].rooms[0] = {
      ...guestFloors[1].rooms[0],
      id: guestFloors[0].rooms[0].id,
    };

    expect(guestFloors[1].rooms[0].id).toBe(guestFloors[0].rooms[0].id);
    expect(collision.phase4!.floors.filter(({ use }) => use === "guest")[1].rooms[0].id)
      .toBe(guestFloors[0].rooms[0].id);
    expect(() => projectHotelInventory(collision)).toThrow("客房编号冲突");

    const invalid = createPhase4AcceptanceState("inventory-invalid-reference");
    const room = invalid.phase4!.floors.find(({ use }) => use === "guest")!.rooms[0];
    room.variantId = "variant:missing" as typeof room.variantId;

    expect(() => projectHotelRoomOffers(invalid)).toThrow("设计引用");
  });

  it("rejects duplicate public-space references on one floor", () => {
    const state = createPhase4AcceptanceState("inventory-space-collision");
    const floor = state.phase4!.floors.find(
      ({ publicSpaceInstanceIds }) => publicSpaceInstanceIds.length > 0,
    )!;
    floor.publicSpaceInstanceIds.push(floor.publicSpaceInstanceIds[0]);

    expect(() => projectHotelInventory(state)).toThrow("公共空间编号重复");
  });
});
