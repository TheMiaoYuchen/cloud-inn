import {
  assertPublicSpaceCount,
  assertStableId,
  type ContentScaleState,
  type StableId,
} from "../domain/building/buildingTypes";
import {
  projectContentUnlocks,
  reconcileCatalogProgress,
} from "../domain/content/contentUnlocks";
import type {
  FacilityState,
  PublicSpaceInstance,
  PublicSpaceType,
} from "../domain/facilities/facilityTypes";
import type { GameState } from "../domain/game/state";
import { GUEST_SEGMENT_IDS } from "../domain/operations/operationsTypes";
import { assertSafeMoney } from "../domain/primitives";
import { sanitizeSpaceDraft } from "../domain/spaces/spaceEditor";
import type {
  PublicSpaceBlueprint,
  SpaceDraft,
} from "../domain/spaces/spaceTypes";
import { validatePublicSpace } from "../domain/spaces/spaceValidation";
import type { SavePort } from "./ports/SavePort";
import { assertPublicSpaceGraph, projectPublicSpacePlacement } from "./publicSpaceGraph";

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0 ||
      revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("存档修订号必须可安全递增");
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableRecord<T extends { id: string }>(values: readonly T[]): Record<string, T> {
  return Object.fromEntries([...values]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((value) => [value.id, value]));
}

function draftFor(input: Readonly<PublicSpaceBlueprint>): SpaceDraft {
  return {
    type: input.type,
    columns: input.columns,
    rows: input.rows,
    cells: input.cells,
    items: input.placedItems,
    walls: input.walls,
    doors: input.doors,
    windows: input.windows,
  };
}

function canonicalBlueprint(input: Readonly<PublicSpaceBlueprint>): PublicSpaceBlueprint {
  const blueprintId = assertStableId(input.id);
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("公共空间名称不能为空");
  }
  const sanitized = sanitizeSpaceDraft(draftFor(input));
  const validation = validatePublicSpace(sanitized.draft, sanitized);
  const blocking = [
    ...sanitized.reasons,
    ...validation.blocking.map(({ message }) => message),
  ].filter((message, index, values) => values.indexOf(message) === index);
  if (blocking.length > 0) {
    throw new Error(blocking.join("；"));
  }
  return {
    id: blueprintId,
    type: sanitized.draft.type,
    name: input.name.trim().slice(0, 80),
    columns: sanitized.draft.columns,
    rows: sanitized.draft.rows,
    cells: sanitized.draft.cells.map(({ x, y, zoneId }) => ({
      x, y, zoneId: assertStableId(zoneId),
    })),
    placedItems: sanitized.draft.items.map((item) => ({
      ...item,
      id: assertStableId(item.id),
      catalogItemId: assertStableId(item.catalogItemId),
    })),
    walls: sanitized.draft.walls.map((opening) => ({ ...opening })),
    doors: sanitized.draft.doors.map((opening) => ({ ...opening })),
    windows: sanitized.draft.windows.map((opening) => ({ ...opening })),
    committedBuildCostCents: assertSafeMoney(validation.metrics.constructionCostCents),
  };
}

function createSegmentInputs(): FacilityState["segmentInputs"] {
  return Object.fromEntries(GUEST_SEGMENT_IDS.map((segmentId) => [segmentId, {
    appealBps: 0,
    satisfactionBps: 5_000,
    dailyDemand: 0,
  }])) as FacilityState["segmentInputs"];
}

function newFacility(
  id: StableId,
  type: PublicSpaceType,
  publicSpaceInstanceId: StableId,
): FacilityState {
  return {
    id,
    type,
    publicSpaceInstanceId,
    status: "planned",
    enabled: false,
    dailyOperatingCostCents: 0,
    segmentInputs: createSegmentInputs(),
    policy: null,
    menuSelection: null,
    developedOfferingIds: [],
    dailyResults: [],
  };
}

function reconcileCandidate(state: GameState): GameState {
  if (!state.phase4) throw new Error("内容规模系统尚未初始化");
  return {
    ...state,
    phase4: reconcileCatalogProgress(
      state.phase4,
      projectContentUnlocks(state),
    ),
  };
}

function assertSharedBlueprintUnchanged(
  phase4: Readonly<ContentScaleState>,
  blueprint: Readonly<PublicSpaceBlueprint>,
  excludedInstanceId?: StableId,
): void {
  const hasOtherReference = Object.values(phase4.publicSpaces).some(({ id, blueprintId }) =>
    id !== excludedInstanceId && blueprintId === blueprint.id);
  if (!hasOtherReference) return;
  const persisted = phase4.spaceBlueprints[blueprint.id];
  if (!persisted || !deepEqual(persisted, blueprint)) {
    throw new Error("共享公共空间蓝图不能被修改，请使用新的蓝图编号");
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null ||
      typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort(compareIds);
  const rightKeys = Object.keys(rightRecord).sort(compareIds);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] &&
      deepEqual(leftRecord[key], rightRecord[key]));
}

export function createSpaceCommands(savePort: SavePort) {
  async function persist(current: Readonly<GameState>, changed: GameState): Promise<GameState> {
    assertRevision(current.revision);
    const next = { ...changed, revision: current.revision + 1 };
    await savePort.commit(current.revision, next);
    return next;
  }

  return {
    async savePublicSpaceBlueprint(
      state: GameState,
      input: Readonly<PublicSpaceBlueprint>,
    ): Promise<GameState> {
      assertRevision(state.revision);
      assertSafeMoney(state.cashCents);
      if (!state.phase4) throw new Error("内容规模系统尚未初始化");
      const blueprint = canonicalBlueprint(input);
      assertPublicSpaceGraph(state.phase4);
      const referenced = Object.values(state.phase4.publicSpaces)
        .filter(({ blueprintId }) => blueprintId === blueprint.id);
      if (referenced.some(({ type }) => type !== blueprint.type)) {
        throw new Error("公共空间蓝图已被已建空间引用，不能更改类型");
      }
      assertSharedBlueprintUnchanged(state.phase4, blueprint);
      const phase4: ContentScaleState = {
        ...state.phase4,
        spaceBlueprints: stableRecord([
          ...Object.values(state.phase4.spaceBlueprints)
            .filter(({ id }) => id !== blueprint.id),
          blueprint,
        ]),
      };
      return persist(state, reconcileCandidate({ ...state, phase4 }));
    },

    async placePublicSpace(
      state: GameState,
      input: Readonly<PublicSpaceBlueprint>,
      floorId: string,
    ): Promise<GameState> {
      assertRevision(state.revision);
      const cashCents = assertSafeMoney(state.cashCents);
      if (!state.phase4) throw new Error("内容规模系统尚未初始化");
      const blueprint = canonicalBlueprint(input);
      const current = state.phase4;
      const unlockId = assertStableId(`facility:${blueprint.type}`);
      if (!current.catalogProgress.unlockedIds.includes(unlockId)) {
        throw new Error("该公共空间类型尚未解锁");
      }
      const placement = projectPublicSpacePlacement(current, floorId, blueprint.type);
      if (placement.slot.width !== undefined && placement.slot.height !== undefined &&
          (blueprint.columns > placement.slot.width || blueprint.rows > placement.slot.height)) {
        throw new Error(
          `公共空间尺寸超过目标槽位 ${placement.slot.width}×${placement.slot.height}`,
        );
      }
      assertSharedBlueprintUnchanged(current, blueprint, placement.previous?.id);
      if (Object.values(current.facilities).some(({ id, type, publicSpaceInstanceId }) =>
        type === blueprint.type && id === `facility:${floorId}:${blueprint.type}` &&
        publicSpaceInstanceId !== placement.previous?.id)) {
        throw new Error("同一楼层不能重复放置同类型设施");
      }
      const existingCount = Object.keys(current.publicSpaces).length;
      assertPublicSpaceCount(existingCount + (placement.previous ? 0 : 1));
      const refund = placement.previous
        ? assertSafeMoney(placement.previous.committedBuildCostCents)
        : 0;
      const nextCashBigInt = BigInt(cashCents) + BigInt(refund) -
        BigInt(blueprint.committedBuildCostCents);
      if (nextCashBigInt < 0n) throw new Error("现金不足以建造公共空间");
      if (nextCashBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("金额超出安全整数范围");
      }
      const instanceId = assertStableId(
        `public-space:${current.floors[placement.floorIndex].id}:${placement.slot.id}`,
      );
      const facilityId = assertStableId(
        `facility:${current.floors[placement.floorIndex].id}:${blueprint.type}`,
      );
      const instance: PublicSpaceInstance = {
        id: instanceId,
        floorId: current.floors[placement.floorIndex].id,
        localPlacementId: placement.slot.id,
        blueprintId: blueprint.id,
        type: blueprint.type,
        committedBuildCostCents: blueprint.committedBuildCostCents,
      };
      const priorFacilities = Object.values(current.facilities);
      const priorFacility = placement.previous
        ? priorFacilities.find(({ publicSpaceInstanceId }) =>
            publicSpaceInstanceId === placement.previous!.id)
        : undefined;
      if (placement.previous && !priorFacility) {
        throw new Error("被替换公共空间的设施状态不存在");
      }
      const facility = priorFacility?.type === blueprint.type
        ? { ...structuredClone(priorFacility), id: facilityId, type: blueprint.type,
            publicSpaceInstanceId: instanceId }
        : newFacility(facilityId, blueprint.type, instanceId);
      const publicSpaces = stableRecord([
        ...Object.values(current.publicSpaces)
          .filter(({ id }) => id !== placement.previous?.id),
        instance,
      ]);
      const oldBlueprintId = placement.previous?.blueprintId;
      const oldBlueprintStillUsed = oldBlueprintId && Object.values(publicSpaces)
        .some(({ blueprintId }) => blueprintId === oldBlueprintId);
      const spaceBlueprints = stableRecord([
        ...Object.values(current.spaceBlueprints).filter(({ id }) =>
          id !== blueprint.id && (id !== oldBlueprintId || oldBlueprintStillUsed)),
        blueprint,
      ]);
      const facilities = stableRecord([
        ...priorFacilities.filter(({ id, publicSpaceInstanceId }) =>
          id !== facility.id && publicSpaceInstanceId !== placement.previous?.id),
        facility,
      ]);
      const floors = current.floors.map((floor, index) => index !== placement.floorIndex
        ? structuredClone(floor)
        : {
            ...structuredClone(floor),
            publicSpaceInstanceIds: [...new Set([
              ...floor.publicSpaceInstanceIds.filter((id) => id !== placement.previous?.id),
              instanceId,
            ])].sort(compareIds),
          });
      const phase4: ContentScaleState = {
        ...current,
        floors,
        spaceBlueprints,
        publicSpaces,
        facilities,
      };
      return persist(state, reconcileCandidate({
        ...state,
        cashCents: Number(nextCashBigInt),
        phase4,
      }));
    },
  };
}
