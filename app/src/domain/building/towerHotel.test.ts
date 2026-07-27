import { describe, expect, it } from "vitest";

import { createOperationsState } from "../operations/createOperationsState";
import { createNewGame, type GameState } from "../game/state";
import { assertStableId } from "./buildingTypes";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import {
  applyExpansion,
  applyTemplateSync,
  copyGuestFloor,
  previewExpansion,
  previewTemplateSync,
  projectScaleRooms,
  upgradeLegacyToPhase4,
} from "./towerHotel";

function openedLegacyFixture(): GameState {
  const state = createNewGame("legacy-tower");
  const roomBlueprint = {
    id: "room-blueprint:standard",
    name: "标准大床房",
    columns: 4,
    rows: 6,
    cells: Array.from({ length: 24 }, (_, index) => ({
      x: index % 4,
      y: Math.floor(index / 4),
      zone: index % 4 === 3 ? "bathroom" as const : "bedroom" as const,
    })),
    metrics: {
      areaSquareMeters: 24,
      buildCostCents: 2_400_000,
      suggestedRateCents: 88_800,
      businessFitBps: 6_000,
    },
    visual: { status: "idle" as const },
  };
  const rooms = Array.from({ length: 8 }, (_, index) => ({
    id: `legacy-room:${index + 1}`,
    slotId: `legacy-slot:${index + 1}`,
    roomBlueprintId: roomBlueprint.id,
    committedBuildCostCents: roomBlueprint.metrics.buildCostCents,
  }));
  return {
    ...state,
    phase: "open",
    cashCents: 123_456_789,
    roomBlueprint,
    floor: { id: "prototype-floor", rooms },
    operations: createOperationsState(),
  };
}

describe("tower hotel", () => {
  it("upgrades one legacy hotel exactly once without charging cash", () => {
    const legacy = openedLegacyFixture();
    const snapshot = structuredClone(legacy);

    const first = upgradeLegacyToPhase4(legacy);
    const second = upgradeLegacyToPhase4(first);

    expect(second).toEqual(first);
    expect(second).toBe(first);
    expect(first.cashCents).toBe(legacy.cashCents);
    expect(first.operations?.reputationBps).toBe(legacy.operations?.reputationBps);
    expect(first.reports).toBe(legacy.reports);
    expect(projectScaleRooms(first).length).toBeGreaterThanOrEqual(8);
    expect(legacy).toEqual(snapshot);
  });

  it("creates entrance, sky-lobby, service, and true-size guest floor markers", () => {
    const upgraded = upgradeLegacyToPhase4(openedLegacyFixture());
    const phase4 = upgraded.phase4!;
    const guestFloor = phase4.floors.find(({ use }) => use === "guest")!;
    const guestTemplate = phase4.floorTemplates[guestFloor.templateId];

    expect(phase4.floors.map(({ use }) => use)).toEqual([
      "entrance",
      "sky-lobby",
      "service",
      "guest",
    ]);
    expect(guestFloor.rooms.map(({ roomBlueprintId }) => roomBlueprintId)).toEqual(
      Array(8).fill("room-blueprint:standard"),
    );
    expect(guestTemplate.cellAreaSquareMeters).toBe(1);
    expect(guestTemplate.roomPlacements).toHaveLength(8);
    expect(guestTemplate.roomPlacements.every(({ width, height }) => width * height === 24)).toBe(true);
  });

  it("derives migrated room identity from stable legacy slots rather than array position", () => {
    const firstLegacy = openedLegacyFixture();
    const secondLegacy = structuredClone(firstLegacy);
    secondLegacy.floor.rooms.reverse();

    const firstIds = projectScaleRooms(upgradeLegacyToPhase4(firstLegacy))
      .map(({ localPlacementId }) => localPlacementId)
      .sort();
    const secondIds = projectScaleRooms(upgradeLegacyToPhase4(secondLegacy))
      .map(({ localPlacementId }) => localPlacementId)
      .sort();

    expect(secondIds).toEqual(firstIds);
    expect(firstIds).toEqual(
      firstLegacy.floor.rooms.map(({ slotId }) => slotId).sort(),
    );
  });

  it("copies a guest floor with new room IDs and unchanged template references", () => {
    const state = createPhase4AcceptanceState("copy-floor").phase4!;
    const source = state.floors.find(({ use }) => use === "guest")!;
    const snapshot = structuredClone(state);

    const result = copyGuestFloor(state, source.id, 29);

    expect(result.floor.id).toBe("floor:29");
    expect(result.floor.templateId).toBe(source.templateId);
    expect(result.floor.rooms.every((room) => room.floorId === "floor:29")).toBe(true);
    expect(new Set(result.floor.rooms.map((room) => room.id)).size).toBe(result.floor.rooms.length);
    expect(result.floor.rooms.map(({ roomBlueprintId, variantId }) => ({ roomBlueprintId, variantId }))).toEqual(
      source.rooms.map(({ roomBlueprintId, variantId }) => ({ roomBlueprintId, variantId })),
    );
    expect(state).toEqual(snapshot);
  });

  it("previews and applies an expansion without mutating cash or source state", () => {
    const game = upgradeLegacyToPhase4(openedLegacyFixture());
    const floorNumber = game.phase4!.building.availableExpansionFloorNumbers[0];
    const snapshot = structuredClone(game.phase4!);
    const preview = previewExpansion(game, floorNumber);

    const result = applyExpansion(game.phase4!, floorNumber);

    expect(preview).toMatchObject({ floorNumber, available: true });
    expect(preview.costCents).toBe(result.costCents);
    expect(Number.isSafeInteger(result.costCents)).toBe(true);
    expect(result.phase4.floors.some((floor) => floor.floorNumber === floorNumber)).toBe(true);
    expect(result.phase4.building.availableExpansionFloorNumbers).not.toContain(floorNumber);
    expect(game.phase4).toEqual(snapshot);
    expect(game.cashCents).toBe(123_456_789);
  });

  it("rejects unavailable, duplicate, and invalid floor targets", () => {
    const game = upgradeLegacyToPhase4(openedLegacyFixture());

    expect(previewExpansion(game, 4).available).toBe(false);
    expect(() => applyExpansion(game.phase4!, 4)).toThrow("不可扩建");
    expect(() => copyGuestFloor(game.phase4!, "floor:missing", 8)).toThrow("源客房楼层");
    expect(() => copyGuestFloor(game.phase4!, "floor:4", 1.5)).toThrow("楼层编号");
  });

  it("rejects a floor copy that exceeds the bounded room inventory", () => {
    const phase4 = upgradeLegacyToPhase4(openedLegacyFixture()).phase4!;
    const source = phase4.floors.find(({ use }) => use === "guest")!;
    source.rooms = Array.from({ length: 240 }, (_, index) => {
      const localPlacementId = assertStableId(`legacy-slot:bounded:${index + 1}`);
      return {
        ...source.rooms[0],
        id: assertStableId(`room:${source.id}:${localPlacementId}`),
        localPlacementId,
      };
    });

    expect(() => copyGuestFloor(phase4, source.id, 5)).toThrow("客房数量");
  });

  it("previews deterministic template changes and synchronizes only selected floors", () => {
    const state = createPhase4AcceptanceState("template-sync").phase4!;
    const guestFloors = state.floors.filter(({ use }) => use === "guest");
    const templateId = guestFloors[0].templateId;
    const template = state.floorTemplates[templateId];
    const changed = {
      ...state,
      floorTemplates: {
        ...state.floorTemplates,
        [templateId]: {
          ...template,
          roomPlacements: template.roomPlacements.slice(0, 8),
        },
      },
    };

    const preview = previewTemplateSync(changed, templateId);
    const selectedFloorId = guestFloors[0].id;
    const untouchedFloorId = guestFloors[1].id;
    const synchronized = applyTemplateSync(changed, [selectedFloorId]);

    expect(preview.map(({ floorId }) => floorId)).toEqual(
      guestFloors.map(({ id }) => id),
    );
    expect(preview.every(({ changed: isChanged }) => isChanged)).toBe(true);
    expect(synchronized.floors.find(({ id }) => id === selectedFloorId)?.rooms).toHaveLength(8);
    expect(synchronized.floors.find(({ id }) => id === untouchedFloorId)?.rooms).toHaveLength(10);
    expect(changed.floors.find(({ id }) => id === selectedFloorId)?.rooms).toHaveLength(10);
    expect(() => applyTemplateSync(changed, [assertStableId("floor:missing")])).toThrow("未知楼层");
  });
});
