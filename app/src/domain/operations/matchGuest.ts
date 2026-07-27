import type { GuestSegmentId } from "./operationsTypes";
import type { RoomOffer } from "./roomOffer";
import type { GuestSegment } from "./segmentCatalog";

export type HardFailureCode =
  | "requires-family-capacity"
  | "requires-minimum-capacity"
  | "requires-minimum-area"
  | "requires-bed-type";

export type MatchFactorCode =
  | "view-fit"
  | "workspace-fit"
  | "quiet-fit"
  | "privacy-fit"
  | "design-fit"
  | "price-fit";

export type MatchReasonCode = HardFailureCode | MatchFactorCode;

export interface RoomMatchFactor {
  code: MatchFactorCode;
  contributionBps: number;
}

export interface GuestMatch {
  segmentId: GuestSegmentId;
  offerId: string;
  eligible: boolean;
  hardFailure: HardFailureCode | null;
  preferenceScoreBps: number | null;
  factors: RoomMatchFactor[];
  topPositiveFactors: RoomMatchFactor[];
  topNegativeFactors: RoomMatchFactor[];
}

export const MATCH_REASON_TEXT: Readonly<Record<MatchReasonCode, string>> = Object.freeze({
  "requires-family-capacity": "家庭客群需要更多床位与入住容量",
  "requires-minimum-capacity": "客房入住容量不足",
  "requires-minimum-area": "客房面积未达到该客群的最低要求",
  "requires-bed-type": "客房床型不符合该客群的必要条件",
  "view-fit": "景观符合度",
  "workspace-fit": "办公条件符合度",
  "quiet-fit": "安静程度符合度",
  "privacy-fit": "私密性符合度",
  "design-fit": "设计风格符合度",
  "price-fit": "价格接受度",
});

const FACTOR_ORDER: MatchFactorCode[] = [
  "view-fit",
  "workspace-fit",
  "quiet-fit",
  "privacy-fit",
  "design-fit",
  "price-fit",
];

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.trunc(value)));
}

function centeredContribution(attributeBps: number, weightBps: number): number {
  return Math.trunc(((clampBps(attributeBps) - 5_000) * weightBps) / 10_000);
}

function hardFailure(
  segment: Readonly<GuestSegment>,
  offer: Readonly<RoomOffer>,
): HardFailureCode | null {
  const requiredCapacity = segment.hardRequirements.minimumCapacity;
  if (requiredCapacity !== undefined && offer.capacity < requiredCapacity) {
    return segment.id === "family"
      ? "requires-family-capacity"
      : "requires-minimum-capacity";
  }
  if (segment.id === "family" && offer.bedType !== "twin") {
    return "requires-family-capacity";
  }
  const minimumArea = segment.hardRequirements.minimumAreaSquareMeters;
  if (minimumArea !== undefined && offer.areaSquareMeters < minimumArea) {
    return "requires-minimum-area";
  }
  const requiredBedTypes = segment.hardRequirements.requiredBedTypes;
  if (requiredBedTypes && !requiredBedTypes.includes(offer.bedType)) {
    return "requires-bed-type";
  }
  return null;
}

function factorComparator(a: RoomMatchFactor, b: RoomMatchFactor): number {
  return Math.abs(b.contributionBps) - Math.abs(a.contributionBps)
    || FACTOR_ORDER.indexOf(a.code) - FACTOR_ORDER.indexOf(b.code);
}

export function matchGuest(
  segment: Readonly<GuestSegment>,
  offer: Readonly<RoomOffer>,
): GuestMatch {
  const failure = hardFailure(segment, offer);
  const base = {
    segmentId: segment.id,
    offerId: offer.id,
  };
  if (failure) {
    return {
      ...base,
      eligible: false,
      hardFailure: failure,
      preferenceScoreBps: null,
      factors: [],
      topPositiveFactors: [],
      topNegativeFactors: [],
    };
  }

  const priceAttributeBps = clampBps(
    10_000 - Math.trunc((offer.nightlyRateCents * 10_000) / 200_000),
  );
  const priceWeight = Math.trunc(
    (segment.preferenceWeights.price * segment.priceSensitivityBps) / 10_000,
  );
  const unsortedFactors: RoomMatchFactor[] = [
    { code: "view-fit", contributionBps: centeredContribution(offer.viewBps, segment.preferenceWeights.view) },
    { code: "workspace-fit", contributionBps: centeredContribution(offer.workspaceBps, segment.preferenceWeights.workspace) },
    { code: "quiet-fit", contributionBps: centeredContribution(offer.quietBps, segment.preferenceWeights.quiet) },
    { code: "privacy-fit", contributionBps: centeredContribution(offer.privacyBps, segment.preferenceWeights.privacy) },
    { code: "design-fit", contributionBps: centeredContribution(offer.designAffinities[segment.id], segment.preferenceWeights.design) },
    { code: "price-fit", contributionBps: centeredContribution(priceAttributeBps, priceWeight) },
  ];
  const factors = unsortedFactors
    .filter(({ contributionBps }) => contributionBps !== 0)
    .sort(factorComparator);
  const preferenceScoreBps = clampBps(
    5_000 + factors.reduce((total, { contributionBps }) => total + contributionBps, 0),
  );

  return {
    ...base,
    eligible: true,
    hardFailure: null,
    preferenceScoreBps,
    factors,
    topPositiveFactors: factors.filter(({ contributionBps }) => contributionBps > 0).slice(0, 3),
    topNegativeFactors: factors.filter(({ contributionBps }) => contributionBps < 0).slice(0, 3),
  };
}
