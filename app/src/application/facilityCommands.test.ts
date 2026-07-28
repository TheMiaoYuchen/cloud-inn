import { describe, expect, it } from "vitest";

import { assertStableId } from "../domain/building/buildingTypes";
import {
  FACILITY_OFFERINGS,
  createFacilityPolicy,
} from "../domain/facilities/facilityOperations";
import type { GameState } from "../domain/game/state";
import type { PublicSpaceBlueprint } from "../domain/spaces/spaceTypes";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";
import {
  SIGNATURE_DEVELOPMENT_COST_CENTS,
  createFacilityCommands,
} from "./facilityCommands";
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

function activeDiningCommandFixture(saveId = "facility-command") {
  const state = createPhase4AcceptanceState(saveId);
  state.cashCents = 5_000_000;
  const facilityId = "facility:floor:02:all-day-dining";
  const facility = state.phase4!.facilities[facilityId];
  facility.policy = null;
  facility.enabled = false;
  facility.status = "planned";
  facility.developedOfferingIds = [];
  const store = new RecordingPort();
  return { state, facilityId, facility, store, commands: createGameCommands(store) };
}

function diningPolicy() {
  return createFacilityPolicy("all-day-dining", {
    positioningId: "positioning:international-luxury",
    priceBandId: "price-band:premium",
    capacity: 84,
    openingPolicyId: "opening-policy:breakfast-dinner",
    serviceBudgetCents: 180_000,
  });
}

function validBoostBlueprint(
  type: "sky-lobby" | "pool" | "gym",
  id: string,
): PublicSpaceBlueprint {
  if (type === "gym") {
    return {
      id: assertStableId(id), type, name: "健身房", columns: 10, rows: 8,
      cells: Array.from({ length: 80 }, (_, index) => ({
        x: index % 10, y: Math.floor(index / 10), zoneId: assertStableId("zone:fitness"),
      })),
      placedItems: Array.from({ length: 4 }, (_, index) => ({
        id: assertStableId(`boost:gym:item:${index}`),
        catalogItemId: assertStableId("item:fitness-station"),
        x: index, y: 1, width: 1, height: 1, rotation: 0,
      })), walls: [], doors: [], windows: [], committedBuildCostCents: 0,
    };
  }
  if (type === "pool") {
    const cells = [
      ...Array.from({ length: 16 }, (_, index) => ({
        x: 3 + index % 4, y: 3 + Math.floor(index / 4), zoneId: assertStableId("zone:wet"),
      })),
      ...Array.from({ length: 6 }, (_, x) => ({ x: x + 2, y: 2, zoneId: assertStableId("zone:deck") })),
      ...Array.from({ length: 6 }, (_, x) => ({ x: x + 2, y: 7, zoneId: assertStableId("zone:deck") })),
      ...Array.from({ length: 4 }, (_, y) => ({ x: 2, y: y + 3, zoneId: assertStableId("zone:deck") })),
      ...Array.from({ length: 4 }, (_, y) => ({ x: 7, y: y + 3, zoneId: assertStableId("zone:deck") })),
      { x: 0, y: 2, zoneId: assertStableId("zone:wet-route") },
      { x: 1, y: 2, zoneId: assertStableId("zone:wet-route") },
    ];
    return {
      id: assertStableId(id), type, name: "泳池", columns: 12, rows: 12, cells,
      placedItems: [{
        id: assertStableId("boost:pool:item"), catalogItemId: assertStableId("item:pool"),
        x: 3, y: 3, width: 4, height: 4, rotation: 0,
      }], walls: [], doors: [{ x: 0, y: 2, side: "west" }], windows: [], committedBuildCostCents: 0,
    };
  }
  const cells = [
    ...Array.from({ length: 4 }, (_, index) => ({ x: index % 2, y: Math.floor(index / 2), zoneId: assertStableId("zone:arrival") })),
    ...Array.from({ length: 8 }, (_, index) => ({ x: index % 2, y: 2 + Math.floor(index / 2), zoneId: assertStableId("zone:entrance") })),
    ...Array.from({ length: 8 }, (_, index) => ({ x: 2 + index % 2, y: 2 + Math.floor(index / 2), zoneId: assertStableId("zone:reception") })),
    ...Array.from({ length: 20 }, (_, index) => ({ x: 4 + index % 5, y: Math.floor(index / 5), zoneId: assertStableId("zone:waiting") })),
    ...Array.from({ length: 4 }, (_, index) => ({ x: 2 + index % 2, y: 6 + Math.floor(index / 2), zoneId: assertStableId("zone:luggage") })),
    ...Array.from({ length: 20 }, (_, index) => ({ x: 4 + index % 5, y: 4 + Math.floor(index / 5), zoneId: assertStableId("zone:elevator-lobby") })),
  ];
  return {
    id: assertStableId(id), type, name: "空中大堂", columns: 12, rows: 12, cells,
    placedItems: [
      { id: assertStableId("boost:lobby:desk"), catalogItemId: assertStableId("item:reception-desk"), x: 2, y: 2, width: 1, height: 1, rotation: 0 },
      ...Array.from({ length: 5 }, (_, index) => ({ id: assertStableId(`boost:lobby:seat:${index}`), catalogItemId: assertStableId("item:lounge-seat"), x: 4 + index, y: 1, width: 1, height: 1, rotation: 0 as const })),
    ], walls: [], doors: [{ x: 0, y: 2, side: "west" }], windows: [], committedBuildCostCents: 0,
  };
}

describe("atomic facility commands", () => {
  it("exports the authoritative maximum catalog development cost", () => {
    expect(SIGNATURE_DEVELOPMENT_COST_CENTS).toBe(
      Math.max(...FACILITY_OFFERINGS.map(({ developmentCostCents }) => developmentCostCents)),
    );
    expect(SIGNATURE_DEVELOPMENT_COST_CENTS).toBe(700_000);
  });

  it("configures a facility while preserving unrelated state", async () => {
    const { state, facilityId, facility, commands, store } = activeDiningCommandFixture();
    const unrelated = structuredClone(state.phase4!.facilities["facility:floor:02:bar"]);

    const next = await commands.configureFacility(state, facilityId, diningPolicy());

    expect(next.phase4!.facilities[facilityId]).toMatchObject({
      policy: diningPolicy(), enabled: false, status: "planned",
    });
    expect(next.phase4!.facilities["facility:floor:02:bar"]).toEqual(unrelated);
    expect(facility.policy).toBeNull();
    expect(store.commits).toBe(1);
    expect(await store.load(state.saveId)).toEqual(next);
  });

  it("rejects configuring a signature that has not been developed", async () => {
    const { state, facilityId, commands, store } = activeDiningCommandFixture("facility-config-signature");
    const policy = { ...diningPolicy(),
      signatureOfferingId: assertStableId("dish:tea-smoked-duck") };

    await expect(commands.configureFacility(state, facilityId, policy))
      .rejects.toThrow("尚未开发");
    expect(store.commits).toBe(0);
  });

  it("charges signature development only once", async () => {
    const { state, facilityId, commands } = activeDiningCommandFixture("facility-develop-once");

    const first = await commands.developSignatureOffering(
      state, facilityId, "dish:tea-smoked-duck",
    );
    const second = await commands.developSignatureOffering(
      first, facilityId, "dish:tea-smoked-duck",
    );

    const developmentCost = FACILITY_OFFERINGS.find(
      ({ id }) => id === "dish:tea-smoked-duck",
    )!.developmentCostCents;
    expect(first.cashCents).toBe(state.cashCents - developmentCost);
    expect(second.cashCents).toBe(first.cashCents);
    expect(second.revision).toBe(first.revision);
    expect(second.phase4!.facilities[facilityId].developedOfferingIds)
      .toEqual(["dish:tea-smoked-duck"]);
  });

  it("charges each offering's authoritative catalog development cost", async () => {
    const { state, facilityId, commands } = activeDiningCommandFixture("facility-catalog-cost");

    const next = await commands.developSignatureOffering(
      state, facilityId, "dish:cloud-breakfast",
    );

    expect(next.cashCents).toBe(state.cashCents - 420_000);
  });

  it("does not commit an unchanged configuration", async () => {
    const { state, facilityId, commands, store } = activeDiningCommandFixture("facility-config-noop");
    const configured = await commands.configureFacility(state, facilityId, diningPolicy());
    const commits = store.commits;

    const result = await commands.configureFacility(configured, facilityId, diningPolicy());

    expect(result).toBe(configured);
    expect(result.revision).toBe(configured.revision);
    expect(store.commits).toBe(commits);
  });

  it("rejects an offering while locked even if currently eligible", async () => {
    const { state, facilityId, commands, store } = activeDiningCommandFixture("facility-noop-reconcile");
    state.phase4!.facilities[facilityId].developedOfferingIds = [
      assertStableId("dish:tea-smoked-duck"),
    ];
    state.phase4!.catalogProgress.unlockedIds = [];

    await expect(commands.developSignatureOffering(
      state, facilityId, "dish:tea-smoked-duck",
    )).rejects.toThrow("尚未解锁");
    expect(store.commits).toBe(0);
  });

  it("does not persist a projected unlock when a later commit fails", async () => {
    const { state, facilityId } = activeDiningCommandFixture("facility-unlock-failed-commit");
    state.phase4!.catalogProgress.unlockedIds = [assertStableId("facility:all-day-dining")];
    const snapshot = structuredClone(state);
    const commands = createGameCommands({
      load: async () => null,
      commit: async () => { throw new Error("磁盘写入失败"); },
    });

    await expect(commands.configureFacility(state, facilityId, diningPolicy()))
      .rejects.toThrow("磁盘写入失败");
    expect(state).toEqual(snapshot);
  });

  it("selects only a compatible developed signature and enables only a ready policy", async () => {
    const { state, facilityId, commands } = activeDiningCommandFixture("facility-select-enable");

    await expect(commands.selectSignatureOffering(
      state, facilityId, "dish:tea-smoked-duck",
    )).rejects.toThrow("尚未开发");
    await expect(commands.setFacilityEnabled(state, facilityId, true))
      .rejects.toThrow("尚未配置");

    const developed = await commands.developSignatureOffering(
      state, facilityId, "dish:tea-smoked-duck",
    );
    await expect(commands.selectSignatureOffering(
      developed, facilityId, "drink:cloud-negroni",
    )).rejects.toThrow("不兼容");
    const configured = await commands.configureFacility(developed, facilityId, diningPolicy());
    const selected = await commands.selectSignatureOffering(
      configured, facilityId, "dish:tea-smoked-duck",
    );
    const enabled = await commands.setFacilityEnabled(selected, facilityId, true);

    expect(enabled.phase4!.facilities[facilityId]).toMatchObject({
      enabled: true,
      status: "operating",
      policy: { signatureOfferingId: "dish:tea-smoked-duck" },
    });
  });

  it("rejects enabling a corrupt or incomplete persisted policy", async () => {
    const { state, facilityId, commands, store } = activeDiningCommandFixture("facility-invalid-readiness");
    state.phase4!.facilities[facilityId].policy = {
      ...diningPolicy(),
      capacity: Number.MAX_SAFE_INTEGER,
    };

    await expect(commands.setFacilityEnabled(state, facilityId, true))
      .rejects.toThrow("容量");
    expect(store.commits).toBe(0);
  });

  it.each([
    ["sky-lobby", "facility:floor:02:sky-lobby"],
    ["pool", "facility:floor:03:pool"],
    ["gym", "facility:floor:03:gym"],
  ] as const)("requires a valid built blueprint before enabling boost %s", async (type, facilityId) => {
    const state = createPhase4AcceptanceState(`boost-ready-${type}`);
    const facility = state.phase4!.facilities[facilityId];
    facility.enabled = false;
    facility.status = "planned";
    const instance = state.phase4!.publicSpaces[facility.publicSpaceInstanceId];
    const blueprintId = assertStableId(`space-blueprint:ready:${type}`);
    instance.blueprintId = blueprintId;
    state.phase4!.spaceBlueprints[blueprintId] = {
      ...validBoostBlueprint(type, blueprintId),
      placedItems: [],
    };
    const commands = createGameCommands(new RecordingPort());

    await expect(commands.setFacilityEnabled(state, facilityId, true))
      .rejects.toThrow();

    state.phase4!.spaceBlueprints[blueprintId] = validBoostBlueprint(type, blueprintId);
    const enabled = await commands.setFacilityEnabled(state, facilityId, true);
    expect(enabled.phase4!.facilities[facilityId]).toMatchObject({
      enabled: true, status: "operating",
    });
  });

  it("rejects locked, boost, unknown, unsafe-money and revision inputs", async () => {
    const cases: Array<[string, (state: GameState) => Promise<GameState>, string]> = [
      ["locked", async (state) => {
        state.phase4!.catalogProgress.unlockedIds = [];
        state.operations = undefined;
        return createFacilityCommands(new RecordingPort()).configureFacility(
          state, "facility:floor:03:spa", createFacilityPolicy("spa", {
            positioningId: "positioning:restorative-wellness",
            priceBandId: "price-band:premium",
            capacity: 20,
            openingPolicyId: "opening-policy:appointment-daily",
            serviceBudgetCents: 180_000,
          }),
        );
      }, "尚未解锁"],
      ["boost", (state) => createFacilityCommands(new RecordingPort()).configureFacility(
        state,
        "facility:floor:02:sky-lobby",
        diningPolicy(),
      ), "轻量运营"],
      ["unknown", (state) => createFacilityCommands(new RecordingPort()).developSignatureOffering(
        state, "facility:missing", "dish:tea-smoked-duck",
      ), "不存在"],
      ["money", async (state) => {
        state.cashCents = Number.MAX_SAFE_INTEGER + 1;
        return createFacilityCommands(new RecordingPort()).developSignatureOffering(
          state, "facility:floor:02:all-day-dining", "dish:tea-smoked-duck",
        );
      }, "金额"],
      ["revision", async (state) => {
        state.revision = Number.MAX_SAFE_INTEGER;
        return createFacilityCommands(new RecordingPort()).configureFacility(
          state, "facility:floor:02:all-day-dining", diningPolicy(),
        );
      }, "修订号"],
    ];
    for (const [suffix, invoke, message] of cases) {
      const { state } = activeDiningCommandFixture(`facility-${suffix}`);
      const snapshot = structuredClone(state);
      await expect(invoke(state)).rejects.toThrow(message);
      if (suffix !== "locked" && suffix !== "money" && suffix !== "revision") {
        expect(state).toEqual(snapshot);
      }
    }
  });

  it("requires a persisted unlock before configuration", async () => {
    const { state, facilityId, commands } = activeDiningCommandFixture("facility-reconcile");
    state.phase4!.catalogProgress.unlockedIds = [];

    await expect(commands.configureFacility(state, facilityId, diningPolicy()))
      .rejects.toThrow("尚未解锁");
    expect(state.phase4!.catalogProgress.unlockedIds).toEqual([]);
  });

  const corruptFacilityGraphCases: Array<[string, (state: GameState, facilityId: string) => void]> = [
    ["a missing blueprint", (state, facilityId) => {
      const instance = state.phase4!.publicSpaces[
        state.phase4!.facilities[facilityId].publicSpaceInstanceId
      ];
      delete state.phase4!.spaceBlueprints[instance.blueprintId];
    }],
    ["a facility key/id mismatch", (state, facilityId) => {
      state.phase4!.facilities[facilityId].id = assertStableId("facility:mismatched");
    }],
    ["an instance key/id mismatch", (state, facilityId) => {
      const instance = state.phase4!.publicSpaces[
        state.phase4!.facilities[facilityId].publicSpaceInstanceId
      ];
      instance.id = assertStableId("public-space:mismatched");
    }],
    ["a missing floor reference", (state, facilityId) => {
      const instanceId = state.phase4!.facilities[facilityId].publicSpaceInstanceId;
      const instance = state.phase4!.publicSpaces[instanceId];
      const floor = state.phase4!.floors.find(({ id }) => id === instance.floorId)!;
      floor.publicSpaceInstanceIds = floor.publicSpaceInstanceIds
        .filter((candidate) => candidate !== instanceId);
    }],
    ["a dangling floor reference", (state, facilityId) => {
      const instance = state.phase4!.publicSpaces[
        state.phase4!.facilities[facilityId].publicSpaceInstanceId
      ];
      state.phase4!.floors.find(({ id }) => id === instance.floorId)!
        .publicSpaceInstanceIds.push(assertStableId("public-space:missing"));
    }],
    ["a slot mismatch", (state, facilityId) => {
      const instance = state.phase4!.publicSpaces[
        state.phase4!.facilities[facilityId].publicSpaceInstanceId
      ];
      instance.localPlacementId = assertStableId("space:missing");
    }],
    ["a type mismatch", (state, facilityId) => {
      const instance = state.phase4!.publicSpaces[
        state.phase4!.facilities[facilityId].publicSpaceInstanceId
      ];
      instance.type = "bar";
    }],
  ];

  const facilityGraphCommands: Array<[
    string,
    (state: GameState, facilityId: string) => void,
    (commands: ReturnType<typeof createGameCommands>, state: GameState, facilityId: string) => Promise<GameState>,
  ]> = [
    ["configure", () => {}, (commands, state, facilityId) =>
      commands.configureFacility(state, facilityId, diningPolicy())],
    ["develop", () => {}, (commands, state, facilityId) =>
      commands.developSignatureOffering(state, facilityId, "dish:tea-smoked-duck")],
    ["select", (state, facilityId) => {
      state.phase4!.facilities[facilityId].developedOfferingIds = [
        assertStableId("dish:tea-smoked-duck"),
      ];
      state.phase4!.facilities[facilityId].policy = diningPolicy();
    }, (commands, state, facilityId) =>
      commands.selectSignatureOffering(state, facilityId, "dish:tea-smoked-duck")],
    ["enable", (state, facilityId) => {
      state.phase4!.facilities[facilityId].policy = diningPolicy();
    }, (commands, state, facilityId) =>
      commands.setFacilityEnabled(state, facilityId, true)],
  ];

  it.each(facilityGraphCommands)("rejects every corrupt facility graph before %s", async (_command, arrange, invoke) => {
    for (const [, corrupt] of corruptFacilityGraphCases) {
      const { state, facilityId, commands, store } = activeDiningCommandFixture("facility-corrupt-graph");
      arrange(state, facilityId);
      corrupt(state, facilityId);
      const snapshot = structuredClone(state);

      await expect(invoke(commands, state, facilityId)).rejects.toThrow();

      expect(state).toEqual(snapshot);
      expect(store.commits).toBe(0);
    }
  });

  it("does not charge or expose unlocks when persistence fails and retry charges once", async () => {
    const { state, facilityId } = activeDiningCommandFixture("facility-failed-port");
    state.phase4!.catalogProgress.unlockedIds = [assertStableId("facility:all-day-dining")];
    const snapshot = structuredClone(state);
    const failing = createGameCommands({
      load: async () => null,
      commit: async () => { throw new Error("磁盘写入失败"); },
    });

    await expect(failing.developSignatureOffering(
      state, facilityId, "dish:tea-smoked-duck",
    )).rejects.toThrow("磁盘写入失败");
    expect(state).toEqual(snapshot);

    const retry = await createGameCommands(new RecordingPort()).developSignatureOffering(
      state, facilityId, "dish:tea-smoked-duck",
    );
    const developmentCost = FACILITY_OFFERINGS.find(
      ({ id }) => id === "dish:tea-smoked-duck",
    )!.developmentCostCents;
    expect(retry.cashCents).toBe(state.cashCents - developmentCost);
  });
});
