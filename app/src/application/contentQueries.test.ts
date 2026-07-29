import { describe, expect, it } from "vitest";
import { FACILITY_CATALOG } from "../domain/content/contentCatalog";
import { assertStableId } from "../domain/building/buildingTypes";
import { createOperationsState } from "../domain/operations/createOperationsState";
import { GUEST_SEGMENT_IDS } from "../domain/operations/operationsTypes";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";
import { validatePhase4State } from "../infrastructure/browser/validatePhase4State";
import {
  projectCompendia,
  projectDesignLibrary,
  projectMarketCompendium,
} from "./contentQueries";

describe("read-only content compendium queries", () => {
  it("projects the business market entry without mutating the game state", () => {
    const state = createPhase4AcceptanceState("compendium");
    const snapshot = structuredClone(state);

    const result = projectCompendia(state);

    expect(result.market.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ segmentId: "business" }),
    ]));
    expect(state).toEqual(snapshot);
  });

  it("gives every saved design its production floor usages", () => {
    const state = createPhase4AcceptanceState("library");

    const library = projectDesignLibrary(state);

    expect(library.entries.length).toBeGreaterThan(1);
    expect(library.entries.every(({ usageFloorIds }) => usageFloorIds.length > 0)).toBe(true);
    expect(library.hotelGene).toEqual(state.phase2!.hotelGene);
    expect(library.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "room-series", id: state.phase2!.roomMaster!.id }),
      expect.objectContaining({ kind: "public-space" }),
    ]));
  });

  it("includes an independently authoritative room blueprint once with exact usages", () => {
    const state = createPhase4AcceptanceState("independent-room-blueprint");
    const floor = state.phase4!.floors.find(({ rooms }) => rooms.length > 0)!;
    state.roomBlueprint = {
      ...structuredClone(state.phase2!.roomMaster!),
      id: assertStableId("room-blueprint:independent"),
      name: "Independent Room",
    };
    floor.rooms[0].roomBlueprintId = assertStableId(state.roomBlueprint.id);

    const library = projectDesignLibrary(state);

    expect(library.entries.filter(({ id }) => id === state.roomBlueprint!.id)).toEqual([{
      id: state.roomBlueprint.id,
      name: "Independent Room",
      kind: "room-series",
      usageFloorIds: [floor.id],
    }]);

    state.roomBlueprint = structuredClone(state.phase2!.roomMaster!);
    expect(projectDesignLibrary(state).entries.filter(({ id }) =>
      id === state.phase2!.roomMaster!.id)).toHaveLength(1);
  });

  it("merges cross-kind stable ID collisions without losing names or floor usages", () => {
    const state = createPhase4AcceptanceState("design-id-collision");
    const roomMaster = state.phase2!.roomMaster!;
    const publicSpace = Object.values(state.phase4!.publicSpaces)[0];
    const originalBlueprintId = publicSpace.blueprintId;
    const blueprint = state.phase4!.spaceBlueprints[originalBlueprintId];
    roomMaster.name = "Luxury / Suite";
    state.roomBlueprint = structuredClone(roomMaster);
    delete state.phase4!.spaceBlueprints[originalBlueprintId];
    blueprint.id = assertStableId(roomMaster.id);
    blueprint.name = "Collision Space";
    state.phase4!.spaceBlueprints[blueprint.id] = blueprint;
    publicSpace.blueprintId = blueprint.id;
    validatePhase4State(state.phase4, state);

    const library = projectDesignLibrary(state);
    const collisionEntries = library.entries.filter(({ id }) => id === roomMaster.id);
    const roomFloors = state.phase4!.floors
      .filter(({ rooms }) => rooms.some(({ roomBlueprintId }) => roomBlueprintId === roomMaster.id))
      .map(({ id }) => id);

    expect(collisionEntries).toHaveLength(1);
    expect(collisionEntries[0]).toMatchObject({
      kind: "mixed",
      name: "Luxury / Suite / Collision Space",
    });
    expect(collisionEntries[0].usageFloorIds).toEqual(
      [...new Set([...roomFloors, publicSpace.floorId])].sort(),
    );
    expect(new Set(library.entries.map(({ id }) => id)).size).toBe(library.entries.length);
  });

  it("keeps facilities in catalog order and reports real unlock state", () => {
    const state = createPhase4AcceptanceState("catalog-query");
    state.phase4!.catalogProgress.unlockedIds = [FACILITY_CATALOG[1].id];

    const content = projectCompendia(state).content;

    expect(content.facilities.map(({ id }) => id)).toEqual(
      FACILITY_CATALOG.map(({ id }) => id),
    );
    expect(content.facilities.filter(({ unlocked }) => unlocked).map(({ id }) => id))
      .toEqual([FACILITY_CATALOG[1].id]);
  });

  it("projects all six segments with discovered needs, facility interest and report evidence", () => {
    const state = createPhase4AcceptanceState("market-evidence");
    state.operations = createOperationsState("casual");
    state.operations.discoveredNeeds = [{
      id: "need:business:service",
      segmentId: "business",
      kind: "service",
      discoveredDay: 1,
      strengthBps: 7_500,
    }];
    state.operations.dailyReports = [{
      day: 1,
      segments: GUEST_SEGMENT_IDS.map((segmentId) => ({
        segmentId,
        demand: segmentId === "business" ? 8 : 1,
        soldRooms: segmentId === "business" ? 3 : 0,
        averageRateCents: segmentId === "business" ? 88_000 : 0,
        revenueCents: segmentId === "business" ? 264_000 : 0,
        satisfactionBps: 6_500,
      })),
      revenueCents: 264_000,
      operatingCostCents: 1,
      financeCostCents: 0,
      netIncomeCents: 263_999,
      endingCashCents: state.cashCents,
      reputationBps: 5_000,
      lostBookings: [{
        segmentId: "business",
        code: "service",
        count: 2,
        explanation: "入住服务能力不足",
      }],
      reviews: [{ segmentId: "business", ratingBps: 6_500, text: "办公便利" }],
    }];

    const market = projectMarketCompendium(state);
    const business = market.entries.find(({ segmentId }) => segmentId === "business")!;

    expect(market.entries.map(({ segmentId }) => segmentId)).toEqual(GUEST_SEGMENT_IDS);
    expect(business.discoveredNeeds).toEqual([
      expect.objectContaining({ kind: "service", strengthBps: 7_500 }),
    ]);
    expect(business.facilityInterests.length).toBeGreaterThan(0);
    expect(business.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "segment-result", day: 1 }),
      expect.objectContaining({ kind: "lost-booking", text: "入住服务能力不足" }),
      expect.objectContaining({ kind: "review", text: "办公便利" }),
    ]));
  });

  it("keeps undiscovered market details explicitly incomplete", () => {
    const state = createPhase4AcceptanceState("market-locked");
    state.phase4!.catalogProgress.discoveredMarketEntryIds = [];
    state.operations = createOperationsState("casual");
    state.operations.discoveredNeeds = [];
    state.operations.dailyReports = [];

    const market = projectMarketCompendium(state);

    expect(market.entries).toHaveLength(6);
    expect(market.entries.every(({ discovered, hardNeeds, preferences, facilityInterests }) =>
      !discovered && hardNeeds.length === 0 && preferences.length === 0
      && facilityInterests.length === 0)).toBe(true);
  });
});
