import type { GameState } from "../game/state";
import {
  FACILITY_CATALOG,
  ITEM_CATALOG,
  type ContentUnlockPrerequisite,
  type FacilityCatalogEntry,
} from "./contentCatalog";
import {
  MENU_STRUCTURES,
  type FacilityMenuStructure,
} from "../facilities/facilityOperations";
import { GUEST_SEGMENTS } from "../operations/segmentCatalog";

export interface ContentProgressEntry {
  id: string;
  name: string;
  unlocked: boolean;
  lockedReasons: readonly string[];
  effects: readonly string[];
}

export interface FacilityProgressEntry extends ContentProgressEntry {
  type: FacilityCatalogEntry["type"];
  prerequisites: readonly { description: string; met: boolean }[];
}

export interface ContentProgressProjection {
  facilities: readonly FacilityProgressEntry[];
  items: readonly ContentProgressEntry[];
  menus: readonly ContentProgressEntry[];
}

function prerequisiteReason(prerequisite: ContentUnlockPrerequisite): string {
  switch (prerequisite.source) {
    case "reputation":
      return `酒店最高声誉达到 ${prerequisite.thresholdBps / 100}%`;
    case "discovered-need":
      return `发现${GUEST_SEGMENTS.find(({ id }) => id === prerequisite.segmentId)?.displayName ?? prerequisite.segmentId}客群的${{
        "room-feature": "客房功能",
        service: "服务",
        price: "价格",
      }[prerequisite.kind]}需求`;
    case "built-facility":
      return `先建成 ${FACILITY_CATALOG.find(({ type }) => type === prerequisite.facilityType)?.name ?? prerequisite.facilityType}设施`;
    case "completed-content-choice":
      return `完成指定内容里程碑（${prerequisite.id}）`;
  }
}

function prerequisiteMet(
  prerequisite: ContentUnlockPrerequisite,
  state: Readonly<GameState>,
): boolean {
  switch (prerequisite.source) {
    case "reputation":
      return Math.max(
        state.operations?.reputationBps ?? 0,
        state.operations?.maximumReputationBps ?? 0,
      ) >= prerequisite.thresholdBps;
    case "discovered-need":
      return state.operations?.discoveredNeeds.some(({ segmentId, kind }) =>
        segmentId === prerequisite.segmentId && kind === prerequisite.kind) ?? false;
    case "built-facility":
      return Object.values(state.phase4?.facilities ?? {}).some(({ type }) =>
        type === prerequisite.facilityType);
    case "completed-content-choice":
      return state.operations?.unlockedContent.includes(prerequisite.id) ?? false;
  }
}

function facilityEffects(entry: Readonly<FacilityCatalogEntry>): string[] {
  return [
    `容量 ${entry.defaultCapacity.minimum}-${entry.defaultCapacity.maximum} 人`,
    `建造成本约 ¥${entry.constructionCostCents.minimum / 100}-¥${entry.constructionCostCents.maximum / 100}`,
    entry.operatingMode === "boost" ? "提升酒店整体体验" : "可配置轻量运营策略",
  ];
}

function unlockedFacilityTypes(state: Readonly<GameState>): Set<FacilityCatalogEntry["type"]> {
  const unlockedIds = new Set(state.phase4?.catalogProgress.unlockedIds ?? []);
  return new Set(FACILITY_CATALOG.filter(({ id }) => unlockedIds.has(id)).map(({ type }) => type));
}

function supportingFacilitiesForItem(itemId: string): readonly Readonly<FacilityCatalogEntry>[] {
  return FACILITY_CATALOG.filter(({ permittedItemIds }) => permittedItemIds.includes(itemId as never));
}

function supportingFacilitiesForMenu(
  menu: Readonly<FacilityMenuStructure>,
): readonly Readonly<FacilityCatalogEntry>[] {
  return FACILITY_CATALOG.filter(({ type }) => menu.facilityTypes.includes(type));
}

function dependentEntry(
  id: string,
  name: string,
  supporting: readonly Readonly<FacilityCatalogEntry>[],
  unlockedTypes: ReadonlySet<FacilityCatalogEntry["type"]>,
  effect: string,
): ContentProgressEntry {
  const unlocked = supporting.some(({ type }) => unlockedTypes.has(type));
  return {
    id,
    name,
    unlocked,
    lockedReasons: unlocked
      ? []
      : [`先解锁适用设施：${supporting.map(({ name: facilityName }) => facilityName).join("、")}`],
    effects: [effect],
  };
}

export function projectContentProgress(
  state: Readonly<GameState>,
): ContentProgressProjection {
  const unlockedIds = new Set(state.phase4?.catalogProgress.unlockedIds ?? []);
  const unlockedTypes = unlockedFacilityTypes(state);
  const facilities = FACILITY_CATALOG.map((entry): FacilityProgressEntry => {
    const unlocked = unlockedIds.has(entry.id);
    const prerequisites = entry.unlockRule.all.map((prerequisite) => ({
      description: prerequisiteReason(prerequisite),
      met: prerequisiteMet(prerequisite, state),
    }));
    const unmet = prerequisites.filter(({ met }) => !met).map(({ description }) => description);
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      unlocked,
      lockedReasons: unlocked ? [] : unmet.length ? unmet : ["尚未记录为已解锁"],
      effects: facilityEffects(entry),
      prerequisites,
    };
  });
  const items = ITEM_CATALOG.map((entry) => dependentEntry(
    entry.id,
    entry.name,
    supportingFacilitiesForItem(entry.id),
    unlockedTypes,
    "用于公共空间布置，并参与容量或体验评估",
  ));
  const menus = MENU_STRUCTURES.map((entry) => dependentEntry(
    entry.id,
    entry.name,
    supportingFacilitiesForMenu(entry),
    unlockedTypes,
    "为适用餐饮设施提供菜单结构",
  ));
  return { facilities, items, menus };
}
