import {
  projectHotelInventory,
  projectHotelRoomOffers,
  reconcileHotelReferences,
} from "../domain/building/hotelInventory";
import {
  applyExpansion,
  applyFloorCopy,
  applyTemplateSync,
  previewExpansion,
  previewFloorCopy,
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
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("存档修订号必须可安全递增");
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

function reconcilePricePolicies(
  state: GameState,
  preserveExistingAutomaticRates = false,
): GameState {
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
      pricePolicies[offer.id] = policy.automaticPricing && !preserveExistingAutomaticRates
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

function completeBuildingState(
  candidate: Readonly<GameState>,
  preserveExistingAutomaticRates = false,
): GameState {
  let next = reconcileHotelReferences(candidate);
  next = reconcilePricePolicies(next, preserveExistingAutomaticRates);
  if (!next.phase4) throw new Error("内容规模系统尚未初始化");
  const phase4 = reconcileCatalogProgress(
    next.phase4,
    projectContentUnlocks(next),
  );
  return { ...next, phase4 };
}

function migratedOfferIdMap(
  previous: Readonly<GameState>,
  upgraded: Readonly<GameState>,
): Map<string, string> {
  const legacyRoomsById = new Map(
    previous.floor.rooms.map((room) => [room.id, room]),
  );
  const legacyInventory = projectHotelInventory(previous).rooms;
  const targetInventory = projectHotelInventory({
    ...upgraded,
    operations: undefined,
  }).rooms;
  const targetsByIdentity = new Map<string, typeof targetInventory>();
  for (const target of targetInventory) {
    const identity = target.variantId ?? target.roomBlueprintId;
    const key = `${target.localPlacementId}\u0000${identity}`;
    const candidates = targetsByIdentity.get(key) ?? [];
    candidates.push(target);
    targetsByIdentity.set(key, candidates);
  }
  const result = new Map<string, string>();
  for (const legacy of legacyInventory) {
    const legacyRoom = legacyRoomsById.get(legacy.sourceRoomId);
    if (!legacyRoom || legacyRoom.slotId !== legacy.localPlacementId) {
      throw new Error(`旧客房产品 ${legacy.id} 无法解析物理槽位`);
    }
    const identity = legacy.variantId ?? legacy.roomBlueprintId;
    const candidates = targetsByIdentity.get(
      `${legacyRoom.slotId}\u0000${identity}`,
    ) ?? [];
    if (candidates.length !== 1) {
      throw new Error(`旧客房产品 ${legacy.id} 无法唯一映射到新客房产品`);
    }
    result.set(legacy.id, candidates[0].id);
  }
  return result;
}

function migrateLegacyOperationsReferences(
  previous: Readonly<GameState>,
  upgraded: GameState,
): GameState {
  const operations = previous.operations;
  if (!operations || previous.phase4 || !upgraded.phase4) return upgraded;
  const offerIdMap = migratedOfferIdMap(previous, upgraded);
  const pricePolicies: OperationsState["pricePolicies"] = {};
  for (const [key, policy] of Object.entries(operations.pricePolicies)) {
    const mappedId = offerIdMap.get(key);
    if (!mappedId) {
      pricePolicies[key] = structuredClone(policy);
      continue;
    }
    if (policy.roomOfferId !== key) {
      throw new Error("旧房价策略键与客房产品不匹配");
    }
    if (pricePolicies[mappedId]) throw new Error("旧房价策略映射冲突");
    pricePolicies[mappedId] = { ...structuredClone(policy), roomOfferId: mappedId };
  }
  const offerUpgrades: OperationsState["offerUpgrades"] = {};
  for (const [key, upgrade] of Object.entries(operations.offerUpgrades)) {
    if (upgrade.kind === undefined) {
      offerUpgrades[key] = structuredClone(upgrade);
      continue;
    }
    const mappedId = offerIdMap.get(upgrade.roomOfferId);
    if (!mappedId) {
      throw new Error(`付费客房改造 ${key} 无法映射到新客房产品`);
    }
    if (key !== `${upgrade.roomOfferId}:${upgrade.kind}`) {
      throw new Error("旧客房改造键与内容不一致");
    }
    const mappedKey = `${mappedId}:${upgrade.kind}`;
    if (offerUpgrades[mappedKey]) throw new Error("旧客房改造映射冲突");
    offerUpgrades[mappedKey] = {
      ...structuredClone(upgrade),
      roomOfferId: mappedId,
    };
  }
  return {
    ...upgraded,
    operations: { ...operations, pricePolicies, offerUpgrades },
  };
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
      if (state.phase4) return state;
      if (state.phase !== "ready" && state.phase !== "open") {
        throw new Error("酒店必须进入待开业或营业阶段，才能初始化内容规模系统");
      }
      const upgraded = upgradeLegacyToPhase4(state);
      return persist(
        state,
        completeBuildingState(
          migrateLegacyOperationsReferences(state, upgraded),
          true,
        ),
      );
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
      const currentCashCents = assertSafeMoney(state.cashCents);
      const phase4 = state.phase4;
      if (!phase4) throw new Error("内容规模系统尚未初始化");
      const preview = previewFloorCopy(phase4, sourceFloorId, floorNumber);
      if (!preview.available) throw new Error(`该楼层不可扩建：${preview.reason}`);
      if (currentCashCents < preview.costCents) throw new Error("现金不足以购买楼层");
      const copied = applyFloorCopy(phase4, sourceFloorId, floorNumber);
      if (copied.costCents !== preview.costCents) {
        throw new Error("楼层购买预览已过期");
      }
      return persist(state, completeBuildingState({
        ...state,
        cashCents: assertSafeMoney(currentCashCents - copied.costCents),
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
