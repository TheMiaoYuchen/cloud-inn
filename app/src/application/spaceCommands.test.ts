import { describe, expect, it } from "vitest";

import { assertStableId } from "../domain/building/buildingTypes";
import type { PublicSpaceBlueprint } from "../domain/spaces/spaceTypes";
import type { GameState } from "../domain/game/state";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";
import { createGameCommands } from "./gameCommands";
import type { SavePort } from "./ports/SavePort";

class RecordingPort implements SavePort {
  readonly stored = new InMemorySavePort();
  commits = 0;
  load(saveId: GameState["saveId"]) { return this.stored.load(saveId); }
  async commit(expectedRevision: number, next: GameState) {
    this.commits += 1;
    await this.stored.commit(expectedRevision, next);
  }
}

function validDiningBlueprint(
  id = "space-blueprint:new-dining",
): PublicSpaceBlueprint {
  const cells = [
    ...Array.from({ length: 10 * 10 }, (_, index) => ({
      x: index % 10, y: Math.floor(index / 10), zoneId: assertStableId("zone:seating"),
    })),
    ...Array.from({ length: 10 }, (_, y) => ({
      x: 10, y, zoneId: assertStableId("zone:service-route"),
    })),
    ...Array.from({ length: 3 * 10 }, (_, index) => ({
      x: 11 + index % 3, y: Math.floor(index / 3), zoneId: assertStableId("zone:kitchen"),
    })),
  ];
  return {
    id: assertStableId(id),
    type: "all-day-dining",
    name: "  云端全日餐厅  ",
    columns: 16,
    rows: 12,
    cells,
    placedItems: [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: assertStableId(`table:new:${index + 1}`),
        catalogItemId: assertStableId("item:dining-table"),
        x: index,
        y: 1,
        width: 1,
        height: 1,
        rotation: 0 as const,
      })),
      {
        id: assertStableId("service:new:1"),
        catalogItemId: assertStableId("item:service-counter"),
        x: 11, y: 1, width: 1, height: 1, rotation: 0,
      },
    ],
    walls: [], doors: [], windows: [],
    committedBuildCostCents: 1,
  };
}

function validBarBlueprint(): PublicSpaceBlueprint {
  const bar = { ...validDiningBlueprint(), type: "bar" as const };
  bar.cells = bar.cells.map((cell) => ({ ...cell,
    zoneId: cell.zoneId === "zone:kitchen" ? assertStableId("zone:bar-service") : cell.zoneId,
  }));
  bar.placedItems = bar.placedItems.map((item) => item.catalogItemId === "item:dining-table"
    ? { ...item, catalogItemId: assertStableId("item:lounge-seat") }
    : { ...item, catalogItemId: assertStableId("item:bar-counter") });
  return bar;
}

function scaleCommandFixture(saveId = "space-command") {
  const state = createPhase4AcceptanceState(saveId);
  state.cashCents = 50_000_000;
  const floor = state.phase4!.floors.find(({ id }) => id === "floor:03")!;
  const template = state.phase4!.floorTemplates[floor.templateId];
  template.publicSpaceSlots.push({
    id: assertStableId("space:99"),
    permittedTypes: ["all-day-dining", "bar"],
  });
  const store = new RecordingPort();
  return { state, store, commands: createGameCommands(store), floor };
}

describe("atomic public-space commands", () => {
  it("rejects blocking blueprints without persistence", async () => {
    const { state, store, commands } = scaleCommandFixture("space-invalid");
    const invalid = { ...validDiningBlueprint(), placedItems: [] };

    await expect(commands.savePublicSpaceBlueprint(state, invalid))
      .rejects.toThrow("缺少必需物件");
    expect(store.commits).toBe(0);
    expect(await store.load(state.saveId)).toBeNull();
  });

  it("rejects changing the type of a referenced blueprint", async () => {
    const { state, store, commands } = scaleCommandFixture("space-referenced-blueprint");
    const existing = state.phase4!.spaceBlueprints["space-blueprint:bar"];
    const input = validDiningBlueprint("space-blueprint:bar");

    await expect(commands.savePublicSpaceBlueprint(state, input))
      .rejects.toThrow("已建空间");
    expect(state.phase4!.spaceBlueprints[existing.id]).toBe(existing);
    expect(store.commits).toBe(0);
  });

  it.each([
    ["another type", () => ({
      ...validBarBlueprint(),
      id: assertStableId("space-blueprint:shared-protected"),
    })],
    ["a different design of the same type", () => ({
      ...validDiningBlueprint("space-blueprint:shared-protected"),
      name: "另一套共享餐厅设计",
    })],
  ] as const)("rejects replacing a shared blueprint with %s before charging", async (_label, replacement) => {
    const { state, commands, floor, store } = scaleCommandFixture("space-shared-overwrite");
    const first = await commands.placePublicSpace(
      state,
      validDiningBlueprint("space-blueprint:shared-protected"),
      floor.id,
    );
    const other = first.phase4!.publicSpaces["public-space:floor:02:space:02"];
    other.blueprintId = assertStableId("space-blueprint:shared-protected");
    const snapshot = structuredClone(first);
    store.commits = 0;

    await expect(commands.placePublicSpace(first, replacement(), floor.id))
      .rejects.toThrow("共享");

    expect(first).toEqual(snapshot);
    expect(store.commits).toBe(0);
  });

  it("accepts an exact shared blueprint despite object property order", async () => {
    const { state, commands, floor } = scaleCommandFixture("space-shared-exact");
    const first = await commands.placePublicSpace(
      state,
      validDiningBlueprint("space-blueprint:shared-exact"),
      floor.id,
    );
    const other = first.phase4!.publicSpaces["public-space:floor:02:space:02"];
    other.blueprintId = assertStableId("space-blueprint:shared-exact");
    const original = validDiningBlueprint("space-blueprint:shared-exact");
    const persisted = first.phase4!.spaceBlueprints[other.blueprintId];
    const reordered = {
      type: persisted.type,
      id: persisted.id,
      name: persisted.name,
      rows: persisted.rows,
      columns: persisted.columns,
      cells: persisted.cells,
      placedItems: persisted.placedItems,
      windows: original.windows,
      doors: original.doors,
      walls: original.walls,
      committedBuildCostCents: persisted.committedBuildCostCents,
    };
    first.phase4!.spaceBlueprints[other.blueprintId] = reordered;

    const next = await commands.placePublicSpace(first, original, floor.id);

    expect(next.phase4!.publicSpaces["public-space:floor:03:space:99"].blueprintId)
      .toBe("space-blueprint:shared-exact");
  });

  it("saves blueprint, instance and facility atomically", async () => {
    const { state, commands, store, floor } = scaleCommandFixture();

    const next = await commands.placePublicSpace(state, validDiningBlueprint(), floor.id);

    expect(next.cashCents).toBeLessThan(state.cashCents);
    expect(next.phase4!.facilities["facility:floor:03:all-day-dining"]).toBeDefined();
    expect(next.phase4!.publicSpaces["public-space:floor:03:space:99"]).toMatchObject({
      blueprintId: "space-blueprint:new-dining",
      localPlacementId: "space:99",
      type: "all-day-dining",
    });
    expect(next.phase4!.spaceBlueprints["space-blueprint:new-dining"].name)
      .toBe("云端全日餐厅");
    expect(next.phase4!.spaceBlueprints["space-blueprint:new-dining"].committedBuildCostCents)
      .toBeGreaterThan(1);
    expect(floor.publicSpaceInstanceIds).not.toContain("public-space:floor:03:space:99");
    expect(next.phase4!.floors.find(({ id }) => id === floor.id)!.publicSpaceInstanceIds)
      .toContain("public-space:floor:03:space:99");
    expect(next.revision).toBe(state.revision + 1);
    expect(store.commits).toBe(1);
    expect(await store.load(state.saveId)).toEqual(next);
  });

  it("validates floor slot, unlock, cash and revision before mutation", async () => {
    const cases: Array<[string, (state: GameState) => void, string]> = [
      ["wrong-floor", (state) => {
        const floor = state.phase4!.floors.find(({ id }) => id === "floor:03")!;
        floor.use = "guest";
      }, "设施楼层"],
      ["locked", (state) => {
        state.phase4!.catalogProgress.unlockedIds = [];
        state.operations = undefined;
      }, "尚未解锁"],
      ["cash", (state) => { state.cashCents = 0; }, "现金不足"],
      ["revision", (state) => { state.revision = Number.MAX_SAFE_INTEGER; }, "修订号"],
    ];
    for (const [suffix, arrange, message] of cases) {
      const { state, commands, store, floor } = scaleCommandFixture(`space-${suffix}`);
      arrange(state);
      const snapshot = structuredClone(state);
      const blueprint = suffix === "locked" ? validBarBlueprint() : validDiningBlueprint();
      await expect(commands.placePublicSpace(state, blueprint, floor.id))
        .rejects.toThrow(message);
      expect(state).toEqual(snapshot);
      expect(store.commits).toBe(0);
    }
  });

  it("requires a persisted unlock before placement and exposes it only after another mutation", async () => {
    const { state, commands, floor, store } = scaleCommandFixture("space-newly-eligible");
    state.phase4!.catalogProgress.unlockedIds = [];

    await expect(commands.placePublicSpace(state, validDiningBlueprint(), floor.id))
      .rejects.toThrow("尚未解锁");
    expect(store.commits).toBe(0);

    const reconciled = await commands.savePublicSpaceBlueprint(
      state,
      validDiningBlueprint("space-blueprint:unlock-step"),
    );
    expect(reconciled.phase4!.catalogProgress.unlockedIds)
      .toContain("facility:all-day-dining");

    const next = await commands.placePublicSpace(reconciled, validDiningBlueprint(), floor.id);

    expect(next.phase4!.catalogProgress.unlockedIds).toContain("facility:all-day-dining");
    expect(next.phase4!.publicSpaces["public-space:floor:03:space:99"]).toBeDefined();
  });

  it.each([
    ["cells", "空间单元数量超过上限"],
    ["placedItems", "空间物件数量超过上限"],
    ["doors", "空间开口数量超过上限"],
  ] as const)("rejects oversized %s even when the sanitized prefix is valid", async (field, message) => {
    const { state, commands, store } = scaleCommandFixture(`space-oversized-${field}`);
    const input = validDiningBlueprint();
    if (field === "cells") {
      input.cells = [...input.cells, ...Array.from({ length: 4_097 - input.cells.length }, (_, index) => ({
        x: index % input.columns,
        y: Math.floor(index / input.columns) % input.rows,
        zoneId: assertStableId("zone:seating"),
      }))];
    } else if (field === "placedItems") {
      input.placedItems = [...input.placedItems, ...Array.from({ length: 513 - input.placedItems.length }, (_, index) => ({
        ...input.placedItems[0], id: assertStableId(`overflow-item:${index}`),
      }))];
    } else {
      input.doors = Array.from({ length: 1_025 }, () => ({ x: 0, y: 0, side: "north" as const }));
    }

    await expect(commands.savePublicSpaceBlueprint(state, input)).rejects.toThrow(message);
    expect(store.commits).toBe(0);
  });

  it("replaces the existing same-type slot before selecting an empty compatible slot", async () => {
    const { state, commands, store } = scaleCommandFixture("space-duplicate-type");
    const floor = state.phase4!.floors.find(({ id }) => id === "floor:03")!;
    const template = state.phase4!.floorTemplates[floor.templateId];
    template.publicSpaceSlots.push({
      id: assertStableId("space:98"),
      permittedTypes: ["all-day-dining"],
    });
    const source = state.phase4!.publicSpaces["public-space:floor:02:space:02"];
    const instanceId = assertStableId("public-space:floor:03:space:98");
    state.phase4!.publicSpaces[instanceId] = {
      ...source,
      id: instanceId,
      floorId: floor.id,
      localPlacementId: assertStableId("space:98"),
    };
    state.phase4!.facilities["facility:floor:03:all-day-dining"] = {
      ...state.phase4!.facilities["facility:floor:02:all-day-dining"],
      id: assertStableId("facility:floor:03:all-day-dining"),
      publicSpaceInstanceId: instanceId,
    };
    floor.publicSpaceInstanceIds.push(instanceId);

    const previous = state.phase4!.publicSpaces[instanceId];
    const facility = state.phase4!.facilities["facility:floor:03:all-day-dining"];
    facility.developedOfferingIds = [assertStableId("dish:tea-smoked-duck")];
    const next = await commands.placePublicSpace(state, validDiningBlueprint(), floor.id);

    expect(next.phase4!.publicSpaces[instanceId].blueprintId)
      .toBe("space-blueprint:new-dining");
    expect(next.phase4!.publicSpaces["public-space:floor:03:space:99"])
      .toBeUndefined();
    expect(next.phase4!.facilities[facility.id].developedOfferingIds)
      .toEqual(["dish:tea-smoked-duck"]);
    expect(next.cashCents).toBe(
      state.cashCents + previous.committedBuildCostCents -
        next.phase4!.publicSpaces[instanceId].committedBuildCostCents,
    );
    expect(store.commits).toBe(1);
  });

  it("refunds only committed construction value and migrates compatible facility state", async () => {
    const { state, commands, floor } = scaleCommandFixture("space-replace-compatible");
    const first = await commands.placePublicSpace(state, validDiningBlueprint("space-blueprint:first"), floor.id);
    const facility = first.phase4!.facilities["facility:floor:03:all-day-dining"];
    facility.developedOfferingIds = [assertStableId("dish:tea-smoked-duck")];
    const oldValue = first.phase4!.publicSpaces[facility.publicSpaceInstanceId]
      .committedBuildCostCents;
    const replacementBlueprint = validDiningBlueprint("space-blueprint:replacement");
    replacementBlueprint.committedBuildCostCents = Number.MAX_SAFE_INTEGER;

    const next = await commands.placePublicSpace(first, replacementBlueprint, floor.id);
    const newValue = next.phase4!.publicSpaces[facility.publicSpaceInstanceId]
      .committedBuildCostCents;

    expect(next.cashCents).toBe(first.cashCents + oldValue - newValue);
    expect(next.phase4!.facilities[facility.id].developedOfferingIds)
      .toEqual(["dish:tea-smoked-duck"]);
    expect(next.phase4!.spaceBlueprints["space-blueprint:first"]).toBeUndefined();
  });

  it("atomically replaces an occupied compatible slot with a different facility type", async () => {
    const { state, commands, floor, store } = scaleCommandFixture("space-replace-incompatible");
    const first = await commands.placePublicSpace(state, validDiningBlueprint("space-blueprint:shared"), floor.id);
    const instance = first.phase4!.publicSpaces["public-space:floor:03:space:99"];
    const sharedInstance = first.phase4!.publicSpaces["public-space:floor:02:space:02"];
    sharedInstance.blueprintId = instance.blueprintId;
    const oldValue = instance.committedBuildCostCents;
    const snapshot = structuredClone(first);
    const bar = { ...validBarBlueprint(), id: assertStableId("space-blueprint:new-bar") };
    store.commits = 0;

    const next = await commands.placePublicSpace(first, bar, floor.id);
    const replacement = next.phase4!.publicSpaces[instance.id];

    expect(replacement).toMatchObject({
      id: instance.id,
      localPlacementId: "space:99",
      type: "bar",
      blueprintId: "space-blueprint:new-bar",
    });
    expect(next.phase4!.facilities["facility:floor:03:all-day-dining"]).toBeUndefined();
    expect(next.phase4!.facilities["facility:floor:03:bar"].publicSpaceInstanceId)
      .toBe(instance.id);
    expect(next.cashCents).toBe(
      first.cashCents + oldValue - replacement.committedBuildCostCents,
    );
    expect(next.phase4!.spaceBlueprints["space-blueprint:shared"]).toBeDefined();
    expect(next.phase4!.floors.find(({ id }) => id === floor.id)!.publicSpaceInstanceIds)
      .toContain(instance.id);
    expect(first).toEqual(snapshot);
    expect(store.commits).toBe(1);
    expect(await store.load(state.saveId)).toEqual(next);
  });

  it("replaces the first occupied compatible slot by stable slot id", async () => {
    const { state, commands, floor } = scaleCommandFixture("space-replace-first-occupied");
    const first = await commands.placePublicSpace(
      state,
      validDiningBlueprint("space-blueprint:occupied-high"),
      floor.id,
    );
    const template = first.phase4!.floorTemplates[floor.templateId];
    const lowerSlot = template.publicSpaceSlots.find(({ id }) => id === "space:04")!;
    lowerSlot.permittedTypes.push("bar");
    template.publicSpaceSlots.reverse();
    const bar = { ...validBarBlueprint(), id: assertStableId("space-blueprint:ordered-bar") };

    const next = await commands.placePublicSpace(first, bar, floor.id);

    expect(next.phase4!.publicSpaces["public-space:floor:03:space:04"].type).toBe("bar");
    expect(next.phase4!.publicSpaces["public-space:floor:03:space:99"].type)
      .toBe("all-day-dining");
  });

  it.each([
    ["duplicate occupied slot", (state: GameState) => {
      const floor = state.phase4!.floors.find(({ id }) => id === "floor:03")!;
      const source = state.phase4!.publicSpaces["public-space:floor:03:space:04"];
      const duplicateId = assertStableId("public-space:floor:03:duplicate");
      state.phase4!.publicSpaces[duplicateId] = { ...source, id: duplicateId };
      floor.publicSpaceInstanceIds.push(duplicateId);
    }],
    ["dangling floor reference", (state: GameState) => {
      state.phase4!.floors.find(({ id }) => id === "floor:03")!
        .publicSpaceInstanceIds.push(assertStableId("public-space:missing"));
    }],
    ["missing floor reference", (state: GameState) => {
      const floor = state.phase4!.floors.find(({ id }) => id === "floor:03")!;
      floor.publicSpaceInstanceIds = floor.publicSpaceInstanceIds
        .filter((id) => id !== "public-space:floor:03:space:04");
    }],
    ["unknown blueprint", (state: GameState) => {
      state.phase4!.publicSpaces["public-space:floor:03:space:04"].blueprintId =
        assertStableId("space-blueprint:missing");
    }],
  ] as const)("rejects a corrupt placement graph with %s without persistence", async (_label, corrupt) => {
    const { state, commands, floor, store } = scaleCommandFixture("space-corrupt-graph");
    corrupt(state);
    const snapshot = structuredClone(state);

    await expect(commands.placePublicSpace(state, validDiningBlueprint(), floor.id))
      .rejects.toThrow();

    expect(state).toEqual(snapshot);
    expect(store.commits).toBe(0);
  });

  it("does not charge, mutate, or expose reconciliation when persistence fails", async () => {
    const { state, floor } = scaleCommandFixture("space-port-failure");
    state.phase4!.catalogProgress.unlockedIds = [assertStableId("facility:all-day-dining")];
    const snapshot = structuredClone(state);
    const commands = createGameCommands({
      load: async () => null,
      commit: async () => { throw new Error("磁盘写入失败"); },
    });

    await expect(commands.placePublicSpace(state, validDiningBlueprint(), floor.id))
      .rejects.toThrow("磁盘写入失败");
    expect(state).toEqual(snapshot);
  });
});
