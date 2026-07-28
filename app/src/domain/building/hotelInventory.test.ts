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

  it("does not let unsynchronized canonical template edits mutate physical offers", () => {
    const state = createPhase4AcceptanceState("inventory-canonical-edit");
    const guestFloor = state.phase4!.floors.find(({ use }) => use === "guest")!;
    expect(state.phase4!.floorTemplates[`template-snapshot:${guestFloor.id}`])
      .toBeUndefined();
    const before = projectHotelRoomOffers(state);
    const changed = structuredClone(state);
    const template = changed.phase4!.floorTemplates[guestFloor.templateId];
    template.roomPlacements[0] = {
      ...template.roomPlacements[0],
      width: 9,
      height: 9,
    };

    const after = projectHotelRoomOffers(changed);

    expect(after).toEqual(before);
    expect(after[0].areaSquareMeters).toBe(24);
  });

  it("rejects missing and duplicate no-snapshot physical local placements", () => {
    const missing = createPhase4AcceptanceState("inventory-placement-missing");
    const missingFloor = missing.phase4!.floors.find(({ use }) => use === "guest")!;
    missingFloor.rooms[0].localPlacementId =
      "placement:missing" as typeof missingFloor.rooms[0]["localPlacementId"];

    expect(() => projectHotelInventory(missing)).toThrow("模板放置");

    const duplicate = createPhase4AcceptanceState("inventory-placement-duplicate");
    const duplicateFloor = duplicate.phase4!.floors.find(({ use }) => use === "guest")!;
    duplicateFloor.rooms[1].localPlacementId = duplicateFloor.rooms[0].localPlacementId;

    expect(() => projectHotelInventory(duplicate)).toThrow("本地放置编号重复");
  });

  it("rejects duplicate canonical placement IDs without a floor snapshot", () => {
    const state = createPhase4AcceptanceState("inventory-canonical-duplicate");
    const floor = state.phase4!.floors.find(({ use }) => use === "guest")!;
    const template = state.phase4!.floorTemplates[floor.templateId];
    template.roomPlacements[1] = {
      ...template.roomPlacements[1],
      id: template.roomPlacements[0].id,
    };

    expect(() => projectHotelInventory(state)).toThrow("客房放置编号重复");
  });

  it("uses selected floor snapshot geometry as area without changing unselected floors", () => {
    const game = createPhase4AcceptanceState("inventory-selected-area");
    const source = game.phase4!.floors.find(({ use }) => use === "guest")!;
    const copied = copyGuestFloor(game.phase4!, source.id, 29).phase4;
    const template = copied.floorTemplates[source.templateId];
    const placementId = template.roomPlacements[0].id;
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
    const synchronized = applyTemplateSync(changed, [source.id]);
    const inventory = projectHotelInventory({ ...game, phase4: synchronized });
    const selected = inventory.rooms.find(
      ({ floorId, localPlacementId }) =>
        floorId === source.id && localPlacementId === placementId,
    )!;
    const unselected = inventory.rooms.find(
      ({ floorId, localPlacementId }) =>
        floorId === "floor:29" && localPlacementId === placementId,
    )!;

    expect(selected.areaSquareMeters).toBe(30);
    expect(unselected.areaSquareMeters).toBe(24);
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

    expect(() => projectHotelRoomOffers(invalid)).toThrow("客房变体");
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
