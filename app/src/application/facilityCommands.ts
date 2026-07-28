import type { StableId } from "../domain/building/buildingTypes";
import {
  projectContentUnlocks,
  reconcileCatalogProgress,
} from "../domain/content/contentUnlocks";
import {
  FACILITY_OFFERINGS,
  createFacilityPolicy,
  operationGroupFor,
  projectFacilityOfferings,
} from "../domain/facilities/facilityOperations";
import type {
  FacilityPolicy,
  FacilityState,
} from "../domain/facilities/facilityTypes";
import type { GameState } from "../domain/game/state";
import { assertSafeMoney } from "../domain/primitives";
import { validatePublicSpace } from "../domain/spaces/spaceValidation";
import type { PublicSpaceBlueprint } from "../domain/spaces/spaceTypes";
import type { SavePort } from "./ports/SavePort";

/** Kept as the default/catalog maximum for callers that need a cost ceiling. */
export const SIGNATURE_DEVELOPMENT_COST_CENTS = 600_000;

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0 ||
      revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("存档修订号必须可安全递增");
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reconciled(state: GameState): GameState {
  if (!state.phase4) throw new Error("内容规模系统尚未初始化");
  return {
    ...state,
    phase4: reconcileCatalogProgress(
      state.phase4,
      projectContentUnlocks(state),
    ),
  };
}

function facilityFrom(state: Readonly<GameState>, facilityId: string): FacilityState {
  const phase4 = state.phase4;
  if (!phase4) throw new Error("内容规模系统尚未初始化");
  const facility = phase4.facilities[facilityId];
  if (!facility) throw new Error("设施不存在");
  if (facility.id !== facilityId) throw new Error("设施记录键与编号不一致");
  const instance = phase4.publicSpaces[facility.publicSpaceInstanceId];
  if (!instance || instance.type !== facility.type) throw new Error("设施公共空间引用无效");
  return facility;
}

function assertUnlocked(state: Readonly<GameState>, facility: Readonly<FacilityState>): void {
  if (!state.phase4!.catalogProgress.unlockedIds.includes(
    `facility:${facility.type}` as StableId,
  )) throw new Error("设施运营选择尚未解锁");
}

function withFacility(
  state: GameState,
  facility: FacilityState,
): GameState {
  return {
    ...state,
    phase4: {
      ...state.phase4!,
      facilities: Object.fromEntries(Object.values({
        ...state.phase4!.facilities,
        [facility.id]: facility,
      }).sort((left, right) => compareIds(left.id, right.id))
        .map((entry) => [entry.id, entry])),
    },
  };
}

export function createFacilityCommands(savePort: SavePort) {
  async function persist(current: Readonly<GameState>, changed: GameState): Promise<GameState> {
    assertRevision(current.revision);
    const next = { ...changed, revision: current.revision + 1 };
    await savePort.commit(current.revision, next);
    return next;
  }

  return {
    async configureFacility(
      state: GameState,
      facilityId: string,
      input: Readonly<FacilityPolicy>,
    ): Promise<GameState> {
      assertRevision(state.revision);
      assertSafeMoney(state.cashCents);
      const currentFacility = facilityFrom(state, facilityId);
      assertUnlocked(state, currentFacility);
      const candidate = reconciled(state);
      const facility = facilityFrom(candidate, facilityId);
      if (!operationGroupFor(facility.type)) {
        throw new Error("该设施不支持轻量运营配置");
      }
      const policy = createFacilityPolicy(facility.type, input);
      if (policy.signatureOfferingId &&
          !facility.developedOfferingIds.includes(policy.signatureOfferingId)) {
        throw new Error("招牌产品尚未开发");
      }
      if (JSON.stringify(facility.policy) === JSON.stringify(policy) &&
          facility.dailyOperatingCostCents === policy.serviceBudgetCents &&
          candidate.phase4!.catalogProgress.unlockedIds.length ===
            state.phase4!.catalogProgress.unlockedIds.length) return state;
      const updated: FacilityState = {
        ...structuredClone(facility),
        policy,
        dailyOperatingCostCents: policy.serviceBudgetCents,
      };
      return persist(state, reconciled(withFacility(candidate, updated)));
    },

    async developSignatureOffering(
      state: GameState,
      facilityId: string,
      offeringId: string,
    ): Promise<GameState> {
      assertRevision(state.revision);
      const cashCents = assertSafeMoney(state.cashCents);
      const currentFacility = facilityFrom(state, facilityId);
      assertUnlocked(state, currentFacility);
      const candidate = reconciled(state);
      const facility = facilityFrom(candidate, facilityId);
      const offering = FACILITY_OFFERINGS.find(({ id }) => id === offeringId);
      if (!offering) throw new Error("招牌产品不存在");
      if (!projectFacilityOfferings(facility.type).some(({ id }) => id === offering.id)) {
        throw new Error("招牌产品与设施类型不兼容");
      }
      if (facility.developedOfferingIds.includes(offering.id)) {
        return candidate.phase4!.catalogProgress.unlockedIds.length ===
          state.phase4!.catalogProgress.unlockedIds.length
          ? state
          : persist(state, candidate);
      }
      const developmentCostCents = assertSafeMoney(offering.developmentCostCents);
      if (cashCents < developmentCostCents) {
        throw new Error("现金不足以开发招牌产品");
      }
      const updated: FacilityState = {
        ...structuredClone(facility),
        developedOfferingIds: [...facility.developedOfferingIds, offering.id]
          .sort(compareIds),
      };
      return persist(state, reconciled(withFacility({
        ...candidate,
        cashCents: assertSafeMoney(cashCents - developmentCostCents),
      }, updated)));
    },

    async selectSignatureOffering(
      state: GameState,
      facilityId: string,
      offeringId: string,
    ): Promise<GameState> {
      assertRevision(state.revision);
      assertSafeMoney(state.cashCents);
      const currentFacility = facilityFrom(state, facilityId);
      assertUnlocked(state, currentFacility);
      const candidate = reconciled(state);
      const facility = facilityFrom(candidate, facilityId);
      const offering = FACILITY_OFFERINGS.find(({ id }) => id === offeringId);
      if (!offering) throw new Error("招牌产品不存在");
      if (!projectFacilityOfferings(facility.type).some(({ id }) => id === offering.id)) {
        throw new Error("招牌产品与设施类型不兼容");
      }
      if (!facility.developedOfferingIds.includes(offering.id)) {
        throw new Error("招牌产品尚未开发");
      }
      if (!facility.policy) throw new Error("设施尚未配置运营策略");
      if (facility.policy.signatureOfferingId === offering.id) {
        return candidate.phase4!.catalogProgress.unlockedIds.length ===
          state.phase4!.catalogProgress.unlockedIds.length
          ? state
          : persist(state, candidate);
      }
      const updated: FacilityState = {
        ...structuredClone(facility),
        policy: { ...facility.policy, signatureOfferingId: offering.id },
      };
      return persist(state, reconciled(withFacility(candidate, updated)));
    },

    async setFacilityEnabled(
      state: GameState,
      facilityId: string,
      enabled: boolean,
    ): Promise<GameState> {
      assertRevision(state.revision);
      assertSafeMoney(state.cashCents);
      if (typeof enabled !== "boolean") throw new Error("设施启用状态无效");
      const currentFacility = facilityFrom(state, facilityId);
      assertUnlocked(state, currentFacility);
      const candidate = reconciled(state);
      const facility = facilityFrom(candidate, facilityId);
      if (enabled && operationGroupFor(facility.type)) {
        if (!facility.policy) throw new Error("设施尚未配置运营策略");
        createFacilityPolicy(facility.type, facility.policy);
        if (facility.policy.signatureOfferingId &&
            !facility.developedOfferingIds.includes(facility.policy.signatureOfferingId)) {
          throw new Error("所选招牌产品尚未开发");
        }
      } else if (enabled) {
        const instance = candidate.phase4!.publicSpaces[facility.publicSpaceInstanceId];
        const blueprint = instance && candidate.phase4!.spaceBlueprints[instance.blueprintId];
        if (!instance || !blueprint || instance.type !== facility.type ||
            blueprint.type !== facility.type) {
          throw new Error("增益设施的公共空间引用无效");
        }
        const persisted = blueprint as PublicSpaceBlueprint;
        const validation = validatePublicSpace({
          type: blueprint.type,
          columns: blueprint.columns,
          rows: blueprint.rows,
          cells: blueprint.cells,
          items: blueprint.placedItems,
          walls: persisted.walls ?? [],
          doors: persisted.doors ?? [],
          windows: persisted.windows ?? [],
        });
        if (validation.blocking.length > 0) {
          throw new Error(validation.blocking.map(({ message }) => message).join("；"));
        }
      }
      if (facility.enabled === enabled &&
          facility.status === (enabled ? "operating" : "closed")) {
        return candidate.phase4!.catalogProgress.unlockedIds.length ===
          state.phase4!.catalogProgress.unlockedIds.length
          ? state
          : persist(state, candidate);
      }
      const updated: FacilityState = {
        ...structuredClone(facility),
        enabled,
        status: enabled ? "operating" : "closed",
      };
      return persist(state, reconciled(withFacility(candidate, updated)));
    },
  };
}
