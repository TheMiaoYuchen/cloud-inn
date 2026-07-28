import { describe, expect, it } from "vitest";

import {
  projectHotelInventory,
  projectHotelRoomOffers,
} from "../domain/building/hotelInventory";
import { previewExpansion } from "../domain/building/towerHotel";
import { createOperationsState } from "../domain/operations/createOperationsState";
import { createNewGame, type GameState } from "../domain/game/state";
import { createRectangle } from "../domain/room/grid";
import { CONTEMPORARY_ORIENTAL } from "../domain/design/stylePresets";
import { createCorridorTemplate } from "../domain/floor/corridorTemplate";
import type { PricePolicy } from "../domain/operations/pricing";
import { roomOfferUpgradeKey } from "../domain/operations/renovation";
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

async function masterOnlyOperationsCommands(saveId: string) {
  const store = new InMemorySavePort();
  const commands = createGameCommands(store);
  const initial = createPhase4AcceptanceState(saveId);
  initial.phase = "open";
  const state = await commands.initializeOperations(initial, "management");
  return { store, commands, state };
}

describe("atomic building commands", () => {
  it("validates authoritative inventory without an operations state before copying", async () => {
    const store = new RecordingSavePort();
    const commands = createGameCommands(store);
    const state = createPhase4AcceptanceState("building-copy-invalid-no-operations");
    state.phase4!.building.availableExpansionFloorNumbers = [17];
    const guestFloors = state.phase4!.floors.filter(({ use }) => use === "guest");
    guestFloors[1].rooms[0].roomBlueprintId =
      "room-blueprint:missing" as typeof guestFloors[1]["rooms"][number]["roomBlueprintId"];
    const snapshot = structuredClone(state);

    await expect(commands.copyFloor(state, guestFloors[0].id, 17))
      .rejects.toThrow("设计引用");

    expect(state).toEqual(snapshot);
    expect(store.commits).toBe(0);
    expect(await store.load(state.saveId)).toBeNull();
  });

  it("validates authoritative room area without an operations state before template sync", async () => {
    const store = new RecordingSavePort();
    const commands = createGameCommands(store);
    const state = createPhase4AcceptanceState("building-sync-invalid-area-no-operations");
    state.phase2!.roomMaster!.metrics.areaSquareMeters = 0;
    const selectedFloor = state.phase4!.floors.find(({ use }) => use === "guest")!;
    const snapshot = structuredClone(state);

    await expect(commands.syncFloorTemplate(state, [selectedFloor.id]))
      .rejects.toThrow("权威面积无效");

    expect(state).toEqual(snapshot);
    expect(store.commits).toBe(0);
    expect(await store.load(state.saveId)).toBeNull();
  });

  it("rejects template sync that would delete a paid renovation and preserves surviving upgrades", async () => {
    const removedStore = new RecordingSavePort();
    const removedCommands = createGameCommands(removedStore);
    const removed = createPhase4AcceptanceState("building-sync-paid-removed");
    const selectedFloor = removed.phase4!.floors.find(({ use }) => use === "guest")!;
    const removedOffer = projectHotelInventory(removed).rooms.find(
      ({ floorId }) => floorId === selectedFloor.id,
    )!;
    const paidUpgrade = {
      roomOfferId: removedOffer.id,
      upgradeId: "workspace",
      kind: "workspace" as const,
      level: 1,
      remainingClosureDays: 0,
      committedDay: 2,
      costCents: 120_000,
    };
    removed.operations = createOperationsState("management");
    removed.operations.offerUpgrades[
      roomOfferUpgradeKey(removedOffer.id, "workspace")
    ] = paidUpgrade;
    const template = removed.phase4!.floorTemplates[selectedFloor.templateId];
    template.roomPlacements = template.roomPlacements.filter(
      ({ id }) => id !== removedOffer.localPlacementId,
    );
    const removedSnapshot = structuredClone(removed);

    await expect(removedCommands.syncFloorTemplate(removed, [selectedFloor.id]))
      .rejects.toThrow("付费客房改造");
    expect(removed).toEqual(removedSnapshot);
    expect(removedStore.commits).toBe(0);
    expect(await removedStore.load(removed.saveId)).toBeNull();

    const survivingStore = new RecordingSavePort();
    const survivingCommands = createGameCommands(survivingStore);
    const surviving = createPhase4AcceptanceState("building-sync-paid-survives");
    const survivingFloor = surviving.phase4!.floors.find(({ use }) => use === "guest")!;
    const survivingOffer = projectHotelInventory(surviving).rooms.find(
      ({ floorId }) => floorId === survivingFloor.id,
    )!;
    const survivingUpgrade = { ...paidUpgrade, roomOfferId: survivingOffer.id };
    surviving.operations = createOperationsState("management");
    surviving.operations.offerUpgrades[
      roomOfferUpgradeKey(survivingOffer.id, "workspace")
    ] = survivingUpgrade;
    const survivingTemplate = surviving.phase4!.floorTemplates[survivingFloor.templateId];
    survivingTemplate.roomPlacements[0] = {
      ...survivingTemplate.roomPlacements[0],
      width: 5,
    };

    const synchronized = await survivingCommands.syncFloorTemplate(
      surviving,
      [survivingFloor.id],
    );

    expect(synchronized.operations!.offerUpgrades[
      roomOfferUpgradeKey(survivingOffer.id, "workspace")
    ]).toEqual(survivingUpgrade);
    expect(survivingStore.commits).toBe(1);
  });

  it("charges the expansion quote while copying the selected source floor", async () => {
    const store = new RecordingSavePort();
    const commands = createGameCommands(store);
    const state = createPhase4AcceptanceState("building-copy-paid-source");
    state.phase4!.building.availableExpansionFloorNumbers = [29];
    const guestFloors = state.phase4!.floors.filter(({ use }) => use === "guest");
    const firstSource = guestFloors[0];
    const selectedSource = guestFloors[1];
    firstSource.rooms[0].committedBuildCostCents = 111;
    selectedSource.rooms[0].committedBuildCostCents = 222;
    const preview = previewExpansion(state, 29);

    const copied = await commands.copyFloor(state, selectedSource.id, 29);
    const target = copied.phase4!.floors.find(({ floorNumber }) => floorNumber === 29)!;

    expect(copied.cashCents).toBe(state.cashCents - preview.costCents);
    expect(target.rooms[0].committedBuildCostCents).toBe(222);
    expect(target.rooms.map(({ committedBuildCostCents }) => committedBuildCostCents))
      .toEqual(selectedSource.rooms.map(({ committedBuildCostCents }) => committedBuildCostCents));
    expect(target.rooms[0].committedBuildCostCents)
      .not.toBe(firstSource.rooms[0].committedBuildCostCents);
    expect(store.commits).toBe(1);
    expect(await store.load(state.saveId)).toEqual(copied);
  });

  it("rejects unavailable, duplicate, over-capacity, and unaffordable floor copies before saving", async () => {
    const expectRejected = async (
      state: GameState,
      sourceFloorId: string,
      floorNumber: number,
      message: string,
    ) => {
      const store = new RecordingSavePort();
      const commands = createGameCommands(store);
      const snapshot = structuredClone(state);

      await expect(commands.copyFloor(state, sourceFloorId, floorNumber))
        .rejects.toThrow(message);
      expect(state).toEqual(snapshot);
      expect(store.commits).toBe(0);
      expect(await store.load(state.saveId)).toBeNull();
    };
    const unavailable = createPhase4AcceptanceState("building-copy-not-offered");
    const unavailableSource = unavailable.phase4!.floors.find(({ use }) => use === "guest")!;
    await expectRejected(unavailable, unavailableSource.id, 29, "不可扩建");

    const duplicate = createPhase4AcceptanceState("building-copy-duplicate");
    const duplicateSource = duplicate.phase4!.floors.find(({ use }) => use === "guest")!;
    await expectRejected(duplicate, duplicateSource.id, 5, "不可扩建");

    const capacity = createPhase4AcceptanceState("building-copy-capacity");
    const capacityGuests = capacity.phase4!.floors.filter(({ use }) => use === "guest");
    const reservoir = capacityGuests[capacityGuests.length - 1];
    reservoir.rooms.push(...Array.from({ length: 111 }, (_, index) => ({
      ...reservoir.rooms[0],
      id: `room:${reservoir.id}:capacity:${index + 1}` as typeof reservoir.rooms[0]["id"],
      localPlacementId: `capacity:${index + 1}` as typeof reservoir.rooms[0]["localPlacementId"],
    })));
    await expectRejected(capacity, capacityGuests[0].id, 17, "capacity-limit");

    const poor = createPhase4AcceptanceState("building-copy-cash");
    const poorSource = poor.phase4!.floors.find(({ use }) => use === "guest")!;
    poor.cashCents = previewExpansion(poor, 17).costCents - 1;
    await expectRejected(poor, poorSource.id, 17, "现金不足");
  });

  it("does not expose copied-floor payment or unlocks when persistence fails", async () => {
    const store = new InMemorySavePort();
    const initial = createPhase4AcceptanceState("building-copy-save-failure");
    initial.phase4!.catalogProgress.unlockedIds = [];
    const state = { ...initial, revision: 1 };
    await store.commit(0, state);
    const sourceSnapshot = structuredClone(state);
    const storedSnapshot = await store.load(state.saveId);
    let attempted: GameState | null = null;
    const commands = createGameCommands({
      load: (saveId) => store.load(saveId),
      commit: async (_expectedRevision, next) => {
        attempted = structuredClone(next);
        throw new Error("磁盘写入失败");
      },
    });
    const sourceFloor = state.phase4!.floors.find(({ use }) => use === "guest")!;
    const preview = previewExpansion(state, 17);

    await expect(commands.copyFloor(state, sourceFloor.id, 17))
      .rejects.toThrow("磁盘写入失败");

    expect(attempted!.cashCents).toBe(state.cashCents - preview.costCents);
    expect(attempted!.phase4!.catalogProgress.unlockedIds.length).toBeGreaterThan(0);
    expect(state).toEqual(sourceSnapshot);
    expect(await store.load(state.saveId)).toEqual(storedSnapshot);
  });

  it("syncs an official no-snapshot floor without mutating unselected physical baselines", async () => {
    const store = new RecordingSavePort();
    const commands = createGameCommands(store);
    const state = createPhase4AcceptanceState("building-direct-template-sync");
    const guestFloors = state.phase4!.floors.filter(({ use }) => use === "guest");
    const selectedFloor = guestFloors[0];
    const unselectedFloor = guestFloors[1];
    const unselectedRooms = structuredClone(unselectedFloor.rooms);
    const unselectedOffers = projectHotelInventory(state).rooms.filter(
      ({ floorId }) => floorId === unselectedFloor.id,
    );
    const template = state.phase4!.floorTemplates[selectedFloor.templateId];
    const edited: GameState = {
      ...state,
      phase4: {
        ...state.phase4!,
        floorTemplates: {
          ...state.phase4!.floorTemplates,
          [template.id]: {
            ...template,
            roomPlacements: template.roomPlacements.slice(1).map(
              (placement, index) => index === 0
                ? {
                    ...placement,
                    id: "placement:renamed" as typeof placement.id,
                  }
                : placement,
            ),
          },
        },
      },
    };

    const synchronized = await commands.syncFloorTemplate(
      edited,
      [selectedFloor.id],
    );
    const selectedAfter = synchronized.phase4!.floors.find(
      ({ id }) => id === selectedFloor.id,
    )!;
    const unselectedAfter = synchronized.phase4!.floors.find(
      ({ id }) => id === unselectedFloor.id,
    )!;
    const unselectedOffersAfter = projectHotelInventory(synchronized).rooms.filter(
      ({ floorId }) => floorId === unselectedFloor.id,
    );

    expect(selectedAfter.rooms).toHaveLength(9);
    expect(selectedAfter.rooms.map(({ localPlacementId }) => localPlacementId))
      .toContain("placement:renamed");
    expect(unselectedAfter.rooms).toEqual(unselectedRooms);
    expect(unselectedOffersAfter).toEqual(unselectedOffers);
    expect(store.commits).toBe(1);
    expect(await store.load(state.saveId)).toEqual(synchronized);
  });

  it("advances one operations day for a master-only Phase 4 hotel", async () => {
    const { commands, state } = await masterOnlyOperationsCommands(
      "building-master-operations-single",
    );

    const settled = await commands.advanceDay(state, 1_000);

    expect(settled.currentDay).toBe(1);
    expect(settled.operations!.dailyReports).toHaveLength(1);
    expect(settled.operations!.dailyReports[0].availableRooms).toBe(120);
  });

  it("advances an operations batch for a master-only Phase 4 hotel", async () => {
    const { commands, state } = await masterOnlyOperationsCommands(
      "building-master-operations-batch",
    );

    const settled = await commands.advanceOperationsDays(state, 2, 2_000);

    expect(settled.currentDay).toBe(2);
    expect(settled.operations!.dailyReports).toHaveLength(2);
    expect(settled.reports).toHaveLength(2);
  });

  it("settles offline operations for a master-only Phase 4 hotel", async () => {
    const { commands, state } = await masterOnlyOperationsCommands(
      "building-master-operations-offline",
    );
    const checkpointed = await commands.checkpointOfflineTime(state, 0);

    const settled = await commands.settleOffline(checkpointed, 2_000, 1_000);

    expect(settled.currentDay).toBe(2);
    expect(settled.operations!.dailyReports).toHaveLength(2);
    expect(settled.operations!.lastOfflineCheckpointMs).toBe(2_000);
  });

  it("rejects revision overflow before any building command persistence", async () => {
    const expectOverflowRejected = async (
      state: GameState,
      invoke: (commands: ReturnType<typeof createGameCommands>, state: GameState) => Promise<GameState>,
    ) => {
      const store = new RecordingSavePort();
      const commands = createGameCommands(store);

      await expect(invoke(commands, {
        ...state,
        revision: Number.MAX_SAFE_INTEGER,
      })).rejects.toThrow("修订号");
      expect(store.commits).toBe(0);
    };
    const phase4 = createPhase4AcceptanceState("building-revision-overflow");
    const source = phase4.phase4!.floors.find(({ use }) => use === "guest")!;

    await expectOverflowRejected(
      createNewGame("building-revision-initialize"),
      (commands, state) => commands.initializeContentScale(state),
    );
    await expectOverflowRejected(
      phase4,
      (commands, state) => commands.purchaseFloor(state, 17, "dense-ring"),
    );
    await expectOverflowRejected(
      phase4,
      (commands, state) => commands.copyFloor(state, source.id, 29),
    );
    await expectOverflowRejected(
      phase4,
      (commands, state) => commands.syncFloorTemplate(state, [source.id]),
    );
  });

  it("returns an existing content-scale state by identity without persisting", async () => {
    const store = new RecordingSavePort();
    const commands = createGameCommands(store);
    const state = createPhase4AcceptanceState("building-initialize-idempotent");
    const revision = state.revision;

    const result = await commands.initializeContentScale(state);

    expect(result).toBe(state);
    expect(result.revision).toBe(revision);
    expect(store.commits).toBe(0);
    expect(await store.load(state.saveId)).toBeNull();
  });

  it("validates existing content-scale revision and cash before idempotent return", async () => {
    const expectInvalidExistingRejected = async (
      state: GameState,
      message: string,
    ) => {
      const store = new RecordingSavePort();
      const commands = createGameCommands(store);

      await expect(commands.initializeContentScale(state)).rejects.toThrow(message);
      expect(store.commits).toBe(0);
    };
    const valid = createPhase4AcceptanceState("building-initialize-validation");

    await expectInvalidExistingRejected(
      { ...valid, revision: Number.MAX_SAFE_INTEGER },
      "修订号",
    );
    await expectInvalidExistingRejected(
      { ...valid, revision: 1.5 },
      "修订号",
    );
    await expectInvalidExistingRejected(
      { ...valid, cashCents: Number.MAX_SAFE_INTEGER + 1 },
      "金额",
    );
  });

  it("opens a master-only Phase 4 hotel with authoritative physical rooms", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createPhase4AcceptanceState("building-master-only-open");
    state.phase = "ready";

    const opened = await commands.openHotel(state);

    expect(opened.phase).toBe("open");
    expect(opened.roomBlueprint).toBeNull();
    expect(projectHotelRoomOffers(opened)).toHaveLength(120);
  });

  it("settles the expanded authoritative inventory without Phase 3 operations", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const initial = createPhase4AcceptanceState("building-legacy-settlement");
    const source = initial.phase4!.floors.find(({ use }) => use === "guest")!;
    const expanded = await commands.copyFloor(initial, source.id, 17);
    const opened: GameState = { ...expanded, phase: "open", operations: undefined };

    const settled = await commands.advanceDay(opened);

    expect(projectHotelRoomOffers(opened)).toHaveLength(130);
    expect(settled.latestReport?.availableRooms).toBe(130);
    expect(settled.latestReport?.soldRooms).toBeGreaterThan(0);
  });

  it("maps Phase 3 custom pricing and completed paid renovations to upgraded physical offers", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const cells = [
      ...createRectangle(0, 0, 8, 9, "bedroom"),
      ...createRectangle(0, 9, 8, 3, "bathroom"),
    ];
    let state = await commands.saveRoomSeries(createNewGame("building-migrate-paid"), {
      id: "room-master:migrate-paid",
      name: "迁移付费内容客房",
      cells,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    state = await commands.saveRoomBlueprint(state, "迁移付费内容客房", cells);
    state = await commands.chooseCorridorTemplate(
      state,
      createCorridorTemplate("complete-ring"),
    );
    const variantId = state.phase2!.roomVariants.find(
      ({ variantKind }) => variantKind === "king",
    )!.id;
    state = await commands.placeRoomVariant(state, {
      slotId: "north-west",
      variantId,
      rotation: 0,
      mirrored: false,
    });
    state = await commands.initializeOperations(state, "management");
    const oldOfferId = projectHotelRoomOffers(state)[0].id;
    const customPolicy: PricePolicy = {
      roomOfferId: oldOfferId,
      baseRateCents: 123_400,
      minRateCents: 111_100,
      maxRateCents: 222_200,
      automaticPricing: true,
      nightlyRateCents: 144_400,
    };
    const paidUpgrade = {
      roomOfferId: oldOfferId,
      upgradeId: "workspace",
      kind: "workspace" as const,
      level: 1,
      remainingClosureDays: 0,
      committedDay: 3,
      costCents: 120_000,
    };
    const legacyUpgrade = {
      roomOfferId: "legacy-deluxe",
      upgradeId: "club-access",
      level: 2,
    };
    state = {
      ...state,
      operations: {
        ...state.operations!,
        pricePolicies: { [oldOfferId]: customPolicy },
        offerUpgrades: {
          [roomOfferUpgradeKey(oldOfferId, "workspace")]: paidUpgrade,
          "legacy-deluxe": legacyUpgrade,
        },
      },
    };

    const upgraded = await commands.initializeContentScale(state);
    const newOfferId = projectHotelRoomOffers(upgraded)[0].id;

    expect(newOfferId).not.toBe(oldOfferId);
    expect(upgraded.operations!.pricePolicies[newOfferId]).toEqual({
      ...customPolicy,
      roomOfferId: newOfferId,
    });
    expect(upgraded.operations!.offerUpgrades[
      roomOfferUpgradeKey(newOfferId, "workspace")
    ]).toEqual({ ...paidUpgrade, roomOfferId: newOfferId });
    expect(upgraded.operations!.offerUpgrades["legacy-deluxe"]).toEqual(
      legacyUpgrade,
    );
    expect(upgraded.operations!.pricePolicies[oldOfferId]).toBeUndefined();
    expect(upgraded.operations!.offerUpgrades[
      roomOfferUpgradeKey(oldOfferId, "workspace")
    ]).toBeUndefined();
  });

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
    const initialized = await baselineCommands.initializeContentScale(initial);
    const state = { ...initialized, revision: initialized.revision + 1 };
    await store.commit(initialized.revision, state);
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
    const copied = await commands.copyFloor(state, source.id, 35);
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
    expect(synchronized.phase4!.floors.find(({ id }) => id === "floor:35")!.rooms)
      .toHaveLength(10);
    expect(Object.keys(synchronized.operations!.pricePolicies)).toEqual(
      projectHotelRoomOffers(synchronized).map(({ id }) => id),
    );
  });
});
