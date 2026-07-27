import { describe, expect, it } from "vitest";

import { createNewGame } from "../domain/game/state";
import type { GameState } from "../domain/game/state";
import { prototypeConfig } from "../domain/config/prototypeConfig";
import { createRectangle } from "../domain/room/grid";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createGameCommands, previewRoomRenovation } from "./gameCommands";
import type { VisualProvider } from "./ports/VisualProvider";
import { CONTEMPORARY_ORIENTAL } from "../domain/design/stylePresets";
import {
  previewMasterSync,
  selectAllSyncChanges,
} from "../domain/design/roomSeries";
import { createCorridorTemplate } from "../domain/floor/corridorTemplate";
import { createOperationsState } from "../domain/operations/createOperationsState";
import {
  effectiveRate,
  seasonForGameDay,
  validatePricePolicy,
  type PricePolicy,
} from "../domain/operations/pricing";
import type { SavePort } from "./ports/SavePort";
import type { DepartmentConfiguration } from "../domain/operations/departmentCatalog";
import type { LoanRequest } from "../domain/operations/finance";
import {
  DAILY_SETTLEMENT_SAFETY_LOAN_ID,
  DEPARTMENT_TRAINING_SAFETY_LOAN_ID,
  ROOM_RENOVATION_SAFETY_LOAN_ID,
} from "../domain/operations/finance";
import type { RoomOfferUpgradeRequest } from "../domain/operations/renovation";
import { projectRoomOffers } from "../domain/operations/roomOffer";
import { matchGuest } from "../domain/operations/matchGuest";
import { getGuestSegment } from "../domain/operations/segmentCatalog";
import { settleOperationsDay } from "../domain/operations/settleOperationsDay";
import { createApprovedOperations } from "../domain/operations/operationsFixtures";

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
  async function openedOperations(saveId: string, difficulty: "casual" | "management") {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame(saveId),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state, difficulty);
    return { store, commands, state };
  }

  it("previews renovation as a pure explainable application projection", async () => {
    const { state } = await openedOperations("save-renovation-preview", "management");
    const offerId = "offer:room-slot-nw:room-type-1";
    const input: RoomOfferUpgradeRequest = { roomOfferId: offerId, kind: "workspace", level: 1 };
    const snapshot = structuredClone({ state, input });

    const preview = previewRoomRenovation(state, input);

    expect(preview).toMatchObject({ costCents: 120_000, closureDays: 2 });
    expect(preview.afterOffer.workspaceBps).toBeGreaterThan(preview.beforeOffer.workspaceBps);
    expect(preview.segments.find(({ segmentId }) => segmentId === "business")?.scoreDeltaBps)
      .toBeGreaterThan(0);
    expect({ state, input }).toEqual(snapshot);
  });

  it("previews and renovates with an unrelated legacy upgrade preserved verbatim", async () => {
    const fixture = await openedOperations("save-renovation-legacy", "management");
    const legacy = {
      roomOfferId: "deluxe-king",
      upgradeId: "club-access",
      level: 1,
    };
    const state = {
      ...fixture.state,
      operations: {
        ...fixture.state.operations!,
        offerUpgrades: { [legacy.roomOfferId]: legacy },
      },
    };
    const request: RoomOfferUpgradeRequest = {
      roomOfferId: "offer:room-slot-nw:room-type-1",
      kind: "workspace",
      level: 1,
    };

    expect(previewRoomRenovation(state, request).beforeOffer.workspaceBps)
      .toBe(previewRoomRenovation(fixture.state, request).beforeOffer.workspaceBps);
    const renovated = await fixture.commands.renovateRoomOffer(state, request);
    expect(renovated.operations?.offerUpgrades[legacy.roomOfferId]).toEqual(legacy);
    expect(renovated.operations?.offerUpgrades[`${request.roomOfferId}:workspace`]).toBeDefined();
  });

  it("ignores a colliding legacy upgrade ID while previewing and preserves it when renovating", async () => {
    const fixture = await openedOperations("save-renovation-legacy-collision", "management");
    const offerId = "offer:room-slot-nw:room-type-1";
    const legacy = { roomOfferId: offerId, upgradeId: "workspace", level: 1 };
    const state = {
      ...fixture.state,
      operations: { ...fixture.state.operations!, offerUpgrades: { [offerId]: legacy } },
    };

    const renovated = await fixture.commands.renovateRoomOffer(state, {
      roomOfferId: offerId,
      kind: "workspace",
      level: 1,
    });

    expect(renovated.operations?.offerUpgrades[offerId]).toEqual(legacy);
    expect(renovated.operations?.offerUpgrades[`${offerId}:workspace`]?.kind).toBe("workspace");
  });

  it("matches renovation preview at the persisted effective nightly price used by settlement", async () => {
    const fixture = await openedOperations("save-renovation-effective-price", "management");
    const offerId = "offer:room-slot-nw:room-type-1";
    const policy = fixture.state.operations!.pricePolicies[offerId] as PricePolicy;
    const effectiveNightlyRate = 1;
    const state = {
      ...fixture.state,
      operations: {
        ...createApprovedOperations(),
        pricePolicies: {
          ...fixture.state.operations!.pricePolicies,
          [offerId]: { ...policy, nightlyRateCents: effectiveNightlyRate },
        },
      },
    };
    const preview = previewRoomRenovation(state, {
      roomOfferId: offerId,
      kind: "workspace",
      level: 1,
    });
    const direct = matchGuest(getGuestSegment("business"), {
      ...projectRoomOffers(state).find(({ id }) => id === offerId)!,
      nightlyRateCents: effectiveNightlyRate,
    });
    const settled = settleOperationsDay({
      day: 1,
      cashCents: state.cashCents,
      operations: state.operations!,
      offers: projectRoomOffers(state),
    });

    expect(preview.beforeOffer.nightlyRateCents).toBe(effectiveNightlyRate);
    expect(preview.segments.find(({ segmentId }) => segmentId === "business")?.before).toEqual(direct);
    expect(settled.report.bookings?.find((booking) => booking.offerId === offerId)?.rateCents)
      .toBe(effectiveNightlyRate);
  });

  it("atomically commits a management renovation, full cost, closure, and stable compound key", async () => {
    const { store, commands, state } = await openedOperations("save-renovation-management", "management");
    const offerId = "offer:room-slot-nw:room-type-1";
    const history = structuredClone(state.operations?.dailyReports);

    const renovated = await commands.renovateRoomOffer(state, {
      roomOfferId: offerId,
      kind: "workspace",
      level: 1,
    });

    expect(renovated.cashCents).toBe(state.cashCents - 120_000);
    expect(renovated.operations?.offerUpgrades[`${offerId}:workspace`]).toMatchObject({
      roomOfferId: offerId,
      upgradeId: "workspace",
      kind: "workspace",
      level: 1,
      remainingClosureDays: 2,
      committedDay: 0,
      costCents: 120_000,
    });
    expect(renovated.operations?.dailyReports).toEqual(history);
    await expectSavedRevision(state, renovated, store);
  });

  it("rejects unaffordable management renovation and day-30 renovation without saving", async () => {
    const fixture = await openedOperations("save-renovation-reject", "management");
    const offerId = "offer:room-slot-nw:room-type-1";
    const poor = { ...fixture.state, cashCents: 119_999 };
    const persisted = await fixture.store.load(fixture.state.saveId);
    const request: RoomOfferUpgradeRequest = { roomOfferId: offerId, kind: "workspace", level: 1 };

    await expect(fixture.commands.renovateRoomOffer(poor, request)).rejects.toThrow("现金不足");
    await expect(fixture.commands.renovateRoomOffer(
      { ...fixture.state, currentDay: 30 }, request,
    )).rejects.toThrow("30");
    await expect(fixture.commands.renovateRoomOffer(fixture.state, {
      ...request, roomOfferId: "offer:missing",
    })).rejects.toThrow("客房产品不存在");
    expect(await fixture.store.load(fixture.state.saveId)).toEqual(persisted);
  });

  it("covers the exact casual renovation shortfall with its reserved safety loan and no free cash", async () => {
    const fixture = await openedOperations("save-renovation-casual", "casual");
    const state = { ...fixture.state, cashCents: 20_000 };

    const renovated = await fixture.commands.renovateRoomOffer(state, {
      roomOfferId: "offer:room-slot-nw:room-type-1",
      kind: "workspace",
      level: 1,
    });

    expect(renovated.cashCents).toBe(0);
    expect(renovated.operations?.loans).toContainEqual({
      id: ROOM_RENOVATION_SAFETY_LOAN_ID,
      principalCents: 100_000,
      outstandingCents: 100_000,
      dailyInterestBps: 10,
      minimumPaymentCents: 1_000,
    });
  });

  it("does not partially mutate renovation, finance, history, or saved state when commit fails", async () => {
    const fixture = await openedOperations("save-renovation-save-failure", "casual");
    const snapshot = structuredClone(fixture.state);
    const persisted = await fixture.store.load(fixture.state.saveId);
    const commands = createGameCommands({
      load: (saveId) => fixture.store.load(saveId),
      commit: async () => { throw new Error("磁盘写入失败"); },
    });

    await expect(commands.renovateRoomOffer(fixture.state, {
      roomOfferId: "offer:room-slot-nw:room-type-1",
      kind: "privacy",
      level: 1,
    })).rejects.toThrow("磁盘写入失败");
    expect(fixture.state).toEqual(snapshot);
    expect(await fixture.store.load(fixture.state.saveId)).toEqual(persisted);
  });

  it("atomically rejects replacing a room variant after its stable offer has renovation history", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomSeries(createNewGame("save-renovation-variant-lock"), {
      id: "master-renovated",
      name: "装修锁定客房",
      cells: prototypeCells(),
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    state = await commands.saveRoomBlueprint(state, "装修锁定客房", prototypeCells());
    state = await commands.chooseCorridorTemplate(state, createCorridorTemplate("complete-ring"));
    state = await commands.placeRoomVariant(state, {
      slotId: "north-west",
      variantId: "master-renovated-king",
      rotation: 0,
      mirrored: false,
    });
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state, "management");
    state = await commands.renovateRoomOffer(state, {
      roomOfferId: "offer:room-north-west:master-renovated-king",
      kind: "workspace",
      level: 1,
    });
    const snapshot = structuredClone(state);
    const persisted = await store.load(state.saveId);

    await expect(commands.placeRoomVariant(state, {
      slotId: "north-west",
      variantId: "master-renovated-twin",
      rotation: 0,
      mirrored: false,
    })).rejects.toThrow("改造");
    expect(state).toEqual(snapshot);
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it("preserves existing room-variant replacement behavior when no renovation exists", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomSeries(createNewGame("save-variant-no-renovation"), {
      id: "master-replaceable",
      name: "可替换客房",
      cells: prototypeCells(),
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    state = await commands.saveRoomBlueprint(state, "可替换客房", prototypeCells());
    state = await commands.chooseCorridorTemplate(state, createCorridorTemplate("complete-ring"));
    state = await commands.placeRoomVariant(state, {
      slotId: "north-west",
      variantId: "master-replaceable-king",
      rotation: 0,
      mirrored: false,
    });

    const replaced = await commands.placeRoomVariant(state, {
      slotId: "north-west",
      variantId: "master-replaceable-twin",
      rotation: 0,
      mirrored: false,
    });

    expect(replaced.phase2?.floorPlacements?.find(({ slotId }) => slotId === "north-west")?.variantId)
      .toBe("master-replaceable-twin");
    await expectSavedRevision(state, replaced, store);
  });

  it("takes an explicit validated loan atomically and credits cash", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = await commands.initializeOperations(
      createNewGame("save-finance-take-loan"),
      "management",
    );
    const request: LoanRequest = {
      id: "loan:bank:001",
      amountCents: 120_000,
      dailyInterestBps: 20,
      termDays: 12,
    };

    const funded = await commands.takeLoan(state, request);

    expect(funded.cashCents).toBe(state.cashCents + 120_000);
    expect(funded.operations?.loans).toEqual([{
      id: request.id,
      principalCents: 120_000,
      outstandingCents: 120_000,
      dailyInterestBps: 20,
      minimumPaymentCents: 10_000,
    }]);
    await expectSavedRevision(state, funded, store);
  });

  it.each([-1, Number.MAX_SAFE_INTEGER])(
    "rejects taking a loan from unsafe current cash %s",
    async (cashCents) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      const state = {
        ...await commands.initializeOperations(createNewGame(`save-finance-cash-${cashCents}`)),
        cashCents,
      };
      const persisted = await store.load(state.saveId);

      await expect(commands.takeLoan(state, {
        id: "loan:unsafe-cash",
        amountCents: 1,
        dailyInterestBps: 0,
        termDays: 1,
      })).rejects.toThrow("金额");
      expect(await store.load(state.saveId)).toEqual(persisted);
    },
  );

  it.each([
    DAILY_SETTLEMENT_SAFETY_LOAN_ID,
    DEPARTMENT_TRAINING_SAFETY_LOAN_ID,
    ROOM_RENOVATION_SAFETY_LOAN_ID,
  ])(
    "rejects voluntary use of reserved loan ID %s without saving",
    async (id) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      const state = await commands.initializeOperations(createNewGame(`save-finance-reserved-${id}`));
      const persisted = await store.load(state.saveId);

      await expect(commands.takeLoan(state, {
        id,
        amountCents: 100,
        dailyInterestBps: 10,
        termDays: 10,
      })).rejects.toThrow("安全贷款编号为系统保留");
      expect(await store.load(state.saveId)).toEqual(persisted);
    },
  );

  it("repays principal atomically and removes the loan when fully settled", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.initializeOperations(
      createNewGame("save-finance-repay-loan"),
      "management",
    );
    state = await commands.takeLoan(state, {
      id: "loan:bank:repay",
      amountCents: 100_000,
      dailyInterestBps: 10,
      termDays: 10,
    });

    const partial = await commands.repayLoan(state, "loan:bank:repay", 40_000);
    expect(partial.cashCents).toBe(state.cashCents - 40_000);
    expect(partial.operations?.loans[0]).toMatchObject({
      principalCents: 100_000,
      outstandingCents: 60_000,
    });
    const settled = await commands.repayLoan(partial, "loan:bank:repay", 60_000);
    expect(settled.operations?.loans).toEqual([]);
  });

  it.each([
    ["missing", "贷款不存在"],
    ["overpayment", "贷款余额"],
    ["insufficient-cash", "现金不足"],
    ["invalid-amount", "还款金额"],
  ] as const)("rejects %s repayment without saving", async (kind, message) => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.initializeOperations(
      createNewGame(`save-finance-repay-${kind}`),
    );
    state = await commands.takeLoan(state, {
      id: "loan:repay",
      amountCents: 100_000,
      dailyInterestBps: 10,
      termDays: 10,
    });
    if (kind === "insufficient-cash") state = { ...state, cashCents: 1 };
    const persisted = await store.load(state.saveId);
    await expect(commands.repayLoan(
      state,
      kind === "missing" ? "loan:missing" : "loan:repay",
      kind === "overpayment" ? 100_001 : kind === "invalid-amount" ? 0 : 100_000,
    )).rejects.toThrow(message);
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it.each([Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects repayment from invalid current cash %s before loan arithmetic",
    async (cashCents) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      const state = {
        ...await commands.initializeOperations(createNewGame(`save-finance-repay-cash-${cashCents}`)),
        cashCents,
        operations: {
          ...createOperationsState(),
          loans: [{
            id: "loan:invalid-record",
            principalCents: 100,
            outstandingCents: 0,
            dailyInterestBps: 10,
            minimumPaymentCents: 1,
          }],
        },
      };
      const persisted = await store.load(state.saveId);

      await expect(commands.repayLoan(state, "loan:invalid-record", 1)).rejects.toThrow("金额");
      expect(await store.load(state.saveId)).toEqual(persisted);
    },
  );

  it.each([Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects management department configuration from invalid current cash %s before cost arithmetic",
    async (cashCents) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      const state = {
        ...await commands.initializeOperations(
          createNewGame(`save-department-management-cash-${cashCents}`),
          "management",
        ),
        cashCents,
      };
      const persisted = await store.load(state.saveId);

      await expect(commands.configureDepartment(state, {
        ...state.operations!.departments.frontOffice,
        trainingBps: 1_000,
      })).rejects.toThrow("金额");
      expect(await store.load(state.saveId)).toEqual(persisted);
    },
  );

  it("switches only between supported difficulties without resetting operations", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = await commands.initializeOperations(createNewGame("save-finance-difficulty"));
    const management = await commands.setDifficulty(state, "management");

    expect(management.operations).toEqual({ ...state.operations!, difficulty: "management" });
    await expect(commands.setDifficulty(management, "expert" as never)).rejects.toThrow("经营难度无效");
  });

  it.each(["takeLoan", "repayLoan", "setDifficulty"] as const)(
    "requires operations initialization for %s",
    async (command) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      const state = createNewGame(`save-finance-uninitialized-${command}`);
      const promise = command === "takeLoan"
        ? commands.takeLoan(state, { id: "loan:id", amountCents: 1, dailyInterestBps: 0, termDays: 1 })
        : command === "repayLoan"
          ? commands.repayLoan(state, "loan:id", 1)
          : commands.setDifficulty(state, "management");

      await expect(promise).rejects.toThrow("经营系统尚未初始化");
      expect(await store.load(state.saveId)).toBeNull();
    },
  );

  it("does not mutate loan command state when saving fails", async () => {
    const store = new InMemorySavePort();
    const baseCommands = createGameCommands(store);
    const state = await baseCommands.initializeOperations(createNewGame("save-finance-failure"));
    const snapshot = structuredClone(state);
    const commands = createGameCommands({
      load: (saveId) => store.load(saveId),
      commit: async () => { throw new Error("磁盘写入失败"); },
    });

    await expect(commands.takeLoan(state, {
      id: "loan:failure",
      amountCents: 100,
      dailyInterestBps: 10,
      termDays: 10,
    })).rejects.toThrow("磁盘写入失败");
    expect(state).toEqual(snapshot);
  });

  it("initializes operations once with policies for placed offers and preserves existing operations", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame("save-pricing-init"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.placeRoom(state, "slot-ne");

    const initialized = await commands.initializeOperations(state, "management");
    const policies = initialized.operations?.pricePolicies as Record<string, PricePolicy>;
    expect(initialized.operations).toMatchObject({
      difficulty: "management",
      reputationBps: 5_000,
      maximumReputationBps: 5_000,
    });
    expect(Object.keys(policies)).toEqual([
      "offer:room-slot-nw:room-type-1",
      "offer:room-slot-ne:room-type-1",
    ]);
    expect(policies["offer:room-slot-nw:room-type-1"]).toEqual({
      roomOfferId: "offer:room-slot-nw:room-type-1",
      baseRateCents: state.rateCents,
      minRateCents: 40_000,
      maxRateCents: 160_000,
      automaticPricing: true,
      nightlyRateCents: 80_000,
    });

    const customized = {
      ...initialized,
      operations: {
        ...initialized.operations!,
        reputationBps: 7_777,
        unlockedContent: ["kept"],
      },
    };
    await store.commit(initialized.revision, {
      ...customized,
      revision: initialized.revision + 1,
    });
    const persistedCustomized = {
      ...customized,
      revision: initialized.revision + 1,
    };
    const again = await commands.initializeOperations(persistedCustomized);

    expect(again.operations?.reputationBps).toBe(7_777);
    expect(again.operations?.unlockedContent).toEqual(["kept"]);
    expect(again.operations?.difficulty).toBe("management");
  });

  it("normalizes restored policy IDs and removes policies for offers no longer available", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame("save-pricing-restored"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.placeRoom(state, "slot-nw");
    const offerId = "offer:room-slot-nw:room-type-1";
    const restoredPolicy: PricePolicy = {
      roomOfferId: "offer:corrupt:mismatch",
      baseRateCents: 90_000,
      minRateCents: 70_000,
      maxRateCents: 120_000,
      automaticPricing: false,
      nightlyRateCents: 90_000,
    };
    state = {
      ...state,
      operations: {
        ...createOperationsState("management"),
        reputationBps: 7_500,
        pricePolicies: {
          [offerId]: restoredPolicy,
          "offer:stale:removed-room": {
            ...restoredPolicy,
            roomOfferId: "offer:stale:removed-room",
          },
        },
      },
    };
    await store.commit(state.revision, { ...state, revision: state.revision + 1 });

    const initialized = await commands.initializeOperations({
      ...state,
      revision: state.revision + 1,
    });

    expect(initialized.operations?.pricePolicies).toEqual({
      [offerId]: { ...restoredPolicy, roomOfferId: offerId },
    });
    expect(initialized.operations?.reputationBps).toBe(7_500);
    expect(initialized.operations?.difficulty).toBe("management");
  });

  it("uses a legacy blueprint offer when operations starts before room placement", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const designed = await commands.saveRoomBlueprint(
      createNewGame("save-pricing-legacy"),
      "云岫商务房",
      prototypeCells(),
    );

    const initialized = await commands.initializeOperations(designed);

    expect(Object.keys(initialized.operations?.pricePolicies ?? {})).toEqual([
      "offer:legacy:room-type-1",
    ]);
  });

  it("initializes a valid policy when the legacy rate is near the safe integer limit", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const designed = await commands.saveRoomBlueprint(
      createNewGame("save-pricing-large-rate"),
      "云岫商务房",
      prototypeCells(),
    );
    const largeRate = Number.MAX_SAFE_INTEGER - 1;
    const state = { ...designed, rateCents: largeRate };
    await store.commit(designed.revision, {
      ...state,
      revision: designed.revision + 1,
    });

    const initialized = await commands.initializeOperations({
      ...state,
      revision: designed.revision + 1,
    });
    const policy = initialized.operations?.pricePolicies[
      "offer:legacy:room-type-1"
    ] as PricePolicy;

    expect(() => validatePricePolicy(policy)).not.toThrow();
    expect(policy.maxRateCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(policy.baseRateCents).toBe(largeRate);
  });

  it("rejects an invalid operations difficulty without saving", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("save-pricing-difficulty");

    await expect(
      commands.initializeOperations(state, "expert" as never),
    ).rejects.toThrow("经营难度无效");
    expect(await store.load(state.saveId)).toBeNull();
  });

  it("requires operations initialization before configuring a department", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("save-department-uninitialized");

    await expect(
      commands.configureDepartment(state, {
        id: "frontOffice",
        staffing: 6,
        dailyBudgetCents: 100_000,
        trainingBps: 2_000,
        serviceStandardBps: 6_000,
        leaderSpecialty: "arrival-flow",
      }),
    ).rejects.toThrow("经营系统尚未初始化");
    expect(await store.load(state.saveId)).toBeNull();
  });

  it("configures a department atomically and charges only incremental training", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.initializeOperations(
      createNewGame("save-department-configure"),
      "management",
    );
    const input: DepartmentConfiguration = {
      id: "housekeeping",
      staffing: 8,
      dailyBudgetCents: 240_000,
      trainingBps: 2_000,
      serviceStandardBps: 7_000,
      leaderSpecialty: "room-turnover",
    };
    const inputSnapshot = structuredClone(input);
    const beforeCash = state.cashCents;

    const configured = await commands.configureDepartment(state, input);

    expect(configured.operations?.departments.housekeeping).toEqual(input);
    expect(configured.operations?.departments.frontOffice).toEqual(
      state.operations?.departments.frontOffice,
    );
    expect(configured.cashCents).toBe(beforeCash - 400_000);
    expect(input).toEqual(inputSnapshot);
    await expectSavedRevision(state, configured, store);

    state = configured;
    const budgetOnly = await commands.configureDepartment(state, {
      ...input,
      dailyBudgetCents: 300_000,
      staffing: 12,
    });
    expect(budgetOnly.cashCents).toBe(state.cashCents);
  });

  it("allows an unaffordable casual daily budget without spending cash immediately", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const initialized = await commands.initializeOperations(
      { ...createNewGame("save-department-casual"), cashCents: 1 },
      "casual",
    );

    const configured = await commands.configureDepartment(initialized, {
      id: "frontOffice",
      staffing: 500,
      dailyBudgetCents: 100_000_000,
      trainingBps: 0,
      serviceStandardBps: 10_000,
      leaderSpecialty: "front-desk-care",
    });

    expect(configured.cashCents).toBe(1);
    expect(configured.operations?.departments.frontOffice.dailyBudgetCents).toBe(
      100_000_000,
    );
  });

  it("covers casual training cash shortfall with a deterministic safety loan", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const initialized = await commands.initializeOperations(
      { ...createNewGame("save-department-casual-training"), cashCents: 100_000 },
      "casual",
    );

    const configured = await commands.configureDepartment(initialized, {
      id: "frontOffice",
      staffing: 6,
      dailyBudgetCents: 100_000,
      trainingBps: 2_000,
      serviceStandardBps: 6_000,
      leaderSpecialty: "arrival-flow",
    });

    expect(configured.cashCents).toBe(0);
    expect(configured.operations?.departments.frontOffice.trainingBps).toBe(2_000);
    expect(configured.operations?.loans).toEqual([{
      id: "safety-loan:department-training",
      principalCents: 300_000,
      outstandingCents: 300_000,
      dailyInterestBps: 10,
      minimumPaymentCents: 3_000,
    }]);
    await expectSavedRevision(initialized, configured, store);

    const fundedAgain = await commands.configureDepartment(configured, {
      ...configured.operations!.departments.frontOffice,
      trainingBps: 3_000,
    });
    expect(fundedAgain.cashCents).toBe(0);
    expect(fundedAgain.operations?.loans).toEqual([{
      id: "safety-loan:department-training",
      principalCents: 500_000,
      outstandingCents: 500_000,
      dailyInterestBps: 10,
      minimumPaymentCents: 5_000,
    }]);
  });

  it("keeps casual safety-loan financing atomic when saving fails", async () => {
    const store = new InMemorySavePort();
    const baseCommands = createGameCommands(store);
    const state = await baseCommands.initializeOperations(
      { ...createNewGame("save-department-casual-loan-failure"), cashCents: 1 },
      "casual",
    );
    const snapshot = structuredClone(state);
    const persisted = await store.load(state.saveId);
    const commands = createGameCommands({
      load: (saveId) => store.load(saveId),
      commit: async () => {
        throw new Error("磁盘写入失败");
      },
    });

    await expect(commands.configureDepartment(state, {
      id: "housekeeping",
      staffing: 8,
      dailyBudgetCents: 240_000,
      trainingBps: 2_000,
      serviceStandardBps: 7_000,
      leaderSpecialty: "room-turnover",
    })).rejects.toThrow("磁盘写入失败");
    expect(state).toEqual(snapshot);
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it.each([
    { kind: "invalid-department" as const },
    { kind: "invalid-value" as const },
    { kind: "insufficient-training-cash" as const },
    { kind: "save-failure" as const },
  ])("keeps department configuration atomic for $kind", async ({ kind }) => {
    const baseStore = new InMemorySavePort();
    const baseCommands = createGameCommands(baseStore);
    let state = await baseCommands.initializeOperations(
      createNewGame(`save-department-${kind}`),
      "management",
    );
    if (kind === "insufficient-training-cash") {
      state = { ...state, cashCents: 1 };
      await baseStore.commit(state.revision, { ...state, revision: state.revision + 1 });
      state = { ...state, revision: state.revision + 1 };
    }
    const snapshot = structuredClone(state);
    const persisted = await baseStore.load(state.saveId);
    const failingPort: SavePort = {
      load: (saveId) => baseStore.load(saveId),
      commit: async () => {
        throw new Error("磁盘写入失败");
      },
    };
    const commands = kind === "save-failure"
      ? createGameCommands(failingPort)
      : baseCommands;
    const valid: DepartmentConfiguration = {
      id: "housekeeping",
      staffing: 8,
      dailyBudgetCents: 240_000,
      trainingBps: 2_000,
      serviceStandardBps: 7_000,
      leaderSpecialty: "room-turnover",
    };
    const attempted = kind === "invalid-department"
      ? { ...valid, id: "spa" as never }
      : kind === "invalid-value"
        ? { ...valid, trainingBps: 10_001 }
        : valid;

    await expect(commands.configureDepartment(state, attempted)).rejects.toThrow(
      kind === "invalid-department"
        ? "部门不存在"
        : kind === "invalid-value"
          ? "培训水平"
          : kind === "insufficient-training-cash"
            ? "现金不足以支付一次性培训费用"
            : "磁盘写入失败",
    );
    expect(state).toEqual(snapshot);
    expect(await baseStore.load(state.saveId)).toEqual(persisted);
  });

  it("sets a validated policy and toggles automatic pricing as a manual lock", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame("save-pricing-policy"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.initializeOperations(state);
    const offerId = "offer:room-slot-nw:room-type-1";
    const nextPolicy: PricePolicy = {
      roomOfferId: offerId,
      baseRateCents: 110_000,
      minRateCents: 90_000,
      maxRateCents: 150_000,
      automaticPricing: true,
      nightlyRateCents: 1,
    };

    state = await commands.setRoomPricePolicy(state, nextPolicy);
    expect((state.operations?.pricePolicies[offerId] as PricePolicy).nightlyRateCents).toBe(
      110_000,
    );
    const locked = await commands.setAutomaticPricing(state, offerId, false);
    expect(locked.operations?.pricePolicies[offerId]).toEqual({
      ...nextPolicy,
      automaticPricing: false,
      nightlyRateCents: 110_000,
    });
    await expectSavedRevision(state, locked, store);
  });

  it("ignores legacy reports when operations history is empty for automatic pricing", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame("save-pricing-context"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.placeRoom(state, "slot-nw");
    state = {
      ...state,
      currentDay: 30,
      reports: Array.from({ length: 8 }, (_, index) => ({
        day: 23 + index,
        availableRooms: 10,
        soldRooms: index === 0 ? 0 : 8,
        occupancyBps: index === 0 ? 0 : 8_000,
        rateCents: 80_000,
        revenueCents: 0,
        operatingCostCents: 0,
        netIncomeCents: 0,
        endingCashCents: state.cashCents,
        reasons: [],
      })),
      operations: {
        ...createOperationsState(),
        reputationBps: 6_000,
      },
    };
    await store.commit(state.revision, { ...state, revision: state.revision + 1 });
    state = { ...state, revision: state.revision + 1 };

    const initialized = await commands.initializeOperations(state);
    const offerId = "offer:room-slot-nw:room-type-1";
    const current = initialized.operations?.pricePolicies[offerId] as PricePolicy;

    expect(current.nightlyRateCents).toBe(87_200);
  });

  it.each([
    { kind: "invalid-policy" as const },
    { kind: "missing-offer" as const },
    { kind: "save-failure" as const },
  ])("keeps memory and persistence atomic for $kind", async ({ kind }) => {
    const baseStore = new InMemorySavePort();
    const baseCommands = createGameCommands(baseStore);
    let state = await baseCommands.saveRoomBlueprint(
      createNewGame(`save-pricing-${kind}`),
      "云岫商务房",
      prototypeCells(),
    );
    state = await baseCommands.placeRoom(state, "slot-nw");
    state = await baseCommands.initializeOperations(state);
    const snapshot = structuredClone(state);
    const persisted = await baseStore.load(state.saveId);
    const offerId = "offer:room-slot-nw:room-type-1";
    const valid = state.operations?.pricePolicies[offerId] as PricePolicy;
    const failingPort: SavePort = {
      load: (saveId) => baseStore.load(saveId),
      commit: async () => {
        throw new Error("磁盘写入失败");
      },
    };
    const commands = kind === "save-failure" ? createGameCommands(failingPort) : baseCommands;
    const attempted = kind === "invalid-policy"
      ? { ...valid, minRateCents: valid.baseRateCents + 1 }
      : { ...valid, roomOfferId: kind === "missing-offer" ? "missing" : offerId };

    await expect(commands.setRoomPricePolicy(state, attempted)).rejects.toThrow(
      kind === "invalid-policy"
        ? "最低价、基础价和最高价顺序无效"
        : kind === "missing-offer"
          ? "客房产品不存在"
          : "磁盘写入失败",
    );
    expect(state).toEqual(snapshot);
    expect(await baseStore.load(state.saveId)).toEqual(persisted);
  });

  it.each(["rooms", "placements"] as const)(
    "rejects corridor template switching when paid construction remains in %s",
    async (evidence) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      let state = await commands.saveRoomSeries(createNewGame("save-switch"), {
        id: "master-switch",
        name: "标准客房",
        cells: prototypeCells(),
        gene: CONTEMPORARY_ORIENTAL.gene,
      });
      state = await commands.saveRoomBlueprint(state, "标准客房", prototypeCells());
      state = await commands.chooseCorridorTemplate(
        state,
        createCorridorTemplate("complete-ring"),
      );
      if (evidence === "rooms") {
        state = await commands.placeRoomVariant(state, {
          slotId: "north-west",
          variantId: "master-switch-king",
          rotation: 0,
          mirrored: false,
        });
      } else {
        state = {
          ...state,
          phase2: {
            ...state.phase2!,
            floorPlacements: [{
              slotId: "north-west",
              variantId: "master-switch-king",
              rotation: 0,
              mirrored: false,
            }],
          },
        };
        await store.commit(state.revision, { ...state, revision: state.revision + 1 });
        state = { ...state, revision: state.revision + 1 };
      }
      const snapshot = structuredClone(state);

      await expect(
        commands.chooseCorridorTemplate(
          state,
          createCorridorTemplate("partial-ring"),
        ),
      ).rejects.toThrow("已有客房施工，不能切换环廊模板");

      expect(state).toEqual(snapshot);
      expect(await store.load(state.saveId)).toEqual(snapshot);
    },
  );

  it("allows corridor template switching before construction", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomSeries(createNewGame("save-switch-empty"), {
      id: "master-switch",
      name: "标准客房",
      cells: prototypeCells(),
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    state = await commands.chooseCorridorTemplate(
      state,
      createCorridorTemplate("complete-ring"),
    );

    const switched = await commands.chooseCorridorTemplate(
      state,
      createCorridorTemplate("partial-ring"),
    );

    expect(switched.phase2?.corridorTemplate?.id).toBe("partial-ring");
    await expectSavedRevision(state, switched, store);
  });

  it.each([
    { rotation: 0 as const, slotId: "north-east", expected: "8×12" },
    { rotation: 90 as const, slotId: "north-west", expected: "12×8" },
    { rotation: 270 as const, slotId: "north-west", expected: "12×8" },
  ])(
    "rejects a $rotation° room whose $expected footprint exceeds its slot without cash or save mutation",
    async ({ rotation, slotId, expected }) => {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      let state = await commands.saveRoomSeries(createNewGame("save-fit"), {
        id: "master-fit",
        name: "标准客房",
        cells: prototypeCells(),
        gene: CONTEMPORARY_ORIENTAL.gene,
      });
      state = await commands.saveRoomBlueprint(state, "标准客房", prototypeCells());
      state = await commands.chooseCorridorTemplate(
        state,
        createCorridorTemplate("complete-ring"),
      );
      const snapshot = structuredClone(state);

      await expect(
        commands.placeRoomVariant(state, {
          slotId,
          variantId: "master-fit-king",
          rotation,
          mirrored: false,
        }),
      ).rejects.toThrow(`客房尺寸 ${expected} 超出槽位`);

      expect(state).toEqual(snapshot);
      expect(await store.load(state.saveId)).toEqual(snapshot);
    },
  );
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

  it("atomically persists rich operations settlement and its legacy projection", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame("save-operations-settlement"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state, "casual");

    const settled = await commands.advanceDay(state, 10_000);
    const operationsReport = settled.operations?.dailyReports[0];

    expect(operationsReport).toBeDefined();
    expect(settled.currentDay).toBe(1);
    expect(settled.cashCents).toBe(operationsReport?.endingCashCents);
    expect(settled.operations?.reputationBps).toBe(operationsReport?.reputationBps);
    expect(settled.operations?.lastOfflineCheckpointMs).toBe(10_000);
    expect(settled.reports).toHaveLength(1);
    expect(settled.latestReport).toBe(settled.reports[0]);
    expect(settled.reports[0]).toMatchObject({
      day: operationsReport?.day,
      soldRooms: operationsReport?.soldRooms,
      revenueCents: operationsReport?.revenueCents,
      netIncomeCents: operationsReport?.netIncomeCents,
      endingCashCents: operationsReport?.endingCashCents,
    });
    expect(await store.load(state.saveId)).toEqual(settled);
  });

  it("recomputes automatic pricing from the prior day and settles bookings at the persisted effective rate", async () => {
    const fixture = await openedOperations("save-automatic-settlement-rate", "casual");
    const offerId = "offer:room-slot-nw:room-type-1";
    const policy = fixture.state.operations?.pricePolicies[offerId] as PricePolicy;
    const state = {
      ...fixture.state,
      operations: {
        ...createApprovedOperations(),
        pricePolicies: { [offerId]: policy },
      },
    };

    const firstDay = await fixture.commands.advanceDay(state, 10_000);
    const firstReport = firstDay.operations!.dailyReports[0];
    const availableRooms = firstReport.availableRooms ?? 0;
    const soldRooms = firstReport.soldRooms ?? 0;
    const totalDemand = firstReport.segments.reduce(
      (total, segment) => total + segment.demand,
      0,
    );
    const expectedSecondDayRate = effectiveRate(policy, {
      season: seasonForGameDay(firstDay.currentDay),
      trailingSevenDayOccupancyBps: firstReport.occupancyBps ?? 0,
      segmentDemandBps: Math.min(
        10_000,
        Math.trunc((totalDemand * 10_000) / firstDay.floor.rooms.length),
      ),
      reputationBps: firstDay.operations!.reputationBps,
      remainingInventoryBps: availableRooms === 0
        ? 5_000
        : Math.trunc(((availableRooms - soldRooms) * 10_000) / availableRooms),
    });
    expect(expectedSecondDayRate).not.toBe(policy.nightlyRateCents);

    const secondDay = await fixture.commands.advanceDay(firstDay, 20_000);
    const secondReport = secondDay.operations!.dailyReports[1];
    const booking = secondReport.bookings?.find(({ offerId: id }) => id === offerId);
    const segment = secondReport.segments.find(
      ({ segmentId }) => segmentId === booking?.segmentId,
    );

    expect(booking?.rateCents).toBe(expectedSecondDayRate);
    expect(segment?.averageRateCents).toBe(expectedSecondDayRate);
    expect(secondReport.revenueCents).toBe(expectedSecondDayRate);
    expect((secondDay.operations!.pricePolicies[offerId] as PricePolicy).nightlyRateCents)
      .toBe(expectedSecondDayRate);
    expect(secondDay.operations?.lastOfflineCheckpointMs).toBe(20_000);
    expect(await fixture.store.load(secondDay.saveId)).toEqual(secondDay);
  });

  it("keeps a manually locked persisted rate unchanged during settlement", async () => {
    const fixture = await openedOperations("save-manual-settlement-rate", "casual");
    const offerId = "offer:room-slot-nw:room-type-1";
    const automatic = fixture.state.operations?.pricePolicies[offerId] as PricePolicy;
    const manualRateCents = 70_000;
    const state = {
      ...fixture.state,
      operations: {
        ...createApprovedOperations(),
        pricePolicies: {
          [offerId]: {
            ...automatic,
            automaticPricing: false,
            nightlyRateCents: manualRateCents,
          },
        },
      },
    };

    const settled = await fixture.commands.advanceDay(state, 10_000);
    const booking = settled.operations?.dailyReports[0].bookings?.find(
      ({ offerId: id }) => id === offerId,
    );

    expect(booking?.rateCents).toBe(manualRateCents);
    expect((settled.operations!.pricePolicies[offerId] as PricePolicy).nightlyRateCents)
      .toBe(manualRateCents);
  });

  it("does not partially apply operations settlement when its single commit fails", async () => {
    const store = new InMemorySavePort();
    const baseCommands = createGameCommands(store);
    let state = await baseCommands.saveRoomBlueprint(
      createNewGame("save-operations-settlement-failure"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await baseCommands.placeRoom(state, "slot-nw");
    state = await baseCommands.openHotel(state);
    state = await baseCommands.initializeOperations(state, "casual");
    const offerId = "offer:room-slot-nw:room-type-1";
    const policy = state.operations!.pricePolicies[offerId] as PricePolicy;
    state = {
      ...state,
      reports: [{
        day: 1,
        availableRooms: 1,
        soldRooms: 1,
        occupancyBps: 10_000,
        rateCents: policy.nightlyRateCents,
        revenueCents: policy.nightlyRateCents,
        operatingCostCents: 0,
        netIncomeCents: policy.nightlyRateCents,
        endingCashCents: state.cashCents,
        reasons: [],
      }],
      operations: {
        ...createApprovedOperations(),
        pricePolicies: { [offerId]: policy },
      },
    };
    const snapshot = structuredClone(state);
    const persisted = await store.load(state.saveId);
    const commands = createGameCommands({
      load: (saveId) => store.load(saveId),
      commit: async () => {
        throw new Error("磁盘写入失败");
      },
    });

    await expect(commands.advanceDay(state, 10_000)).rejects.toThrow("磁盘写入失败");
    expect(state).toEqual(snapshot);
    expect((state.operations!.pricePolicies[offerId] as PricePolicy).nightlyRateCents)
      .toBe(policy.nightlyRateCents);
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it("rejects operations advancement without application time and keeps state and save unchanged", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(
      createNewGame("save-operations-time-required"),
      "云岫商务房",
      prototypeCells(),
    );
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.checkpointOfflineTime(state, 1_000);
    const snapshot = structuredClone(state);
    const persisted = await store.load(state.saveId);

    await expect(commands.advanceDay(state)).rejects.toThrow("日结时间");

    expect(state).toEqual(snapshot);
    expect(await store.load(state.saveId)).toEqual(persisted);
    expect(state.operations?.lastOfflineCheckpointMs).toBe(1_000);
  });

  it.each([0, 1, 2, 4] as const)("sets supported operations time speed %s atomically", async (speed) => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = await commands.initializeOperations(createNewGame(`save-speed-${speed}`));

    const next = await commands.setTimeSpeed(state, speed);

    expect(next.operations?.timeSpeed).toBe(speed);
    await expectSavedRevision(state, next, store);
  });

  it.each([-1, 3, 5, Number.NaN, 1.5])("rejects unsupported operations time speed %s", async (speed) => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = await commands.initializeOperations(createNewGame(`save-invalid-speed-${speed}`));
    const persisted = await store.load(state.saveId);

    await expect(commands.setTimeSpeed(state, speed as never)).rejects.toThrow("时间速度");
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it("settles seven days in one commit with periodic reports and matches daily settlement exactly", async () => {
    async function opened(saveId: string) {
      const store = new InMemorySavePort();
      const commands = createGameCommands(store);
      let state = await commands.saveRoomBlueprint(createNewGame(saveId), "云岫商务房", prototypeCells());
      state = await commands.placeRoom(state, "slot-nw");
      state = await commands.openHotel(state);
      state = await commands.initializeOperations(state);
      return { store, commands, state };
    }
    const batchFixture = await opened("save-batch-seven");
    const dailyFixture = await opened("save-daily-seven");

    const batch = await batchFixture.commands.advanceOperationsDays(batchFixture.state, 7, 70_000);
    let daily = dailyFixture.state;
    for (let day = 1; day <= 7; day += 1) {
      daily = await dailyFixture.commands.advanceDay(daily, day * 10_000);
    }

    expect({
      ...batch,
      saveId: "same",
      revision: 0,
    }).toEqual({
      ...daily,
      saveId: "same",
      revision: 0,
    });
    expect(batch.operations?.dailyReports).toHaveLength(7);
    expect(batch.operations?.weeklyReports.map(({ endDay }) => endDay)).toEqual([7]);
    expect(batch.operations?.lastOfflineCheckpointMs).toBe(70_000);
    expect(batch.revision).toBe(batchFixture.state.revision + 1);
  });

  it("defines a zero-day batch as a reference-preserving no-op without a commit", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = await commands.initializeOperations(createNewGame("save-zero-batch"));
    const persisted = await store.load(state.saveId);

    const next = await commands.advanceOperationsDays(state, 0, 100);

    expect(next).toBe(state);
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it("rejects an invalid day inside a batch without a partial commit", async () => {
    const store = new InMemorySavePort();
    const baseCommands = createGameCommands(store);
    let state = await baseCommands.saveRoomBlueprint(createNewGame("save-batch-failure"), "云岫商务房", prototypeCells());
    state = await baseCommands.placeRoom(state, "slot-nw");
    state = await baseCommands.openHotel(state);
    state = await baseCommands.initializeOperations(state);
    const snapshot = structuredClone(state);
    const persisted = await store.load(state.saveId);
    state.operations!.dailyReports = [{
      day: 2, segments: [], revenueCents: 0, operatingCostCents: 0, financeCostCents: 0,
      netIncomeCents: 0, endingCashCents: state.cashCents, reputationBps: 5_000,
    }];

    await expect(baseCommands.advanceOperationsDays(state, 2, 1_000)).rejects.toThrow("营业日");
    expect(state.operations?.dailyReports).toHaveLength(1);
    expect(snapshot.currentDay).toBe(0);
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it("settles offline elapsed whole days, caps at seven, and checkpoints supplied time", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-offline-cap"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.checkpointOfflineTime(state, 1_000);

    const settled = await commands.settleOffline(state, 1_000 + 20 * 60_000, 60_000);

    expect(settled.currentDay).toBe(7);
    expect(settled.operations?.lastOfflineCheckpointMs).toBe(1_201_000);
    expect(settled.operations?.weeklyReports).toHaveLength(1);
    expect(settled.revision).toBe(state.revision + 1);
  });

  it("checkpoints elapsed time without inventing operating days before the hotel opens", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.initializeOperations(createNewGame("save-offline-before-open"));
    state = await commands.checkpointOfflineTime(state, 1_000);

    const caughtUp = await commands.settleOffline(state, 121_000, 60_000);

    expect(caughtUp.currentDay).toBe(0);
    expect(caughtUp.operations?.dailyReports).toEqual([]);
    expect(caughtUp.operations?.lastOfflineCheckpointMs).toBe(121_000);
  });

  it("updates the checkpoint for zero elapsed and does not repeat a live interval after reload", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-offline-reload"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.checkpointOfflineTime(state, 10_000);
    state = await commands.advanceDay(state, 70_000);
    const reloaded = await store.load(state.saveId);

    expect(reloaded?.operations?.lastOfflineCheckpointMs).toBe(70_000);
    const caughtUp = await commands.settleOffline(reloaded!, 70_000, 60_000);

    expect(caughtUp.currentDay).toBe(1);
    expect(caughtUp.operations?.dailyReports).toHaveLength(1);
    expect(caughtUp.operations?.lastOfflineCheckpointMs).toBe(70_000);
  });

  it.each([-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid offline now %s", async (nowMs) => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = await commands.initializeOperations(createNewGame(`save-offline-now-${nowMs}`));

    await expect(commands.checkpointOfflineTime(state, nowMs)).rejects.toThrow("检查点");
    await expect(commands.settleOffline(state, nowMs, 60_000)).rejects.toThrow();
  });

  it("keeps checkpoint monotonic and accepts the same value idempotently", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.initializeOperations(createNewGame("save-checkpoint-monotonic"));
    state = await commands.checkpointOfflineTime(state, 1_000);
    const same = await commands.checkpointOfflineTime(state, 1_000);

    expect(same).toBe(state);
    await expect(commands.checkpointOfflineTime(state, 999)).rejects.toThrow("倒退");
  });

  it("caps a batch at day 30 and atomically pauses operations time", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-day-30-batch"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.setTimeSpeed(state, 4);

    const finished = await commands.advanceOperationsDays(state, 31, 31_000);

    expect(finished.currentDay).toBe(30);
    expect(finished.operations?.dailyReports).toHaveLength(30);
    expect(finished.operations?.monthlyCloses).toHaveLength(1);
    expect(finished.operations?.timeSpeed).toBe(0);
    expect(finished.operations?.lastOfflineCheckpointMs).toBe(31_000);
    expect(finished.revision).toBe(state.revision + 1);
  });

  it("rejects a single operations advance after day 30 without saving", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-day-30-manual"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.advanceOperationsDays(state, 30, 30_000);
    const persisted = await store.load(state.saveId);

    await expect(commands.advanceDay(state, 31_000)).rejects.toThrow("30");
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it("caps offline settlement at day 30 and pauses time", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-day-30-offline"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.setTimeSpeed(state, 4);
    state = await commands.advanceOperationsDays(state, 28, 28_000);
    state = await commands.checkpointOfflineTime(state, 30_000);

    const finished = await commands.settleOffline(state, 10 * 60_000 + 30_000, 60_000);

    expect(finished.currentDay).toBe(30);
    expect(finished.operations?.dailyReports).toHaveLength(30);
    expect(finished.operations?.timeSpeed).toBe(0);
    expect(finished.operations?.lastOfflineCheckpointMs).toBe(630_000);
  });

  it("normalizes a restored day-30 speed to paused even with zero elapsed time", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-day-30-restored"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.advanceOperationsDays(state, 30, 30_000);
    const restored = {
      ...state,
      operations: { ...state.operations!, timeSpeed: 4 as const },
    };
    await store.commit(state.revision, { ...restored, revision: state.revision + 1 });
    const persisted = { ...restored, revision: state.revision + 1 };

    const normalized = await commands.settleOffline(persisted, 30_000, 60_000);

    expect(normalized.currentDay).toBe(30);
    expect(normalized.operations?.timeSpeed).toBe(0);
    expect(normalized.operations?.lastOfflineCheckpointMs).toBe(30_000);
  });

  it("rejects resuming time after day 30 without saving", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-day-30-speed"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.advanceOperationsDays(state, 30, 30_000);
    const persisted = await store.load(state.saveId);

    await expect(commands.setTimeSpeed(state, 4)).rejects.toThrow("30");
    expect(await store.load(state.saveId)).toEqual(persisted);
  });

  it("pauses a restored day-30 save while creating its first checkpoint", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomBlueprint(createNewGame("save-day-30-no-checkpoint"), "云岫商务房", prototypeCells());
    state = await commands.placeRoom(state, "slot-nw");
    state = await commands.openHotel(state);
    state = await commands.initializeOperations(state);
    state = await commands.advanceOperationsDays(state, 30, 30_000);
    const restored = {
      ...state,
      operations: { ...state.operations!, timeSpeed: 4 as const, lastOfflineCheckpointMs: null },
    };
    await store.commit(state.revision, { ...restored, revision: state.revision + 1 });

    const normalized = await commands.settleOffline(
      { ...restored, revision: state.revision + 1 },
      40_000,
      60_000,
    );

    expect(normalized.operations?.timeSpeed).toBe(0);
    expect(normalized.operations?.lastOfflineCheckpointMs).toBe(40_000);
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
