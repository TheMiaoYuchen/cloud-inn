import type { GuestSegmentId } from "./operationsTypes";

export type BedType = "king" | "twin" | "double";

export interface GuestSegment {
  id: GuestSegmentId;
  displayName: string;
  baseDailyDemand: number;
  hardRequirements: {
    minimumCapacity?: number;
    minimumAreaSquareMeters?: number;
    requiredBedTypes?: BedType[];
  };
  priceSensitivityBps: number;
  preferenceWeights: {
    view: number;
    workspace: number;
    quiet: number;
    privacy: number;
    design: number;
    price: number;
  };
  initiallyHiddenNeedLabels: string[];
}

function freezeSegment(segment: GuestSegment): Readonly<GuestSegment> {
  if (segment.hardRequirements.requiredBedTypes) {
    Object.freeze(segment.hardRequirements.requiredBedTypes);
  }
  Object.freeze(segment.hardRequirements);
  Object.freeze(segment.preferenceWeights);
  Object.freeze(segment.initiallyHiddenNeedLabels);
  return Object.freeze(segment);
}

export const GUEST_SEGMENTS: ReadonlyArray<Readonly<GuestSegment>> = Object.freeze([
  freezeSegment({
    id: "business",
    displayName: "商务差旅",
    baseDailyDemand: 6,
    hardRequirements: {},
    priceSensitivityBps: 5_500,
    preferenceWeights: { view: 500, workspace: 3_000, quiet: 2_500, privacy: 1_000, design: 1_000, price: 2_000 },
    initiallyHiddenNeedLabels: ["稳定办公桌", "安静睡眠环境", "快捷入住"],
  }),
  freezeSegment({
    id: "couple",
    displayName: "情侣度假",
    baseDailyDemand: 5,
    hardRequirements: { requiredBedTypes: ["king", "double"] },
    priceSensitivityBps: 5_000,
    preferenceWeights: { view: 2_000, workspace: 250, quiet: 1_000, privacy: 2_500, design: 2_500, price: 1_750 },
    initiallyHiddenNeedLabels: ["私密氛围", "景观浴室", "纪念日布置"],
  }),
  freezeSegment({
    id: "family",
    displayName: "家庭出游",
    baseDailyDemand: 4,
    hardRequirements: { minimumCapacity: 3 },
    priceSensitivityBps: 8_000,
    preferenceWeights: { view: 500, workspace: 250, quiet: 1_000, privacy: 750, design: 1_000, price: 3_500 },
    initiallyHiddenNeedLabels: ["三人以上入住", "儿童友好", "充足收纳"],
  }),
  freezeSegment({
    id: "leisure",
    displayName: "休闲观光",
    baseDailyDemand: 5,
    hardRequirements: {},
    priceSensitivityBps: 7_000,
    preferenceWeights: { view: 2_500, workspace: 250, quiet: 1_250, privacy: 750, design: 2_000, price: 3_250 },
    initiallyHiddenNeedLabels: ["城市景观", "舒适休憩", "本地体验"],
  }),
  freezeSegment({
    id: "high-net-worth",
    displayName: "高净值宾客",
    baseDailyDemand: 2,
    hardRequirements: { minimumAreaSquareMeters: 50 },
    priceSensitivityBps: 2_000,
    preferenceWeights: { view: 2_000, workspace: 500, quiet: 1_000, privacy: 3_000, design: 3_000, price: 500 },
    initiallyHiddenNeedLabels: ["宽阔面积", "高度私密", "专属礼遇"],
  }),
  freezeSegment({
    id: "cultural-experience",
    displayName: "文化体验客",
    baseDailyDemand: 3,
    hardRequirements: {},
    priceSensitivityBps: 5_000,
    preferenceWeights: { view: 1_000, workspace: 250, quiet: 750, privacy: 500, design: 5_000, price: 2_500 },
    initiallyHiddenNeedLabels: ["在地文化表达", "天然材质", "设计故事"],
  }),
]);

export function getGuestSegment(id: GuestSegmentId): Readonly<GuestSegment> {
  const segment = GUEST_SEGMENTS.find((candidate) => candidate.id === id);
  if (!segment) {
    throw new Error(`未知客群：${id}`);
  }
  return segment;
}
