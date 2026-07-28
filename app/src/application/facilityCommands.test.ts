import { describe, expect, it } from "vitest";

import { assertStableId } from "../domain/building/buildingTypes";
import { createFacilityPolicy } from "../domain/facilities/facilityOperations";
import type { GameState } from "../domain/game/state";
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

describe("atomic facility commands", () => {
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

    expect(first.cashCents).toBe(state.cashCents - SIGNATURE_DEVELOPMENT_COST_CENTS);
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

  it("commits pending permanent unlock reconciliation on an offering no-op", async () => {
    const { state, facilityId, commands, store } = activeDiningCommandFixture("facility-noop-reconcile");
    state.phase4!.facilities[facilityId].developedOfferingIds = [
      assertStableId("dish:tea-smoked-duck"),
    ];
    state.phase4!.catalogProgress.unlockedIds = [];

    const next = await commands.developSignatureOffering(
      state, facilityId, "dish:tea-smoked-duck",
    );

    expect(next.phase4!.catalogProgress.unlockedIds).toContain("facility:all-day-dining");
    expect(next.cashCents).toBe(state.cashCents);
    expect(store.commits).toBe(1);
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

  it("reconciles newly eligible facility unlocks in the successful commit", async () => {
    const { state, facilityId, commands } = activeDiningCommandFixture("facility-reconcile");
    state.phase4!.catalogProgress.unlockedIds = [];

    const next = await commands.configureFacility(state, facilityId, diningPolicy());

    expect(next.phase4!.catalogProgress.unlockedIds).toContain("facility:all-day-dining");
    expect(state.phase4!.catalogProgress.unlockedIds).toEqual([]);
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
    expect(retry.cashCents).toBe(state.cashCents - SIGNATURE_DEVELOPMENT_COST_CENTS);
  });
});
