import { beforeEach, describe, expect, it } from "vitest";

import { createNewGame, type GameState } from "../../domain/game/state";
import { LocalStorageSavePort } from "./LocalStorageSavePort";
import { createGameCommands } from "../../application/gameCommands";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { createApprovedOperations } from "../../domain/operations/operationsFixtures";
import { createFacilityPolicy } from "../../domain/facilities/facilityOperations";
import { createApprovedSettlementInput } from "../../domain/operations/operationsFixtures";
import { settleOperationsDay } from "../../domain/operations/settleOperationsDay";

const storageKey = (saveId: string) => `cloud-inn:save:${saveId}`;

function revision(state: GameState, value: number): GameState {
  return { ...state, revision: value };
}

function fakeLockManager(): LockManager {
  let tail = Promise.resolve();
  return {
    request: (_name: string, callback: LockGrantedCallback) => {
      const run = tail.then(() => callback({ name: _name, mode: "exclusive" }));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    query: async () => ({ held: [], pending: [] }),
  } as LockManager;
}

describe("LocalStorageSavePort", () => {
  beforeEach(() => window.localStorage.clear());

  it.each([
    ["invalid JSON", "{"],
    ["non-object root", "null"],
    ["invalid revision", JSON.stringify({ ...createNewGame("safe"), revision: -1 })],
    ["mismatched save id", JSON.stringify(createNewGame("other"))],
    ["invalid phase", JSON.stringify({ ...createNewGame("safe"), phase: "closed" })],
    [
      "unsafe phase two visual asset",
      JSON.stringify({
        ...createNewGame("safe"),
        phase2: {
          hotelGene: { palette: "p", materials: ["m"], metal: "x", lighting: "l", mood: "m" },
          roomMaster: null,
          roomVariants: [],
          corridorTemplate: null,
          designVisuals: {
            status: "complete",
            assets: [{ request: { kind: "master" }, assetPath: "data:image/png;base64,x" }],
            errors: [],
          },
        },
      }),
    ],
    [
      "sensitive phase two metadata",
      JSON.stringify({
        ...createNewGame("safe"),
        phase2: {
          hotelGene: { palette: "p", materials: ["m"], metal: "x", lighting: "l", mood: "m" },
          roomMaster: null,
          roomVariants: [],
          corridorTemplate: null,
          providerToken: "secret-value",
        },
      }),
    ],
  ])("rejects %s with a readable error", async (_label, stored) => {
    window.localStorage.setItem(storageKey("safe"), stored);

    await expect(new LocalStorageSavePort().load("safe")).rejects.toThrow(
      "浏览器存档已损坏",
    );
  });

  it("loads a structurally valid game without returning storage-owned data", async () => {
    const state = revision(createNewGame("safe"), 1);
    window.localStorage.setItem(storageKey(state.saveId), JSON.stringify(state));

    const loaded = await new LocalStorageSavePort().load(state.saveId);

    expect(loaded).toEqual(state);
    expect(loaded).not.toBe(state);
  });

  it("loads a classic Phase 3 report snapshot with room and department categories", async () => {
    const settled = settleOperationsDay(createApprovedSettlementInput());
    const state: GameState = {
      ...createNewGame("phase3-classic-browser"),
      revision: 1,
      currentDay: 1,
      cashCents: settled.cashCents,
      reports: [settled.legacyReport],
      latestReport: settled.legacyReport,
      operations: settled.operations,
    };
    window.localStorage.setItem(storageKey(state.saveId), JSON.stringify(state));

    const loaded = await new LocalStorageSavePort().load(state.saveId);

    expect(loaded).toEqual(state);
    expect(loaded?.operations?.dailyReports[0]).toMatchObject({
      roomRevenueCents: settled.report.revenueCents,
      departmentCostCents: settled.report.operatingCostCents,
    });
  });

  function mixedHotel(saveId: string): GameState {
    const state: GameState = {
      ...createPhase4AcceptanceState(saveId),
      phase: "open",
      cashCents: 100_000_000,
      operations: createApprovedOperations(),
    };
    for (const facility of Object.values(state.phase4!.facilities)) facility.enabled = false;
    const dining = Object.values(state.phase4!.facilities).find(
      ({ type }) => type === "all-day-dining",
    )!;
    dining.enabled = true;
    dining.status = "operating";
    dining.policy = createFacilityPolicy("all-day-dining", {
      positioningId: "positioning:international-luxury",
      priceBandId: "price-band:premium",
      capacity: 30,
      openingPolicyId: "opening-policy:breakfast-dinner",
      serviceBudgetCents: 180_000,
    });
    const blueprint = state.phase4!.spaceBlueprints[
      state.phase4!.publicSpaces[dining.publicSpaceInstanceId].blueprintId
    ];
    blueprint.placedItems = Array.from({ length: 8 }, (_, index) => ({
      id: `item:dining-table:${index + 1}` as typeof blueprint.placedItems[number]["id"],
      catalogItemId: "item:dining-table" as typeof blueprint.placedItems[number]["catalogItemId"],
      x: index,
      y: 0,
      width: 1,
      height: 1,
      rotation: 0,
    }));
    return state;
  }

  it.each([
    ["advance", 1],
    ["batch", 7],
    ["offline", 7],
  ] as const)("commits and reloads real Phase 4 %s settlement", async (mode, days) => {
    const locks = fakeLockManager();
    const port = new LocalStorageSavePort(locks);
    const commands = createGameCommands(port);
    const state = mixedHotel(`mixed-browser-${mode}`);
    if (mode === "offline") state.operations!.lastOfflineCheckpointMs = 0;

    const settled = mode === "advance"
      ? await commands.advanceDay(state, 10_000)
      : mode === "batch"
        ? await commands.advanceOperationsDays(state, days, 70_000)
        : await commands.settleOffline(state, days * 60_000, 60_000);
    const report = settled.operations!.dailyReports[0];

    expect(report.publicSpaceRevenueCents).toBeGreaterThan(0);
    expect(report.facilityOperatingCostCents).toBeGreaterThan(0);
    expect(settled.operations!.dailyReports).toHaveLength(days);
    expect(await port.load(settled.saveId)).toEqual(settled);
  });

  it("commits and reloads report-v2 weekly and monthly aggregates", async () => {
    const locks = fakeLockManager();
    const port = new LocalStorageSavePort(locks);
    const commands = createGameCommands(port);

    const settled = await commands.advanceOperationsDays(
      mixedHotel("mixed-browser-month"),
      30,
      300_000,
    );

    expect(settled.operations?.weeklyReports).toHaveLength(4);
    expect(settled.operations?.monthlyCloses).toHaveLength(1);
    expect(await port.load(settled.saveId)).toEqual(settled);
  });

  it.each(["weeklyReports", "monthlyCloses"] as const)(
    "rejects partial report-v2 categories in %s without overwriting the save",
    async (collection) => {
      const locks = fakeLockManager();
      const port = new LocalStorageSavePort(locks);
      const commands = createGameCommands(port);
      const original = await commands.advanceOperationsDays(
        mixedHotel(`mixed-browser-partial-${collection}`),
        30,
        300_000,
      );
      const rawBefore = window.localStorage.getItem(storageKey(original.saveId));
      const invalid = structuredClone(original);
      invalid.revision += 1;
      delete invalid.operations![collection][0].publicSpaceRevenueCents;

      await expect(port.commit(original.revision, invalid)).rejects.toThrow(
        "必须完整包含四项收入与成本分类",
      );
      expect(window.localStorage.getItem(storageKey(original.saveId))).toBe(rawBefore);
    },
  );

  it("does not overwrite a browser save when partial report-v2 schema validation fails", async () => {
    const locks = fakeLockManager();
    const port = new LocalStorageSavePort(locks);
    const commands = createGameCommands(port);
    const original = await commands.advanceDay(mixedHotel("partial-v2-atomic"), 10_000);
    const rawBefore = window.localStorage.getItem(storageKey(original.saveId));
    const invalid = structuredClone(original);
    invalid.revision += 1;
    delete invalid.operations!.dailyReports[0].publicSpaceRevenueCents;
    delete invalid.operations!.dailyReports[0].departmentCostCents;
    delete invalid.operations!.dailyReports[0].facilityOperatingCostCents;

    await expect(port.commit(original.revision, invalid)).rejects.toThrow(
      "必须完整包含四项收入与成本分类",
    );
    expect(window.localStorage.getItem(storageKey(original.saveId))).toBe(rawBefore);
  });

  it("serializes commits across instances so one stale writer is rejected", async () => {
    const locks = fakeLockManager();
    const firstPort = new LocalStorageSavePort(locks);
    const secondPort = new LocalStorageSavePort(locks);
    const base = createNewGame("concurrent");
    const first = revision({ ...base, cashCents: 10 }, 1);
    const second = revision({ ...base, cashCents: 20 }, 1);

    const results = await Promise.allSettled([
      firstPort.commit(0, first),
      secondPort.commit(0, second),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const stored = await firstPort.load(base.saveId);
    expect([10, 20]).toContain(stored?.cashCents);
    expect(stored?.revision).toBe(1);
  });

  it("fails closed without Web Locks and preserves the stored value", async () => {
    const saveId = "no-locks";
    const original = revision(createNewGame(saveId), 1);
    window.localStorage.setItem(storageKey(saveId), JSON.stringify(original));
    const rawBefore = window.localStorage.getItem(storageKey(saveId));

    await expect(
      new LocalStorageSavePort(null).commit(
        1,
        revision({ ...original, cashCents: 1 }, 2),
      ),
    ).rejects.toThrow("浏览器不支持安全存档锁");

    expect(window.localStorage.getItem(storageKey(saveId))).toBe(rawBefore);
  });
});
