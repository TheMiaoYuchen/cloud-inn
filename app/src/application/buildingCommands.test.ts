import { describe, expect, it } from "vitest";

import { projectHotelRoomOffers } from "../domain/building/hotelInventory";
import { previewExpansion } from "../domain/building/towerHotel";
import { createOperationsState } from "../domain/operations/createOperationsState";
import type { GameState } from "../domain/game/state";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";
import { createGameCommands } from "./gameCommands";
import type { SavePort } from "./ports/SavePort";

class RecordingSavePort implements SavePort {
  readonly stored = new InMemorySavePort();
  commits = 0;

  load(saveId: GameState["saveId"]) {
    return this.stored.load(saveId);
  }

  async commit(expectedRevision: number, next: GameState): Promise<void> {
    this.commits += 1;
    await this.stored.commit(expectedRevision, next);
  }
}

async function initializedScaleCommands() {
  const store = new RecordingSavePort();
  const commands = createGameCommands(store);
  const initial = createPhase4AcceptanceState("building-purchase");
  initial.phase4!.building.availableExpansionFloorNumbers = [35];
  initial.operations = createOperationsState("management");
  const state = await commands.initializeContentScale(initial);
  return { state, commands, store };
}

describe("atomic building commands", () => {
  it("atomically buys and populates one floor while reconciling pricing", async () => {
    const { state, commands, store } = await initializedScaleCommands();
    const preview = previewExpansion(state, 35);
    const commitsBeforePurchase = store.commits;

    const next = await commands.purchaseFloor(state, 35, "dense-ring");

    expect(next.cashCents).toBe(state.cashCents - preview.costCents);
    expect(Object.keys(next.operations!.pricePolicies)).toEqual(
      projectHotelRoomOffers(next).map(({ id }) => id),
    );
    expect(next.revision).toBe(state.revision + 1);
    expect(store.commits).toBe(commitsBeforePurchase + 1);
    expect(await store.load(next.saveId)).toEqual(next);
  });

  it("does not mutate source, stored revision, or expose projected unlocks when persistence fails", async () => {
    const store = new InMemorySavePort();
    const initial = createPhase4AcceptanceState("building-save-failure");
    initial.phase4!.catalogProgress.unlockedIds = [];
    initial.operations = createOperationsState("management");
    const baselineCommands = createGameCommands(store);
    const state = await baselineCommands.initializeContentScale(initial);
    const source = {
      ...state,
      phase4: {
        ...state.phase4!,
        catalogProgress: {
          ...state.phase4!.catalogProgress,
          unlockedIds: [],
        },
      },
    };
    const sourceSnapshot = structuredClone(source);
    const storedSnapshot = await store.load(state.saveId);
    const failingPort: SavePort = {
      load: (saveId) => store.load(saveId),
      commit: async () => {
        throw new Error("磁盘写入失败");
      },
    };
    const commands = createGameCommands(failingPort);

    await expect(commands.purchaseFloor(source, 17, "dense-ring"))
      .rejects.toThrow("磁盘写入失败");

    expect(source).toEqual(sourceSnapshot);
    expect(source.phase4!.catalogProgress.unlockedIds).toEqual([]);
    expect(await store.load(state.saveId)).toEqual(storedSnapshot);
    expect((await store.load(state.saveId))!.revision).toBe(state.revision);
  });

  it("copies and selectively synchronizes floors through the same command facade", async () => {
    const { state, commands } = await initializedScaleCommands();
    const source = state.phase4!.floors.find(({ use }) => use === "guest")!;
    const copied = await commands.copyFloor(state, source.id, 34);
    const template = copied.phase4!.floorTemplates[source.templateId];
    const edited: GameState = {
      ...copied,
      phase4: {
        ...copied.phase4!,
        floorTemplates: {
          ...copied.phase4!.floorTemplates,
          [template.id]: {
            ...template,
            roomPlacements: template.roomPlacements.slice(0, 9),
          },
        },
      },
    };

    const synchronized = await commands.syncFloorTemplate(edited, [source.id]);

    expect(synchronized.phase4!.floors.find(({ id }) => id === source.id)!.rooms)
      .toHaveLength(9);
    expect(synchronized.phase4!.floors.find(({ id }) => id === "floor:34")!.rooms)
      .toHaveLength(10);
    expect(Object.keys(synchronized.operations!.pricePolicies)).toEqual(
      projectHotelRoomOffers(synchronized).map(({ id }) => id),
    );
  });
});
