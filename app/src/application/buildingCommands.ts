import {
  projectHotelRoomOffers,
  reconcileHotelReferences,
} from "../domain/building/hotelInventory";
import {
  applyExpansion,
  applyTemplateSync,
  copyGuestFloor,
  previewExpansion,
  upgradeLegacyToPhase4,
} from "../domain/building/towerHotel";
import {
  projectContentUnlocks,
  reconcileCatalogProgress,
} from "../domain/content/contentUnlocks";
import type { GameState } from "../domain/game/state";
import type { OperationsState } from "../domain/operations/operationsTypes";
import {
  effectiveRate,
  validatePricePolicy,
  type PricePolicy,
  type PricingContext,
} from "../domain/operations/pricing";
import { assertSafeMoney } from "../domain/primitives";
import { pricingContextForState } from "./pricingContextForState";
import type { SavePort } from "./ports/SavePort";

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("存档修订号必须是非负安全整数");
  }
}

function defaultPolicy(
  roomOfferId: string,
  baseRateCents: number,
  context: Readonly<PricingContext>,
): PricePolicy {
  const doubled = BigInt(baseRateCents) * 2n;
  const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const policy: PricePolicy = {
    roomOfferId,
    baseRateCents,
    minRateCents: Math.max(1, Math.trunc(baseRateCents / 2)),
    maxRateCents: Number(doubled > maximumSafe ? maximumSafe : doubled),
    automaticPricing: true,
    nightlyRateCents: baseRateCents,
  };
  return {
    ...policy,
    nightlyRateCents: effectiveRate(policy, context),
  };
}

function reconcilePricePolicies(state: GameState): GameState {
  const operations = state.operations;
  if (!operations) return state;
  const offers = projectHotelRoomOffers(state);
  const context = pricingContextForState(state);
  const pricePolicies: OperationsState["pricePolicies"] = {};
  for (const offer of offers) {
    const existing = operations.pricePolicies[offer.id];
    if (
      existing &&
      "baseRateCents" in existing &&
      "minRateCents" in existing &&
      "maxRateCents" in existing &&
      "automaticPricing" in existing
    ) {
      const policy = { ...(existing as PricePolicy), roomOfferId: offer.id };
      validatePricePolicy(policy);
      pricePolicies[offer.id] = policy.automaticPricing
        ? { ...policy, nightlyRateCents: effectiveRate(policy, context) }
        : policy;
    } else {
      pricePolicies[offer.id] = defaultPolicy(
        offer.id,
        existing?.nightlyRateCents ?? offer.nightlyRateCents,
        context,
      );
    }
  }
  return {
    ...state,
    operations: { ...operations, pricePolicies },
  };
}

function completeBuildingState(candidate: Readonly<GameState>): GameState {
  let next = reconcileHotelReferences(candidate);
  next = reconcilePricePolicies(next);
  if (!next.phase4) throw new Error("内容规模系统尚未初始化");
  const phase4 = reconcileCatalogProgress(
    next.phase4,
    projectContentUnlocks(next),
  );
  return { ...next, phase4 };
}

export function createBuildingCommands(savePort: SavePort) {
  async function persist(
    current: Readonly<GameState>,
    changed: Readonly<GameState>,
  ): Promise<GameState> {
    assertRevision(current.revision);
    const next: GameState = {
      ...changed,
      revision: current.revision + 1,
    };
    await savePort.commit(current.revision, next);
    return next;
  }

  return {
    async initializeContentScale(state: GameState): Promise<GameState> {
      assertRevision(state.revision);
      assertSafeMoney(state.cashCents);
      return persist(state, completeBuildingState(upgradeLegacyToPhase4(state)));
    },

    async purchaseFloor(
      state: GameState,
      floorNumber: number,
      template: "dense-ring",
    ): Promise<GameState> {
      assertRevision(state.revision);
      const currentCashCents = assertSafeMoney(state.cashCents);
      if (template !== "dense-ring") throw new Error("未知客房楼层模板");
      const phase4 = state.phase4;
      if (!phase4) throw new Error("内容规模系统尚未初始化");
      if (!phase4.floorTemplates["template:guest:dense-ring"]) {
        throw new Error("高密度环廊模板不存在");
      }
      const preview = previewExpansion(state, floorNumber);
      if (!preview.available) throw new Error(`该楼层不可扩建：${preview.reason}`);
      if (currentCashCents < preview.costCents) throw new Error("现金不足以购买楼层");
      const expansion = applyExpansion(phase4, floorNumber);
      if (expansion.costCents !== preview.costCents) {
        throw new Error("楼层购买预览已过期");
      }
      const candidate: GameState = {
        ...state,
        cashCents: assertSafeMoney(currentCashCents - expansion.costCents),
        phase4: expansion.phase4,
      };
      return persist(state, completeBuildingState(candidate));
    },

    async copyFloor(
      state: GameState,
      sourceFloorId: string,
      floorNumber: number,
    ): Promise<GameState> {
      assertRevision(state.revision);
      assertSafeMoney(state.cashCents);
      if (!state.phase4) throw new Error("内容规模系统尚未初始化");
      const copied = copyGuestFloor(state.phase4, sourceFloorId, floorNumber);
      return persist(state, completeBuildingState({
        ...state,
        phase4: copied.phase4,
      }));
    },

    async syncFloorTemplate(
      state: GameState,
      selectedFloorIds: readonly string[],
    ): Promise<GameState> {
      assertRevision(state.revision);
      assertSafeMoney(state.cashCents);
      if (!state.phase4) throw new Error("内容规模系统尚未初始化");
      const phase4 = applyTemplateSync(state.phase4, selectedFloorIds);
      return persist(state, completeBuildingState({ ...state, phase4 }));
    },
  };
}
