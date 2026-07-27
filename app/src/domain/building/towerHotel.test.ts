import { describe, expect, it } from "vitest";

import { createOperationsState } from "../operations/createOperationsState";
import { createCorridorTemplate, getTransformedRoomSize } from "../floor/corridorTemplate";
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

  it("migrates actual Phase 3 floor placements without changing selected transforms or progress", () => {
    const legacy = openedLegacyFixture();
    const corridorTemplate = createCorridorTemplate("complete-ring");
    const variant = {
      id: "room-blueprint:standard-twin",
      name: "标准双床房",
      masterId: legacy.roomBlueprint!.id,
      cells: Array.from({ length: 24 }, (_, index) => ({
        x: index % 4,
        y: Math.floor(index / 4),
        zone: index % 4 === 3 ? "bathroom" as const : "bedroom" as const,
      })),
      rotation: 0 as const,
      mirrored: false,
      overrides: ["bedType" as const],
      gene: {
        palette: "cloud-neutral",
        materials: ["oak"],
        metal: "brass",
        lighting: "warm",
        mood: "calm",
      },
      variantKind: "twin" as const,
      metrics: legacy.roomBlueprint!.metrics,
    };
    legacy.phase2 = {
      hotelGene: variant.gene,
      roomMaster: null,
      roomVariants: [variant],
      corridorTemplate,
      floorPlacements: corridorTemplate.slots.map((slot, index) => ({
        slotId: slot.id,
        variantId: variant.id,
        rotation: (index % 2 === 0 ? 0 : 90) as 0 | 90,
        mirrored: index % 3 === 0,
      })),
    };
    legacy.floor.rooms = corridorTemplate.slots.map((slot, index) => ({
      id: `room-${slot.id}`,
      slotId: slot.id,
      roomBlueprintId: legacy.roomBlueprint!.id,
      committedBuildCostCents: 2_400_000 + index,
    }));
    legacy.operations!.reputationBps = 7_123;
    legacy.operations!.maximumReputationBps = 7_123;
    legacy.reports = [{
      day: 1,
      availableRooms: 8,
      soldRooms: 4,
      occupancyBps: 5_000,
      rateCents: 88_800,
      revenueCents: 355_200,
      operatingCostCents: 100_000,
      netIncomeCents: 255_200,
      endingCashCents: legacy.cashCents,
      reasons: [],
    }];
    legacy.latestReport = legacy.reports[0];
    const cash = legacy.cashCents;
    const reports = legacy.reports;

    const upgraded = upgradeLegacyToPhase4(legacy);
    const guestFloor = upgraded.phase4!.floors.find(({ use }) => use === "guest")!;
    const guestTemplate = upgraded.phase4!.floorTemplates[guestFloor.templateId];

    for (const placement of legacy.phase2.floorPlacements!) {
      const migrated = guestTemplate.roomPlacements.find(({ id }) => id === placement.slotId)!;
      const slot = corridorTemplate.slots.find(({ id }) => id === placement.slotId)!;
      expect(migrated).toMatchObject({
        id: placement.slotId,
        roomBlueprintId: legacy.roomBlueprint!.id,
        variantId: placement.variantId,
        anchorX: slot.anchor.x,
        anchorY: slot.anchor.y,
        ...getTransformedRoomSize(variant.cells, placement.rotation),
        rotation: placement.rotation,
        mirrored: placement.mirrored,
      });
      expect(guestFloor.rooms.find(({ localPlacementId }) => localPlacementId === placement.slotId)).toMatchObject({
        roomBlueprintId: legacy.roomBlueprint!.id,
        variantId: placement.variantId,
      });
    }
    expect(upgraded.cashCents).toBe(cash);
    expect(upgraded.operations?.reputationBps).toBe(7_123);
    expect(upgraded.reports).toBe(reports);
    expect(upgraded.latestReport).toBe(legacy.latestReport);
  });

  it("rejects a partial Phase 3 placement join instead of inventing missing transforms", () => {
    const legacy = openedLegacyFixture();
    const variant = {
      id: "variant:standard",
      name: "标准房",
      masterId: legacy.roomBlueprint!.id,
      cells: legacy.roomBlueprint!.cells,
      rotation: 0 as const,
      mirrored: false,
      overrides: [],
      gene: {
        palette: "cloud-neutral",
        materials: ["oak"],
        metal: "brass",
        lighting: "warm",
        mood: "calm",
      },
      metrics: legacy.roomBlueprint!.metrics,
    };
    legacy.phase2 = {
      hotelGene: variant.gene,
      roomMaster: null,
      roomVariants: [variant],
      corridorTemplate: createCorridorTemplate("complete-ring"),
      floorPlacements: [{
        slotId: "north-west",
        variantId: variant.id,
        rotation: 0,
        mirrored: false,
      }],
    };
    legacy.floor.rooms[0] = {
      ...legacy.floor.rooms[0],
      slotId: "north-west",
    };

    expect(() => upgradeLegacyToPhase4(legacy)).toThrow("二期放置不完整");
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

  it("rejects duplicate template placement IDs before copy or sync", () => {
    const phase4 = createPhase4AcceptanceState("duplicate-placement").phase4!;
    const source = phase4.floors.find(({ use }) => use === "guest")!;
    const template = phase4.floorTemplates[source.templateId];
    template.roomPlacements[1] = {
      ...template.roomPlacements[1],
      id: template.roomPlacements[0].id,
    };

    expect(new Set(template.roomPlacements.map(({ id }) => id)).size).toBe(
      template.roomPlacements.length - 1,
    );

    const syncState = structuredClone(phase4);
    expect(() => copyGuestFloor(phase4, source.id, 29)).toThrow("放置编号重复");
    expect(() => applyTemplateSync(syncState, [source.id])).toThrow("放置编号重复");
  });

  it("rejects generated room IDs that collide with any existing physical room", () => {
    const phase4 = createPhase4AcceptanceState("room-collision").phase4!;
    const source = phase4.floors.find(({ use }) => use === "guest")!;
    const collidingId = assertStableId(
      `room:floor:29:${source.rooms[0].localPlacementId}`,
    );
    phase4.floors.find(({ id }) => id !== source.id)!.rooms.push({
      ...source.rooms[0],
      id: collidingId,
    });

    expect(phase4.floors.flatMap(({ rooms }) => rooms).map(({ id }) => id)).toContain(
      collidingId,
    );

    expect(() => copyGuestFloor(phase4, source.id, 29)).toThrow("客房编号冲突");
  });

  it("rejects synchronized room IDs that collide with another physical floor", () => {
    const phase4 = createPhase4AcceptanceState("sync-room-collision").phase4!;
    const source = phase4.floors.find(({ use }) => use === "guest")!;
    const collidingId = source.rooms[0].id;
    const other = phase4.floors.find(({ id }) => id !== source.id)!;
    other.rooms.push({
      ...source.rooms[0],
      id: collidingId,
      floorId: other.id,
    });

    expect(() => applyTemplateSync(phase4, [source.id])).toThrow("客房编号冲突");
  });

  it("previews deterministic template changes and synchronizes only selected floors", () => {
    const initial = createPhase4AcceptanceState("template-sync").phase4!;
    const copied = copyGuestFloor(
      initial,
      initial.floors.find(({ use }) => use === "guest")!.id,
      29,
    ).phase4;
    const state = copied;
    const guestFloors = state.floors.filter(({ use }) => use === "guest");
    const templateId = guestFloors[0].templateId;
    const template = state.floorTemplates[templateId];
    const firstPlacement = template.roomPlacements[0];
    const changed = {
      ...state,
      floorTemplates: {
        ...state.floorTemplates,
        [templateId]: {
          ...template,
          roomPlacements: template.roomPlacements.map((placement, index) =>
            index === 0
              ? {
                  ...placement,
                  anchorX: placement.anchorX + 1,
                  width: placement.height,
                  height: placement.width,
                  rotation: 90 as const,
                  mirrored: !placement.mirrored,
                }
              : placement,
          ),
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
    expect(synchronized.floors.find(({ id }) => id === selectedFloorId)?.rooms).toHaveLength(10);
    expect(synchronized.floors.find(({ id }) => id === untouchedFloorId)?.rooms).toHaveLength(10);
    expect(changed.floors.find(({ id }) => id === selectedFloorId)?.rooms).toHaveLength(10);
    expect(
      synchronized.floorTemplates[`template-snapshot:${selectedFloorId}`]
        .roomPlacements[0],
    ).toMatchObject({
      anchorX: firstPlacement.anchorX + 1,
      width: firstPlacement.height,
      height: firstPlacement.width,
      rotation: 90,
      mirrored: !firstPlacement.mirrored,
    });
    expect(
      synchronized.floorTemplates[`template-snapshot:${untouchedFloorId}`]
        .roomPlacements[0],
    ).toEqual(firstPlacement);
    const after = previewTemplateSync(synchronized, templateId);
    expect(after.find(({ floorId }) => floorId === selectedFloorId)?.changed).toBe(false);
    expect(after.find(({ floorId }) => floorId === untouchedFloorId)?.changed).toBe(true);
    expect(() => applyTemplateSync(changed, [assertStableId("floor:missing")])).toThrow("未知楼层");
  });
});
