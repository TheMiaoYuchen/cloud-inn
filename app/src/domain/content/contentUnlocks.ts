import type { ContentScaleState, StableId } from "../building/buildingTypes";
import type { GameState } from "../game/state";
import {
  FACILITY_CATALOG,
  validateContentCatalog,
  type ContentUnlockPrerequisite,
} from "./contentCatalog";

function prerequisiteMet(
  prerequisite: ContentUnlockPrerequisite,
  state: Readonly<GameState>,
): boolean {
  const operations = state.operations;
  switch (prerequisite.source) {
    case "reputation":
      return Math.max(
        operations?.reputationBps ?? 0,
        operations?.maximumReputationBps ?? 0,
      ) >= prerequisite.thresholdBps;
    case "discovered-need":
      return operations?.discoveredNeeds.some(
        ({ segmentId, kind }) =>
          segmentId === prerequisite.segmentId && kind === prerequisite.kind,
      ) ?? false;
    case "built-facility":
      return Object.values(state.phase4?.facilities ?? {}).some(
        ({ type }) => type === prerequisite.facilityType,
      );
    case "completed-content-choice":
      return operations?.unlockedContent.includes(prerequisite.id) ?? false;
  }
}

export function projectContentUnlocks(
  state: Readonly<GameState>,
): readonly StableId[] {
  validateContentCatalog();
  return FACILITY_CATALOG
    .filter(({ unlockRule }) => unlockRule.all.every((rule) => prerequisiteMet(rule, state)))
    .map(({ id }) => id);
}

export function reconcileCatalogProgress(
  state: Readonly<ContentScaleState>,
  projectedIds: readonly StableId[],
): ContentScaleState {
  validateContentCatalog();
  const catalogIds = new Set(FACILITY_CATALOG.map(({ id }) => id));
  const earned = new Set<StableId>([
    ...state.catalogProgress.unlockedIds,
    ...projectedIds,
  ]);
  for (const unlockId of earned) {
    if (!catalogIds.has(unlockId)) throw new Error(`未知内容解锁：${unlockId}`);
  }
  const unlockedIds = FACILITY_CATALOG
    .map(({ id }) => id)
    .filter((unlockId) => earned.has(unlockId));

  return {
    ...state,
    catalogProgress: {
      ...state.catalogProgress,
      unlockedIds,
      discoveredMarketEntryIds: [...state.catalogProgress.discoveredMarketEntryIds],
    },
  };
}
