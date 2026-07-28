import {
  assertStableId,
  type FlowEvent,
  type StableId,
} from "../building/buildingTypes";
import { FACILITY_CATALOG } from "../content/contentCatalog";
import {
  GUEST_SEGMENT_IDS,
  type DepartmentState,
  type DepartmentId,
  type GuestSegmentId,
} from "../operations/operationsTypes";
import { calculateServiceCapacity } from "../operations/serviceCapacity";
import type {
  FacilityDailyResult,
  FacilityPolicy,
  FacilitySignatureOffering,
  FacilityState,
  PublicSpaceBlueprint,
  PublicSpaceInstance,
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

export interface FacilitySettlementInput {
  day: number;
  seed: string;
  occupiedRooms: number;
  availableRooms: number;
  segmentMix: Partial<Record<GuestSegmentId, number>>;
  reputationBps: number;
  departments: Readonly<Record<DepartmentId, DepartmentState>>;
  facilities: Readonly<Record<string, FacilityState>>;
  publicSpaces: Readonly<Record<string, PublicSpaceInstance>>;
  blueprints: Readonly<Record<string, PublicSpaceBlueprint>>;
  maximumFlowEvents?: number;
}

export interface FacilitySettlementResultItem extends FacilityDailyResult {
  facilityId: StableId;
  residentVisits: number;
  nonResidentVisits: number;
}

export interface FacilitySettlementResult {
  publicSpaceRevenueCents: number;
  facilityOperatingCostCents: number;
  reputationDeltaBps: number;
  results: FacilitySettlementResultItem[];
  flowEvents: FlowEvent[];
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

function policyReasons(
  type: PublicSpaceType,
  policy: Readonly<FacilityPolicyInput>,
): string[] {
  const reasons: string[] = [];
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return ["设施运营策略结构无效"];
  }
  const definition = FACILITY_CATALOG.find((entry) => entry.type === type);
  const group = operationGroupFor(type);
  if (!definition) return ["设施类型未在目录中定义"];
  if (!group) return ["该设施不支持轻量运营配置"];
  const choices = projectOperatingChoices(group).filter(({ positioningId }) =>
    positioningId === policy.positioningId);
  if (choices.length === 0) reasons.push("设施定位未在运营目录中定义");
  if (!choices.some(({ priceBandId }) => priceBandId === policy.priceBandId)) {
    reasons.push("价格带与设施定位不兼容");
  }
  if (!choices.some(({ openingPolicyId }) => openingPolicyId === policy.openingPolicyId)) {
    reasons.push("营业时段与设施定位不兼容");
  }
  if (!Number.isSafeInteger(policy.capacity) ||
      policy.capacity < definition.defaultCapacity.minimum ||
      policy.capacity > definition.defaultCapacity.maximum) {
    reasons.push(`设施容量必须在 ${definition.defaultCapacity.minimum}-${definition.defaultCapacity.maximum} 之间`);
  }
  if (!Number.isSafeInteger(policy.serviceBudgetCents) || policy.serviceBudgetCents < 0) {
    reasons.push("服务预算必须是非负安全整数分");
  }
  if (policy.signatureOfferingId) {
    const offering = FACILITY_OFFERINGS.find(({ id: offeringId }) =>
      offeringId === policy.signatureOfferingId);
    if (!offering) reasons.push("招牌产品未在目录中定义");
    else if (!offering.facilityTypes.includes(type)) {
      reasons.push("招牌产品与设施类型不兼容");
    }
  }
  return reasons;
}

export function validateFacilityPolicy(
  type: PublicSpaceType,
  policy: Readonly<FacilityPolicyInput>,
): FacilityPolicyValidation {
  const reasons = policyReasons(type, policy);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function createFacilityPolicy(
  type: PublicSpaceType,
  input: Readonly<FacilityPolicyInput>,
): FacilityPolicy {
  const validation = validateFacilityPolicy(type, input);
  if (!validation.ok) throw new Error(validation.reasons.join("；"));
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
  return policy;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) throw new Error(`${label}超出安全整数范围`);
  return Number(value);
}

function assertSettlementInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label}必须是 0 到 ${maximum} 的安全整数`);
  }
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pricePerVisitCents(policy: Readonly<FacilityPolicy>): number {
  const priceBand = String(policy.priceBandId);
  if (priceBand.endsWith(":luxury")) return 32_000;
  if (priceBand.endsWith(":premium")) return 20_000;
  return 12_000;
}

function blueprintAppealBps(
  type: PublicSpaceType,
  blueprint: Readonly<PublicSpaceBlueprint>,
): number {
  const definition = FACILITY_CATALOG.find((entry) => entry.type === type);
  if (!definition) throw new Error("设施类型未在目录中定义");
  const itemAppeal = blueprint.placedItems.reduce((sum, item) => {
    const rule = definition.itemRules.find(({ id: itemId }) => itemId === item.catalogItemId);
    return sum + BigInt(rule?.appealBps ?? 0);
  }, 0n);
  const value = BigInt(definition.metrics.baseAppealBps)
    + BigInt(blueprint.cells.length) * BigInt(definition.metrics.appealPerCellBps)
    + itemAppeal;
  return Number(value > 10_000n ? 10_000n : value);
}

function blueprintCapacity(
  type: PublicSpaceType,
  blueprint: Readonly<PublicSpaceBlueprint>,
): number {
  const definition = FACILITY_CATALOG.find((entry) => entry.type === type);
  if (!definition) throw new Error("设施类型未在目录中定义");
  const value = blueprint.placedItems.reduce((sum, item) => {
    const rule = definition.itemRules.find(({ id: itemId }) => itemId === item.catalogItemId);
    return sum + BigInt(rule?.capacity ?? 0);
  }, 0n);
  return safeNumber(
    value > BigInt(definition.defaultCapacity.maximum)
      ? BigInt(definition.defaultCapacity.maximum)
      : value,
    "设施设计容量",
  );
}

function configuredResult(
  input: Readonly<FacilitySettlementInput>,
  facility: Readonly<FacilityState>,
  blueprint: Readonly<PublicSpaceBlueprint>,
): FacilitySettlementResultItem {
  const policy = facility.policy!;
  const appealBps = blueprintAppealBps(facility.type, blueprint);
  const capacity = Math.min(policy.capacity, blueprintCapacity(facility.type, blueprint));
  const weightedDemand = GUEST_SEGMENT_IDS.reduce((sum, segmentId) => {
    const segment = facility.segmentInputs[segmentId];
    const mixBps = input.segmentMix[segmentId] ?? 0;
    return sum + BigInt(segment.dailyDemand) * BigInt(segment.appealBps) * BigInt(mixBps);
  }, 0n);
  const residentVisits = safeNumber(
    BigInt(input.occupiedRooms) * weightedDemand / 1_000_000_000_000n,
    "住店设施需求",
  );
  const dayVariation = stableHash(`${input.seed}:${input.day}:${facility.id}`) % 7;
  const nonResidentVisits = Math.trunc(
    (appealBps + input.reputationBps + dayVariation * 100) / 1_500,
  );
  const service = calculateServiceCapacity(input.departments, {
    occupiedRooms: input.occupiedRooms,
    availableRooms: input.availableRooms,
  });
  const serviceCapacity = service.overallBps === 0
    ? 0
    : Math.trunc((capacity * service.overallBps + 9_999) / 10_000);
  const visits = Math.min(capacity, serviceCapacity, residentVisits + nonResidentVisits);
  const selectedOffering = policy.signatureOfferingId === undefined
    ? undefined
    : FACILITY_OFFERINGS.find(({ id: offeringId }) => offeringId === policy.signatureOfferingId);
  const unitCostCents = selectedOffering?.unitCostCents ?? Math.trunc(pricePerVisitCents(policy) / 4);
  const revenueCents = safeNumber(BigInt(visits) * BigInt(pricePerVisitCents(policy)), "设施收入");
  const operatingCostCents = safeNumber(
    BigInt(policy.serviceBudgetCents) + BigInt(visits) * BigInt(unitCostCents),
    "设施经营成本",
  );
  const utilizationBps = capacity === 0
    ? 0
    : Math.trunc((visits * 10_000) / capacity);
  const satisfactionDeltaBps = Math.max(-200, Math.min(200,
    Math.trunc((appealBps + service.overallBps - 10_000) / 50),
  ));
  const appealDeltaBps = Math.max(-200, Math.min(200,
    Math.trunc((appealBps - 5_000) / 25) + (selectedOffering?.reputationBps ?? 0),
  ));
  const reasonCodes: StableId[] = [];
  if (visits === capacity && capacity > 0) reasonCodes.push(id("facility:capacity-full"));
  if (serviceCapacity < capacity) reasonCodes.push(id("facility:service-limited"));
  if (visits === 0) reasonCodes.push(id("facility:no-demand"));
  return {
    facilityId: facility.id,
    day: input.day,
    visits,
    residentVisits: Math.min(visits, residentVisits),
    nonResidentVisits: Math.max(0, visits - Math.min(visits, residentVisits)),
    revenueCents,
    operatingCostCents,
    utilizationBps,
    satisfactionDeltaBps,
    appealDeltaBps,
    reasonCodes,
  };
}

function boostResult(
  input: Readonly<FacilitySettlementInput>,
  facility: Readonly<FacilityState>,
  blueprint: Readonly<PublicSpaceBlueprint>,
): FacilitySettlementResultItem {
  const capacity = blueprintCapacity(facility.type, blueprint);
  const appealBps = blueprintAppealBps(facility.type, blueprint);
  const service = calculateServiceCapacity(input.departments, {
    occupiedRooms: input.occupiedRooms,
    availableRooms: input.availableRooms,
  });
  const demand = GUEST_SEGMENT_IDS.reduce((sum, segmentId) => {
    const segment = facility.segmentInputs[segmentId];
    const mixBps = input.segmentMix[segmentId] ?? 0;
    return sum + BigInt(segment.dailyDemand) * BigInt(mixBps);
  }, 0n);
  const residentDemand = safeNumber(
    BigInt(input.occupiedRooms) * demand / 100_000_000n,
    "住店设施需求",
  );
  const visits = Math.min(
    capacity,
    Math.trunc((capacity * service.overallBps + 9_999) / 10_000),
    residentDemand,
  );
  const satisfactionDeltaBps = Math.max(-200, Math.min(200,
    Math.trunc((appealBps + service.overallBps - 10_000) / 50),
  ));
  const reasonCodes: StableId[] = [];
  if (capacity === 0) reasonCodes.push(id("facility:no-design-capacity"));
  if (visits === 0 && capacity > 0) reasonCodes.push(id("facility:no-demand"));
  return {
    facilityId: facility.id,
    day: input.day,
    visits,
    residentVisits: visits,
    nonResidentVisits: 0,
    revenueCents: 0,
    operatingCostCents: facility.dailyOperatingCostCents,
    utilizationBps: capacity === 0 ? 0 : Math.trunc((visits * 10_000) / capacity),
    satisfactionDeltaBps,
    appealDeltaBps: Math.max(-200, Math.min(200, Math.trunc((appealBps - 5_000) / 25))),
    reasonCodes,
  };
}

export function settleFacilityOperations(
  input: Readonly<FacilitySettlementInput>,
): FacilitySettlementResult {
  assertSettlementInteger(input.day, "营业日");
  if (input.day === 0) throw new Error("营业日必须是正安全整数");
  if (typeof input.seed !== "string" || input.seed.length === 0) throw new Error("设施结算种子不能为空");
  assertSettlementInteger(input.occupiedRooms, "已入住客房");
  assertSettlementInteger(input.availableRooms, "可售客房");
  if (input.occupiedRooms > input.availableRooms) throw new Error("已入住客房不能超过可售客房");
  assertSettlementInteger(input.reputationBps, "声誉", 10_000);
  const maximumFlowEvents = input.maximumFlowEvents ?? 150;
  assertSettlementInteger(maximumFlowEvents, "流事件上限", 150);
  for (const segmentId of GUEST_SEGMENT_IDS) {
    assertSettlementInteger(input.segmentMix[segmentId] ?? 0, "住客分群比例", 10_000);
  }

  const results: FacilitySettlementResultItem[] = [];
  for (const facility of Object.values(input.facilities)
    .filter(({ enabled }) => enabled)
    .sort((left, right) => compareCodeUnits(left.id, right.id))) {
    if (facility.status !== "operating") continue;
    const instance = input.publicSpaces[facility.publicSpaceInstanceId];
    if (!instance || instance.type !== facility.type) throw new Error(`设施 ${facility.id} 引用了未知公共空间`);
    const blueprint = input.blueprints[instance.blueprintId];
    if (!blueprint || blueprint.type !== facility.type) throw new Error(`设施 ${facility.id} 引用了未知公共空间蓝图`);
    const group = operationGroupFor(facility.type);
    if (group === null) {
      results.push(boostResult(input, facility, blueprint));
      continue;
    }
    if (facility.policy === null) {
      results.push({
        facilityId: facility.id,
        day: input.day,
        visits: 0,
        residentVisits: 0,
        nonResidentVisits: 0,
        revenueCents: 0,
        operatingCostCents: 0,
        utilizationBps: 0,
        satisfactionDeltaBps: 0,
        appealDeltaBps: 0,
        reasonCodes: [id("facility:unconfigured")],
      });
      continue;
    }
    const validation = validateFacilityPolicy(facility.type, facility.policy);
    if (!validation.ok || (facility.policy.signatureOfferingId !== undefined
      && !facility.developedOfferingIds.includes(facility.policy.signatureOfferingId))) {
      results.push({
        facilityId: facility.id,
        day: input.day,
        visits: 0,
        residentVisits: 0,
        nonResidentVisits: 0,
        revenueCents: 0,
        operatingCostCents: 0,
        utilizationBps: 0,
        satisfactionDeltaBps: 0,
        appealDeltaBps: 0,
        reasonCodes: [id("facility:invalid-policy")],
      });
      continue;
    }
    results.push(configuredResult(input, facility, blueprint));
  }
  const publicSpaceRevenueCents = safeNumber(
    results.reduce((sum, result) => sum + BigInt(result.revenueCents), 0n),
    "公共空间收入",
  );
  const facilityOperatingCostCents = safeNumber(
    results.reduce((sum, result) => sum + BigInt(result.operatingCostCents), 0n),
    "设施经营成本",
  );
  const reputationDeltaBps = results.length === 0
    ? 0
    : Math.max(-200, Math.min(200, Math.trunc(
        results.reduce((sum, result) => sum + result.satisfactionDeltaBps + result.appealDeltaBps, 0)
          / results.length,
      )));
  const flowEvents = results
    .filter(({ visits }) => visits > 0)
    .map((result, index): FlowEvent => ({
      id: id(`flow:facility:${String(input.day).padStart(2, "0")}:${String(index + 1).padStart(3, "0")}`),
      kind: "guest",
      fromId: id("flow:hotel-residents"),
      toId: input.facilities[result.facilityId].publicSpaceInstanceId,
      count: result.visits,
    }))
    .slice(0, maximumFlowEvents);
  return {
    publicSpaceRevenueCents,
    facilityOperatingCostCents,
    reputationDeltaBps,
    results,
    flowEvents,
  };
}
