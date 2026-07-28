import { assertStableId, type StableId } from "../building/buildingTypes";
import { FACILITY_CATALOG } from "../content/contentCatalog";
import {
  GUEST_SEGMENT_IDS,
  type GuestSegmentId,
} from "../operations/operationsTypes";
import { assertSafeMoney } from "../primitives";
import type {
  FacilityPolicy,
  FacilitySignatureOffering,
  PublicSpaceType,
} from "./facilityTypes";

export type LightOperationGroup = "dining" | "bar" | "spa" | "banquet";

export interface FacilityOperatingChoice {
  id: StableId;
  group: LightOperationGroup;
  positioningId: StableId;
  priceBandId: StableId;
  openingPolicyId: StableId;
}

export interface FacilityMenuStructure {
  id: StableId;
  facilityTypes: readonly PublicSpaceType[];
  name: string;
}

export interface CatalogFacilityOffering extends FacilitySignatureOffering {
  facilityTypes: readonly PublicSpaceType[];
  name: string;
}

export type FacilityPolicyValidation =
  | { ok: true }
  | { ok: false; reasons: string[] };

export interface FacilityPolicyInput {
  positioningId: string;
  priceBandId: string;
  capacity: number;
  openingPolicyId: string;
  serviceBudgetCents: number;
  signatureOfferingId?: string;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const id = (value: string) => assertStableId(value);

function choice(
  group: LightOperationGroup,
  suffix: string,
  positioning: string,
  priceBand: string,
  openingPolicy: string,
): FacilityOperatingChoice {
  return {
    id: id(`operation-choice:${group}:${suffix}`),
    group,
    positioningId: id(`positioning:${positioning}`),
    priceBandId: id(`price-band:${priceBand}`),
    openingPolicyId: id(`opening-policy:${openingPolicy}`),
  };
}

export const FACILITY_OPERATING_CHOICES: readonly Readonly<FacilityOperatingChoice>[] = deepFreeze([
  choice("dining", "international", "international-luxury", "premium", "breakfast-dinner"),
  choice("dining", "local", "local-contemporary", "upper-midscale", "all-day"),
  choice("dining", "destination", "destination-dining", "luxury", "dinner-only"),
  choice("bar", "cocktail", "craft-cocktail", "premium", "evening"),
  choice("bar", "social", "social-lounge", "upper-midscale", "afternoon-late"),
  choice("bar", "skyline", "skyline-luxury", "luxury", "sunset-late"),
  choice("spa", "restorative", "restorative-wellness", "premium", "appointment-daily"),
  choice("spa", "clinical", "clinical-wellness", "luxury", "appointment-extended"),
  choice("spa", "express", "express-wellness", "upper-midscale", "daytime"),
  choice("banquet", "corporate", "corporate-events", "premium", "booked-events"),
  choice("banquet", "celebration", "celebration-luxury", "luxury", "booked-events"),
  choice("banquet", "flexible", "flexible-events", "upper-midscale", "day-evening"),
] as const);

const menu = (
  menuId: string,
  name: string,
  facilityTypes: readonly PublicSpaceType[],
): FacilityMenuStructure => ({ id: id(menuId), name, facilityTypes });

export const MENU_STRUCTURES: readonly Readonly<FacilityMenuStructure>[] = deepFreeze([
  menu("menu:all-day-balanced", "Balanced all-day menu", ["all-day-dining"]),
  menu("menu:all-day-seasonal", "Seasonal all-day menu", ["all-day-dining"]),
  menu("menu:all-day-chef-led", "Chef-led all-day menu", ["all-day-dining"]),
  menu("menu:chinese-regional", "Regional Chinese menu", ["chinese-restaurant"]),
  menu("menu:chinese-banquet", "Chinese banquet menu", ["chinese-restaurant"]),
  menu("menu:chinese-modern", "Modern Chinese menu", ["chinese-restaurant"]),
  menu("menu:bar-classics", "Cocktail classics", ["bar"]),
  menu("menu:bar-seasonal", "Seasonal cocktail list", ["bar"]),
  menu("menu:bar-zero-proof", "Cocktail and zero-proof list", ["bar"]),
] as const);

function appeals(primary: GuestSegmentId, secondary: GuestSegmentId): Record<GuestSegmentId, number> {
  return Object.fromEntries(GUEST_SEGMENT_IDS.map((segmentId) => [
    segmentId,
    segmentId === primary ? 900 : segmentId === secondary ? 600 : 250,
  ])) as Record<GuestSegmentId, number>;
}

function offering(
  offeringId: string,
  kind: FacilitySignatureOffering["kind"],
  name: string,
  facilityTypes: readonly PublicSpaceType[],
  developmentCostCents: number,
  unitCostCents: number,
  primary: GuestSegmentId,
  secondary: GuestSegmentId,
): CatalogFacilityOffering {
  return {
    id: id(offeringId), kind, name, facilityTypes,
    developmentCostCents, unitCostCents,
    segmentAppealBps: appeals(primary, secondary),
    reputationBps: 250,
  };
}

export const FACILITY_OFFERINGS: readonly Readonly<CatalogFacilityOffering>[] = deepFreeze([
  offering("dish:tea-smoked-duck", "dish", "Tea-smoked duck", ["all-day-dining", "chinese-restaurant"], 600_000, 8_500, "cultural-experience", "high-net-worth"),
  offering("dish:cloud-breakfast", "dish", "Cloud breakfast", ["all-day-dining"], 420_000, 4_800, "business", "family"),
  offering("dish:harbor-seafood", "dish", "Harbor seafood", ["all-day-dining"], 520_000, 7_200, "couple", "leisure"),
  offering("dish:crystal-shrimp", "dish", "Crystal shrimp", ["chinese-restaurant"], 560_000, 8_000, "cultural-experience", "business"),
  offering("dish:mountain-broth", "dish", "Mountain broth", ["chinese-restaurant"], 480_000, 6_500, "family", "high-net-worth"),
  offering("drink:cloud-negroni", "drink", "Cloud Negroni", ["bar"], 360_000, 3_600, "couple", "high-net-worth"),
  offering("drink:tea-spritz", "drink", "Tea spritz", ["bar"], 300_000, 2_800, "cultural-experience", "leisure"),
  offering("drink:night-orchard", "drink", "Night orchard", ["bar"], 320_000, 3_000, "business", "couple"),
  offering("service:cloud-restoration", "service-package", "Cloud restoration", ["spa"], 500_000, 12_000, "leisure", "high-net-worth"),
  offering("service:express-recovery", "service-package", "Express recovery", ["spa"], 380_000, 8_000, "business", "leisure"),
  offering("service:couples-ritual", "service-package", "Couples ritual", ["spa"], 540_000, 15_000, "couple", "high-net-worth"),
  offering("service:cloud-wedding", "service-package", "Cloud wedding", ["ballroom", "meeting-room"], 700_000, 18_000, "couple", "family"),
  offering("service:executive-summit", "service-package", "Executive summit", ["ballroom", "meeting-room"], 620_000, 14_000, "business", "high-net-worth"),
  offering("service:cultural-gala", "service-package", "Cultural gala", ["ballroom", "meeting-room"], 680_000, 17_000, "cultural-experience", "leisure"),
] as const);

export function projectOperatingChoices(group: LightOperationGroup): readonly Readonly<FacilityOperatingChoice>[] {
  return FACILITY_OPERATING_CHOICES.filter((entry) => entry.group === group);
}

export function projectMenuStructures(type: PublicSpaceType): readonly Readonly<FacilityMenuStructure>[] {
  return MENU_STRUCTURES.filter(({ facilityTypes }) => facilityTypes.includes(type));
}

export function projectFacilityOfferings(type: PublicSpaceType): readonly Readonly<CatalogFacilityOffering>[] {
  return FACILITY_OFFERINGS.filter(({ facilityTypes }) => facilityTypes.includes(type));
}

export function operationGroupFor(type: PublicSpaceType): LightOperationGroup | null {
  const group = FACILITY_CATALOG.find((entry) => entry.type === type)?.operationGroup;
  return group && group !== "boost" ? group : null;
}

function policyReasons(policy: Readonly<FacilityPolicy>): string[] {
  const reasons: string[] = [];
  const choices = FACILITY_OPERATING_CHOICES.filter(({ positioningId }) =>
    positioningId === policy.positioningId);
  if (choices.length === 0) reasons.push("设施定位未在运营目录中定义");
  if (!choices.some(({ priceBandId }) => priceBandId === policy.priceBandId)) {
    reasons.push("价格带与设施定位不兼容");
  }
  if (!choices.some(({ openingPolicyId }) => openingPolicyId === policy.openingPolicyId)) {
    reasons.push("营业时段与设施定位不兼容");
  }
  if (!Number.isSafeInteger(policy.capacity) || policy.capacity <= 0) {
    reasons.push("设施容量必须是正安全整数");
  }
  if (!Number.isSafeInteger(policy.serviceBudgetCents) || policy.serviceBudgetCents < 0) {
    reasons.push("服务预算必须是非负安全整数分");
  }
  if (policy.signatureOfferingId && !FACILITY_OFFERINGS.some(({ id: offeringId }) =>
    offeringId === policy.signatureOfferingId)) {
    reasons.push("招牌产品未在目录中定义");
  }
  return reasons;
}

export function validateFacilityPolicy(policy: Readonly<FacilityPolicy>): FacilityPolicyValidation {
  const reasons = policyReasons(policy);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function createFacilityPolicy(
  type: PublicSpaceType,
  input: Readonly<FacilityPolicyInput>,
): FacilityPolicy {
  const definition = FACILITY_CATALOG.find((entry) => entry.type === type);
  if (!definition) throw new Error("设施类型未在目录中定义");
  const group = operationGroupFor(type);
  if (!group) throw new Error("该设施不支持轻量运营配置");
  const choice = projectOperatingChoices(group).find(({ positioningId }) =>
    positioningId === input.positioningId);
  if (!choice || choice.priceBandId !== input.priceBandId ||
      choice.openingPolicyId !== input.openingPolicyId) {
    throw new Error("设施定位、价格带或营业时段不兼容");
  }
  if (!Number.isSafeInteger(input.capacity) ||
      input.capacity < definition.defaultCapacity.minimum ||
      input.capacity > definition.defaultCapacity.maximum) {
    throw new Error(`设施容量必须在 ${definition.defaultCapacity.minimum}-${definition.defaultCapacity.maximum} 之间`);
  }
  assertSafeMoney(input.serviceBudgetCents);
  if (input.signatureOfferingId && !projectFacilityOfferings(type).some(
    ({ id: offeringId }) => offeringId === input.signatureOfferingId,
  )) throw new Error("招牌产品与设施类型不兼容");
  const policy: FacilityPolicy = {
    positioningId: id(input.positioningId),
    priceBandId: id(input.priceBandId),
    capacity: input.capacity,
    openingPolicyId: id(input.openingPolicyId),
    serviceBudgetCents: input.serviceBudgetCents,
    ...(input.signatureOfferingId
      ? { signatureOfferingId: id(input.signatureOfferingId) }
      : {}),
  };
  const validation = validateFacilityPolicy(policy);
  if (!validation.ok) throw new Error(validation.reasons.join("；"));
  return policy;
}
