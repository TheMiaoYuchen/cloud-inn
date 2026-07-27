import { matchGuest, type GuestMatch, type MatchReasonCode } from "./matchGuest";
import {
  GUEST_SEGMENT_IDS,
  type GuestSegmentId,
  type OperationsState,
  type RoomOfferUpgrade,
  type UpgradeKind,
} from "./operationsTypes";
import type { RoomOffer } from "./roomOffer";
import { getGuestSegment } from "./segmentCatalog";

export type { UpgradeKind } from "./operationsTypes";

export interface RoomOfferUpgradeRequest {
  roomOfferId: string;
  kind: UpgradeKind;
  level: number;
}

interface UpgradeLevelRule {
  level: number;
  costCents: number;
  closureDays: number;
  improvement: number;
}

export interface RoomOfferUpgradeRule {
  kind: UpgradeKind;
  maxLevel: number;
  levels: ReadonlyArray<Readonly<UpgradeLevelRule>>;
}

function freezeRule(rule: RoomOfferUpgradeRule): Readonly<RoomOfferUpgradeRule> {
  rule.levels.forEach(Object.freeze);
  Object.freeze(rule.levels);
  return Object.freeze(rule);
}

export const ROOM_OFFER_UPGRADE_CATALOG: Readonly<Record<UpgradeKind, Readonly<RoomOfferUpgradeRule>>> =
  Object.freeze({
    workspace: freezeRule({
      kind: "workspace",
      maxLevel: 2,
      levels: [
        { level: 1, costCents: 120_000, closureDays: 2, improvement: 1_500 },
        { level: 2, costCents: 200_000, closureDays: 3, improvement: 3_000 },
      ],
    }),
    view: freezeRule({
      kind: "view",
      maxLevel: 2,
      levels: [
        { level: 1, costCents: 180_000, closureDays: 2, improvement: 1_500 },
        { level: 2, costCents: 280_000, closureDays: 3, improvement: 3_000 },
      ],
    }),
    familyCapacity: freezeRule({
      kind: "familyCapacity",
      maxLevel: 2,
      levels: [
        { level: 1, costCents: 160_000, closureDays: 2, improvement: 1 },
        { level: 2, costCents: 240_000, closureDays: 3, improvement: 2 },
      ],
    }),
    privacy: freezeRule({
      kind: "privacy",
      maxLevel: 2,
      levels: [
        { level: 1, costCents: 150_000, closureDays: 2, improvement: 1_500 },
        { level: 2, costCents: 240_000, closureDays: 3, improvement: 3_000 },
      ],
    }),
  });

export interface ProjectedRoomOfferUpgrade {
  costCents: number;
  closureDays: number;
  beforeOffer: RoomOffer;
  afterOffer: RoomOffer;
  upgrade: RoomOfferUpgrade & Required<Pick<RoomOfferUpgrade,
    "kind" | "remainingClosureDays" | "costCents"
  >>;
}

export interface RenovationSegmentExplanation {
  segmentId: GuestSegmentId;
  before: GuestMatch;
  after: GuestMatch;
  scoreDeltaBps: number | null;
  topReasonChanges: MatchReasonCode[];
}

export interface RoomRenovationPreview extends ProjectedRoomOfferUpgrade {
  segments: RenovationSegmentExplanation[];
}

const UPGRADE_KINDS = Object.keys(ROOM_OFFER_UPGRADE_CATALOG) as UpgradeKind[];

function isUpgradeKind(value: string): value is UpgradeKind {
  return UPGRADE_KINDS.includes(value as UpgradeKind);
}

function assertLevel(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("改造等级必须是正安全整数");
}

function ruleFor(kind: UpgradeKind, level: number): Readonly<UpgradeLevelRule> {
  if (!isUpgradeKind(kind)) throw new Error("改造类型无效");
  assertLevel(level);
  const catalog = ROOM_OFFER_UPGRADE_CATALOG[kind];
  if (level > catalog.maxLevel) throw new Error("改造等级超过等级上限");
  return catalog.levels[level - 1];
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, value));
}

function kindFor(upgrade: Readonly<RoomOfferUpgrade>): UpgradeKind {
  const kind = upgrade.kind ?? upgrade.upgradeId;
  if (!isUpgradeKind(kind)) throw new Error("已保存的改造类型无效");
  if (upgrade.kind !== undefined && upgrade.upgradeId !== upgrade.kind) {
    throw new Error("已保存的改造编号与类型不一致");
  }
  return kind;
}

function validatePersistedUpgrade(upgrade: Readonly<RoomOfferUpgrade>): UpgradeKind {
  const kind = kindFor(upgrade);
  const rule = ruleFor(kind, upgrade.level);
  if (
    upgrade.remainingClosureDays !== undefined
    && (!Number.isSafeInteger(upgrade.remainingClosureDays) || upgrade.remainingClosureDays < 0)
  ) throw new Error("已保存的改造施工天数无效");
  if (
    upgrade.costCents !== undefined
    && (!Number.isSafeInteger(upgrade.costCents) || upgrade.costCents !== rule.costCents)
  ) throw new Error("已保存的改造成本无效");
  if (
    upgrade.committedDay !== undefined
    && (!Number.isSafeInteger(upgrade.committedDay) || upgrade.committedDay < 0)
  ) throw new Error("已保存的改造日期无效");
  return kind;
}

function projectKind(baseOffer: Readonly<RoomOffer>, kind: UpgradeKind, level: number): RoomOffer {
  const { improvement } = ruleFor(kind, level);
  const projected = structuredClone(baseOffer) as RoomOffer;
  if (kind === "familyCapacity") {
    if (baseOffer.bedType !== "twin") throw new Error("家庭容量改造仅兼容双床客房产品");
    projected.capacity = baseOffer.capacity + improvement;
  } else if (kind === "workspace") {
    projected.workspaceBps = clampBps(baseOffer.workspaceBps + improvement);
  } else if (kind === "view") {
    projected.viewBps = clampBps(baseOffer.viewBps + improvement);
  } else {
    projected.privacyBps = clampBps(baseOffer.privacyBps + improvement);
  }
  return projected;
}

export function roomOfferUpgradeKey(roomOfferId: string, kind: UpgradeKind): string {
  return `${roomOfferId}:${kind}`;
}

function currentUpgrade(
  operations: Readonly<OperationsState>,
  roomOfferId: string,
  kind: UpgradeKind,
): Readonly<RoomOfferUpgrade> | undefined {
  return operations.offerUpgrades[roomOfferUpgradeKey(roomOfferId, kind)];
}

function offerInConstruction(operations: Readonly<OperationsState>, roomOfferId: string): boolean {
  return Object.values(operations.offerUpgrades).some((upgrade) =>
    upgrade.roomOfferId === roomOfferId && (upgrade.remainingClosureDays ?? 0) > 0,
  );
}

export function validateRoomOfferUpgrades(
  offers: ReadonlyArray<Readonly<RoomOffer>>,
  operations: Pick<Readonly<OperationsState>, "offerUpgrades">,
): void {
  const offerIds = new Set(offers.map(({ id }) => id));
  for (const [key, upgrade] of Object.entries(operations.offerUpgrades)) {
    const kind = validatePersistedUpgrade(upgrade);
    if (!offerIds.has(upgrade.roomOfferId)) throw new Error("已保存的改造客房产品不存在");
    if (key !== roomOfferUpgradeKey(upgrade.roomOfferId, kind)) {
      throw new Error("已保存的改造键与内容不一致");
    }
  }
}

export function validateRoomOfferUpgrade(
  offer: Readonly<RoomOffer>,
  operations: Readonly<OperationsState>,
  request: Readonly<RoomOfferUpgradeRequest>,
): void {
  if (request.roomOfferId !== offer.id) throw new Error("客房产品不存在");
  if (!isUpgradeKind(request.kind)) throw new Error("改造类型无效");
  const existing = currentUpgrade(operations, offer.id, request.kind);
  if (existing) {
    validatePersistedUpgrade(existing);
  }
  const currentLevel = existing?.level ?? 0;
  if (Number.isSafeInteger(request.level) && request.level < currentLevel) {
    throw new Error("改造不能降级");
  }
  const rule = ruleFor(request.kind, request.level);
  if (!Number.isSafeInteger(rule.costCents) || rule.costCents < 0) throw new Error("改造成本无效");
  if (request.level === currentLevel) throw new Error("该改造等级已完成");
  if (request.level !== currentLevel + 1) throw new Error("改造必须逐级进行");
  if (offerInConstruction(operations, offer.id)) throw new Error("客房产品仍在施工中");
  projectKind(offer, request.kind, request.level);
}

export function projectRoomOfferUpgrade(
  offer: Readonly<RoomOffer>,
  request: Readonly<RoomOfferUpgradeRequest>,
  options: Readonly<{ allowInitialLevel?: boolean }> = {},
): ProjectedRoomOfferUpgrade {
  if (request.roomOfferId !== offer.id) throw new Error("客房产品不存在");
  const rule = ruleFor(request.kind, request.level);
  if (!options.allowInitialLevel && request.level !== 1) throw new Error("改造必须逐级进行");
  const beforeOffer = structuredClone(offer) as RoomOffer;
  return {
    costCents: rule.costCents,
    closureDays: rule.closureDays,
    beforeOffer,
    afterOffer: projectKind(beforeOffer, request.kind, request.level),
    upgrade: {
      roomOfferId: offer.id,
      upgradeId: request.kind,
      kind: request.kind,
      level: request.level,
      remainingClosureDays: rule.closureDays,
      costCents: rule.costCents,
    },
  };
}

export function applyRoomOfferUpgrades(
  baseOffer: Readonly<RoomOffer>,
  operations: Pick<Readonly<OperationsState>, "offerUpgrades">,
): RoomOffer {
  let projected = structuredClone(baseOffer) as RoomOffer;
  for (const kind of UPGRADE_KINDS) {
    const upgrade = operations.offerUpgrades[roomOfferUpgradeKey(baseOffer.id, kind)];
    if (!upgrade) continue;
    if (upgrade.roomOfferId !== baseOffer.id || validatePersistedUpgrade(upgrade) !== kind) {
      throw new Error("已保存的改造键与内容不一致");
    }
    projected = projectKind(projected, kind, upgrade.level);
  }
  return projected;
}

function changedReasons(before: GuestMatch, after: GuestMatch): MatchReasonCode[] {
  const reasons: MatchReasonCode[] = [];
  if (before.hardFailure !== after.hardFailure) {
    if (before.hardFailure) reasons.push(before.hardFailure);
    if (after.hardFailure) reasons.push(after.hardFailure);
  }
  const beforeFactors = new Map(before.factors.map((factor) => [factor.code, factor.contributionBps]));
  const afterFactors = new Map(after.factors.map((factor) => [factor.code, factor.contributionBps]));
  for (const code of ["view-fit", "workspace-fit", "quiet-fit", "privacy-fit", "design-fit", "price-fit"] as const) {
    if ((beforeFactors.get(code) ?? 0) !== (afterFactors.get(code) ?? 0)) reasons.push(code);
  }
  return reasons;
}

export function previewRoomOfferUpgrade(
  baseOffer: Readonly<RoomOffer>,
  operations: Readonly<OperationsState>,
  request: Readonly<RoomOfferUpgradeRequest>,
): RoomRenovationPreview {
  validateRoomOfferUpgrade(baseOffer, operations, request);
  const beforeOffer = applyRoomOfferUpgrades(baseOffer, operations);
  const replacedOperations = structuredClone(operations) as OperationsState;
  replacedOperations.offerUpgrades[roomOfferUpgradeKey(baseOffer.id, request.kind)] =
    projectRoomOfferUpgrade(baseOffer, request, { allowInitialLevel: true }).upgrade;
  const afterOffer = applyRoomOfferUpgrades(baseOffer, replacedOperations);
  const rule = ruleFor(request.kind, request.level);
  const projected: ProjectedRoomOfferUpgrade = {
    costCents: rule.costCents,
    closureDays: rule.closureDays,
    beforeOffer,
    afterOffer,
    upgrade: {
      roomOfferId: baseOffer.id,
      upgradeId: request.kind,
      kind: request.kind,
      level: request.level,
      remainingClosureDays: rule.closureDays,
      costCents: rule.costCents,
    },
  };
  return {
    ...projected,
    beforeOffer,
    segments: GUEST_SEGMENT_IDS.map((segmentId) => {
      const segment = getGuestSegment(segmentId);
      const before = matchGuest(segment, beforeOffer);
      const after = matchGuest(segment, projected.afterOffer);
      return {
        segmentId,
        before,
        after,
        scoreDeltaBps: before.preferenceScoreBps === null || after.preferenceScoreBps === null
          ? null
          : after.preferenceScoreBps - before.preferenceScoreBps,
        topReasonChanges: changedReasons(before, after),
      };
    }),
  };
}
