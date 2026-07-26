import { describe, expect, it } from "vitest";

import { createNewGame } from "../domain/game/state";
import type { GameState } from "../domain/game/state";
import { prototypeConfig } from "../domain/config/prototypeConfig";
import { createRectangle } from "../domain/room/grid";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createGameCommands } from "./gameCommands";
import type { VisualProvider } from "./ports/VisualProvider";
import { CONTEMPORARY_ORIENTAL } from "../domain/design/stylePresets";
import {
  previewMasterSync,
  selectAllSyncChanges,
} from "../domain/design/roomSeries";

function prototypeCells() {
  return [
    ...createRectangle(0, 0, 8, 8, "bedroom"),
    ...createRectangle(0, 8, 8, 4, "bathroom"),
  ];
}

async function expectSavedRevision(
  previous: GameState,
  next: GameState,
  store: InMemorySavePort,
) {
  expect(next.revision).toBe(previous.revision + 1);
  expect(await store.load(next.saveId)).toEqual(next);
}

describe("game commands", () => {
  it("persists a room master and its deterministic variants without changing economics", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("save-series");
    const before = structuredClone(state);

    const next = await commands.saveRoomSeries(state, {
      id: "master-deluxe",
      name: "云岫豪华客房",
      cells: prototypeCells(),
      gene: CONTEMPORARY_ORIENTAL.gene,
    });

    await expectSavedRevision(state, next, store);
    expect(next.phase2?.roomMaster?.id).toBe("master-deluxe");
    expect(next.phase2?.roomVariants.map((variant) => variant.id)).toEqual([
      "master-deluxe-king",
      "master-deluxe-twin",
      "master-deluxe-corner",
    ]);
    expect(next.cashCents).toBe(before.cashCents);
    expect(next.reports).toEqual(before.reports);
    expect(next.floor).toEqual(before.floor);
  });

  it("persists only selected master synchronization changes", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomSeries(createNewGame("save-series"), {
      id: "master-deluxe",
      name: "云岫豪华客房",
      cells: prototypeCells(),
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    const master = state.phase2!.roomMaster!;
    const changedMaster = {
      ...master,
      gene: { ...master.gene, lighting: "3000K gallery lighting" },
    };
    const preview = selectAllSyncChanges(
      previewMasterSync(master, changedMaster, state.phase2!.roomVariants),
    ).map((change) => ({
      ...change,
      selected: change.variantId === "master-deluxe-king",
    }));
    const before = structuredClone(state);

    state = await commands.syncRoomSeries(state, changedMaster, preview);

    await expectSavedRevision(before, state, store);
    expect(state.phase2?.roomVariants[0]?.gene.lighting).toBe("3000K gallery lighting");
    expect(state.phase2?.roomVariants[1]?.gene.lighting).toBe(master.gene.lighting);
    expect(state.cashCents).toBe(before.cashCents);
    expect(state.reports).toEqual(before.reports);
  });

  it("persists a successful room visual without changing economics", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const designed = await commands.saveRoomBlueprint(
      createNewGame("save-1"),
      "云岫商务房",
      prototypeCells(),
    );
    const provider: VisualProvider = {
      generate: async () => ({ assetPath: "/visuals/prototype-room.svg" }),
    };
    const before = structuredClone(designed);

    const next = await commands.requestVisual(designed, provider);

    await expectSavedRevision(designed, next, store);
    expect(next.roomBlueprint?.visual).toEqual({
      status: "ready",
      assetPath: "/visuals/prototype-room.svg",
    });
    expect(next.roomBlueprint?.metrics).toEqual(before.roomBlueprint?.metrics);
    expect(next.cashCents).toBe(before.cashCents);
    expect(next.reports).toEqual(before.reports);
    expect(next.floor.rooms).toEqual(before.floor.rooms);
    expect(next.phase).toBe(before.phase);
    expect(next.currentDay).toBe(before.currentDay);
  });

  it("persists a failed room visual as an error without rejecting or changing economics", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const designed = await commands.saveRoomBlueprint(
      createNewGame("save-1"),
      "云岫商务房",
      prototypeCells(),
    );
    const provider: VisualProvider = {
      generate: async () => {
        throw new Error("服务不可用");
      },
    };
    const before = structuredClone(designed);

    const next = await commands.requestVisual(designed, provider);

    await expectSavedRevision(designed, next, store);
    expect(next.roomBlueprint?.visual).toEqual({
      status: "error",
      message: "服务不可用",
    });
    expect(next.roomBlueprint?.metrics).toEqual(before.roomBlueprint?.metrics);
    expect(next.cashCents).toBe(before.cashCents);
    expect(next.reports).toEqual(before.reports);
    expect(next.floor.rooms).toEqual(before.floor.rooms);
    expect(next.phase).toBe(before.phase);
    expect(next.currentDay).toBe(before.currentDay);
  });

  it("runs design, build, open, and two-day settlement with automatic saves", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = createNewGame("save-1");
    const cells = prototypeCells();

    let previous = state;
    state = await commands.saveRoomBlueprint(state, "云岫商务房", cells);
    await expectSavedRevision(previous, state, store);
    for (const slotId of ["slot-nw", "slot-ne", "slot-sw", "slot-se"]) {
      previous = state;
      state = await commands.placeRoom(state, slotId);
      await expectSavedRevision(previous, state, store);
    }
    expect(state.cashCents).toBe(53_600_000);

    previous = state;
    state = await commands.openHotel(state);
    await expectSavedRevision(previous, state, store);
    previous = state;
    state = await commands.advanceDay(state);
    await expectSavedRevision(previous, state, store);
    previous = state;
    state = await commands.setRate(state, 160_000);
    await expectSavedRevision(previous, state, store);
    previous = state;
    state = await commands.advanceDay(state);
    await expectSavedRevision(previous, state, store);

    expect(state.reports.map((report) => report.soldRooms)).toEqual([3, 0]);
    expect(await store.load("save-1")).toEqual(state);
  });

  it("does not deduct cash or create a save when placement has no blueprint", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("save-1");

    await expect(commands.placeRoom(state, "slot-nw")).rejects.toThrow(
      "请先保存房型",
    );
    expect(state.cashCents).toBe(100_000_000);
    expect(await store.load("save-1")).toBeNull();
  });

  it("trims the blueprint name and owns its configured grid cells", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("save-1");
    const stateSnapshot = structuredClone(state);
    const cells = prototypeCells();
    const cellsSnapshot = structuredClone(cells);

    const next = await commands.saveRoomBlueprint(
      state,
      "  云岫商务房  ",
      cells,
    );

    expect(state).toEqual(stateSnapshot);
    expect(cells).toEqual(cellsSnapshot);
    expect(next).toMatchObject({
      phase: "floor",
      roomBlueprint: {
        id: "room-type-1",
        name: "云岫商务房",
        columns: prototypeConfig.roomColumns,
        rows: prototypeConfig.roomRows,
        metrics: { areaSquareMeters: 24 },
        visual: { status: "idle" },
      },
    });
    expect(next.roomBlueprint?.cells).not.toBe(cells);
    cells[0].zone = "bathroom";
    expect(next.roomBlueprint?.cells[0].zone).toBe("bedroom");
  });

  it("rejects a blank blueprint name without changing state or saving", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("save-1");
    const snapshot = structuredClone(state);

    await expect(
      commands.saveRoomBlueprint(state, "   ", prototypeCells()),
    ).rejects.toThrow("房型名称不能为空");
    expect(state).toEqual(snapshot);
    expect(await store.load(state.saveId)).toBeNull();
  });

  it("rejects blueprint changes outside design without saving", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const designed = await commands.saveRoomBlueprint(
      createNewGame("save-1"),
      "初版",
      prototypeCells(),
    );
    const persisted = await store.load(designed.saveId);

    await expect(
      commands.saveRoomBlueprint(designed, "改版", prototypeCells()),
    ).rejects.toThrow("当前不能修改房型");
    expect(await store.load(designed.saveId)).toEqual(persisted);
  });

  it("keeps persisted cash and rooms intact after duplicate or insufficient placement", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const designed = await commands.saveRoomBlueprint(
      createNewGame("save-1"),
      "云岫商务房",
      prototypeCells(),
    );
    const built = await commands.placeRoom(designed, "slot-nw");
    const snapshot = structuredClone(built);

    await expect(commands.placeRoom(built, "slot-nw")).rejects.toThrow(
      "这个位置已有客房",
    );
    expect(built).toEqual(snapshot);
    expect(await store.load(built.saveId)).toEqual(snapshot);

    const noCash = { ...built, cashCents: 0 };
    await expect(commands.placeRoom(noCash, "slot-ne")).rejects.toThrow(
      "资金不足，设计已保留",
    );
    expect(noCash.cashCents).toBe(0);
    expect(await store.load(built.saveId)).toEqual(snapshot);
  });

  it("rejects an unsafe current cash value before placement arithmetic", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const designed = await commands.saveRoomBlueprint(
      createNewGame("save-1"),
      "云岫商务房",
      prototypeCells(),
    );
    const persisted = await store.load(designed.saveId);
    const unsafeCash = {
      ...designed,
      cashCents: Number.MAX_SAFE_INTEGER + 1,
    };

    await expect(commands.placeRoom(unsafeCash, "slot-nw")).rejects.toThrow(
      "金额必须是非负整数分",
    );
    expect(await store.load(designed.saveId)).toEqual(persisted);
  });

  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects invalid rate %s without saving",
    async (rateCents) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      const designed = await commands.saveRoomBlueprint(
        createNewGame("save-1"),
        "云岫商务房",
        prototypeCells(),
      );
      const persisted = await store.load(designed.saveId);

      await expect(commands.setRate(designed, rateCents)).rejects.toThrow(
        "房价必须大于零",
      );
      expect(await store.load(designed.saveId)).toEqual(persisted);
    },
  );

  it("allows rates after design and after opening", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame("save-1"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.setRate(state, 100_000);
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.setRate(state, 160_000);

    expect(state.phase).toBe("open");
    expect(state.rateCents).toBe(160_000);
    expect(await store.load(state.saveId)).toEqual(state);
  });

  it("enforces open and advance phases without duplicate commits", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const initial = createNewGame("save-1");

    await expect(commands.openHotel(initial)).rejects.toThrow(
      "至少建造一间客房才能开业",
    );
    await expect(commands.advanceDay(initial)).rejects.toThrow(
      "酒店尚未开业",
    );
    expect(await store.load(initial.saveId)).toBeNull();

    let opened = await commands.saveRoomBlueprint(
      initial,
      "云岫商务房",
      prototypeCells(),
    );
    opened = await commands.placeRoom(opened, "slot-nw");
    opened = await commands.openHotel(opened);
    const persisted = await store.load(opened.saveId);

    await expect(commands.openHotel(opened)).rejects.toThrow("当前不能开业");
    expect(await store.load(opened.saveId)).toEqual(persisted);
  });

  it("does not mutate the state supplied to settlement", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let opened = await commands.saveRoomBlueprint(
      createNewGame("save-1"),
      "云岫商务房",
      prototypeCells(),
    );
    opened = await commands.placeRoom(opened, "slot-nw");
    opened = await commands.openHotel(opened);
    const snapshot = structuredClone(opened);

    const settled = await commands.advanceDay(opened);

    expect(opened).toEqual(snapshot);
    expect(settled.reports).toHaveLength(1);
    expect(settled.latestReport).toBe(settled.reports[0]);
  });

  it("rejects a stale command and preserves the first divergent save", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const shared = createNewGame("save-1");

    const first = await commands.saveRoomBlueprint(
      shared,
      "先保存",
      prototypeCells(),
    );
    await expect(
      commands.saveRoomBlueprint(shared, "后保存", prototypeCells()),
    ).rejects.toThrow("存档已更新，请重新加载");
    expect(await store.load(shared.saveId)).toEqual(first);
  });
});

describe("InMemorySavePort", () => {
  it("clones values on commit and load in both directions", async () => {
    const store = new InMemorySavePort();
    const source = createNewGame("save-1");
    await store.commit(0, { ...source, revision: 1 });

    source.cashCents = 1;
    const firstLoad = await store.load(source.saveId);
    expect(firstLoad?.cashCents).toBe(100_000_000);

    if (!firstLoad) {
      throw new Error("expected save");
    }
    firstLoad.floor.rooms.push({
      id: "external-room",
      slotId: "slot-nw",
      roomBlueprintId: "external-blueprint",
      committedBuildCostCents: 1,
    });
    expect((await store.load(source.saveId))?.floor.rooms).toEqual([]);
  });

  it("allows the first commit at expected revision zero", async () => {
    const store = new InMemorySavePort();
    const first = { ...createNewGame("save-1"), revision: 1 };

    await store.commit(0, first);

    expect(await store.load(first.saveId)).toEqual(first);
  });

  it("rejects creating a missing save from a nonzero expected revision", async () => {
    const store = new InMemorySavePort();
    const next = { ...createNewGame("save-1"), revision: 8 };

    await expect(store.commit(7, next)).rejects.toThrow(
      "存档已更新，请重新加载",
    );
    expect(await store.load("save-1")).toBeNull();
  });

  it("requires the first save revision to advance from zero", async () => {
    const store = new InMemorySavePort();
    const next = { ...createNewGame("save-1"), revision: 2 };

    await expect(store.commit(0, next)).rejects.toThrow(
      "存档已更新，请重新加载",
    );
    expect(await store.load("save-1")).toBeNull();
  });

  it("rejects non-contiguous revisions without replacing the existing save", async () => {
    const store = new InMemorySavePort();
    const first = { ...createNewGame("save-1"), revision: 1 };
    await store.commit(0, first);
    const invalid = { ...first, revision: 3, rateCents: 123_000 };

    await expect(store.commit(1, invalid)).rejects.toThrow(
      "存档已更新，请重新加载",
    );
    expect(await store.load("save-1")).toEqual(first);
  });
});
