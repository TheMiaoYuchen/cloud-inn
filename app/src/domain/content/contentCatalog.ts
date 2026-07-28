import { assertStableId, type StableId } from "../building/buildingTypes";
import type { PublicSpaceType } from "../facilities/facilityTypes";
import { GUEST_SEGMENT_IDS, type DiscoveredMarketNeed, type GuestSegmentId } from "../operations/operationsTypes";
import { REPUTATION_UNLOCKS } from "../operations/unlocks";
import { assertSafeMoney } from "../primitives";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const CONTENT_PROGRESS_SOURCES = deepFreeze([
  "reputation",
  "discovered-need",
  "built-facility",
  "completed-content-choice",
] as const);

export type ContentProgressSource = (typeof CONTENT_PROGRESS_SOURCES)[number];

export type ContentUnlockPrerequisite =
  | { source: "reputation"; thresholdBps: number }
  | {
      source: "discovered-need";
      segmentId: GuestSegmentId;
      kind: DiscoveredMarketNeed["kind"];
    }
  | { source: "built-facility"; facilityType: PublicSpaceType }
  | { source: "completed-content-choice"; id: StableId };

export const SPACE_VALIDATION_STRATEGIES = deepFreeze([
  "lobby",
  "dining",
  "bar",
  "pool",
  "spa",
  "ballroom",
  "meeting",
  "general",
] as const);

export type SpaceValidationStrategy = (typeof SPACE_VALIDATION_STRATEGIES)[number];

export interface SpaceItemRule {
  id: StableId;
  allowedZoneIds: readonly StableId[];
  capacity: number;
  appealBps: number;
  role: "guest" | "service" | "feature";
}

export interface SpaceMetricRules {
  constructionCellCostCents: number;
  constructionItemCostCents: number;
  baseAppealBps: number;
  appealPerCellBps: number;
  basePrivacyBps: number;
  quietZonePrivacyBps: number;
  serviceDistanceAdvisoryMaximum: number;
}

export interface SpaceTypeDefinition {
  id: StableId;
  type: PublicSpaceType;
  name: string;
  category: "arrival" | "food-and-beverage" | "wellness" | "events" | "leisure" | "retail";
  displayOrder: number;
  constructionCostCents: { minimum: number; maximum: number };
  operatingMode: "boost" | "light-operation";
  operationGroup: "boost" | "dining" | "bar" | "spa" | "banquet";
  strategy: SpaceValidationStrategy;
  allowedZoneIds: readonly StableId[];
  requiredZoneIds: readonly StableId[];
  permittedItemIds: readonly StableId[];
  requiredItemIds: readonly StableId[];
  itemRules: readonly Readonly<SpaceItemRule>[];
  metrics: Readonly<SpaceMetricRules>;
  defaultCapacity: { minimum: number; maximum: number };
  unlockRule: { all: readonly ContentUnlockPrerequisite[] };
}

export type FacilityCatalogEntry = SpaceTypeDefinition;

export interface TowerCatalogEntry {
  id: StableId;
  name: string;
  minimumFloorNumber: number;
  maximumFloorNumber: number;
  entranceFloorNumber: number;
  skyLobbyFloorNumber: number;
  serviceFloorNumber: number;
  guestTemplateId: StableId;
}

export interface FloorTemplateCatalogEntry {
  id: StableId;
  name: string;
  use: "guest";
  slotsPerSide: number;
  roomAreaSquareMeters: number;
}

interface CatalogReference {
  id: StableId;
  name: string;
}

const id = (value: string) => assertStableId(value);

export const ZONE_CATALOG: readonly Readonly<CatalogReference>[] = deepFreeze([
  { id: id("zone:arrival"), name: "Arrival" },
  { id: id("zone:seating"), name: "Seating" },
  { id: id("zone:kitchen"), name: "Kitchen or preparation" },
  { id: id("zone:bar-service"), name: "Bar service" },
  { id: id("zone:quiet"), name: "Quiet guest area" },
  { id: id("zone:wet"), name: "Wet area" },
  { id: id("zone:fitness"), name: "Fitness" },
  { id: id("zone:event"), name: "Event" },
  { id: id("zone:back-of-house"), name: "Back of house" },
  { id: id("zone:terrace"), name: "Terrace" },
  { id: id("zone:retail"), name: "Retail" },
  { id: id("zone:deck"), name: "Pool deck" },
  { id: id("zone:service-route"), name: "Service route" },
  { id: id("zone:entrance"), name: "Entrance" },
  { id: id("zone:reception"), name: "Reception" },
  { id: id("zone:waiting"), name: "Waiting" },
  { id: id("zone:luggage"), name: "Luggage" },
  { id: id("zone:elevator-lobby"), name: "Elevator lobby" },
  { id: id("zone:treatment"), name: "Treatment" },
  { id: id("zone:wet-route"), name: "Wet route" },
  { id: id("zone:stage"), name: "Stage" },
  { id: id("zone:meeting-setup"), name: "Meeting setup" },
  { id: id("zone:partition"), name: "Partition" },
] as const);

export const ITEM_CATALOG: readonly Readonly<CatalogReference>[] = deepFreeze([
  { id: id("item:reception-desk"), name: "Reception desk" },
  { id: id("item:lounge-seat"), name: "Lounge seat" },
  { id: id("item:dining-table"), name: "Dining table" },
  { id: id("item:service-counter"), name: "Service counter" },
  { id: id("item:bar-counter"), name: "Bar counter" },
  { id: id("item:treatment-bed"), name: "Treatment bed" },
  { id: id("item:pool"), name: "Pool" },
  { id: id("item:fitness-station"), name: "Fitness station" },
  { id: id("item:event-table"), name: "Event table" },
  { id: id("item:meeting-table"), name: "Meeting table" },
  { id: id("item:planter"), name: "Planter" },
  { id: id("item:display-case"), name: "Display case" },
] as const);

const reputation = (thresholdBps: number): ContentUnlockPrerequisite => ({
  source: "reputation",
  thresholdBps,
});
const need = (
  segmentId: GuestSegmentId,
  kind: DiscoveredMarketNeed["kind"],
): ContentUnlockPrerequisite => ({
  source: "discovered-need",
  segmentId,
  kind,
});
const built = (facilityType: PublicSpaceType): ContentUnlockPrerequisite => ({
  source: "built-facility",
  facilityType,
});
const choice = (choiceId: string): ContentUnlockPrerequisite => ({
  source: "completed-content-choice",
  id: id(choiceId),
});

const facility = (
  type: PublicSpaceType,
  name: string,
  category: FacilityCatalogEntry["category"],
  displayOrder: number,
  cost: readonly [number, number],
  capacity: readonly [number, number],
  operationGroup: FacilityCatalogEntry["operationGroup"],
  strategy: SpaceValidationStrategy,
  allowedZones: readonly string[],
  requiredZones: readonly string[],
  items: readonly (readonly [string, number, number, SpaceItemRule["role"], readonly string[]])[],
  requiredItems: readonly string[],
  metrics: SpaceMetricRules,
  prerequisites: readonly ContentUnlockPrerequisite[],
): Readonly<FacilityCatalogEntry> => ({
  id: id(`facility:${type}`),
  type,
  name,
  category,
  displayOrder,
  constructionCostCents: { minimum: cost[0], maximum: cost[1] },
  operatingMode: operationGroup === "boost" ? "boost" : "light-operation",
  operationGroup,
  strategy,
  allowedZoneIds: allowedZones.map(id),
  requiredZoneIds: requiredZones.map(id),
  permittedItemIds: items.map(([itemId]) => id(itemId)),
  requiredItemIds: requiredItems.map(id),
  itemRules: items.map(([itemId, itemCapacity, appealBps, role, itemAllowedZones]) => ({
    id: id(itemId),
    allowedZoneIds: itemAllowedZones.map(id),
    capacity: itemCapacity,
    appealBps,
    role,
  })),
  metrics,
  defaultCapacity: { minimum: capacity[0], maximum: capacity[1] },
  unlockRule: { all: prerequisites },
});

const metricRules = (
  constructionCellCostCents: number,
  constructionItemCostCents: number,
  baseAppealBps: number,
  appealPerCellBps: number,
  basePrivacyBps: number,
  quietZonePrivacyBps: number,
  serviceDistanceAdvisoryMaximum: number,
): SpaceMetricRules => ({
  constructionCellCostCents,
  constructionItemCostCents,
  baseAppealBps,
  appealPerCellBps,
  basePrivacyBps,
  quietZonePrivacyBps,
  serviceDistanceAdvisoryMaximum,
});

export const FACILITY_CATALOG: readonly Readonly<FacilityCatalogEntry>[] = deepFreeze([
  facility("sky-lobby", "Sky Lobby", "arrival", 0, [3_000_000, 9_000_000], [20, 120], "boost", "lobby", ["zone:arrival", "zone:entrance", "zone:reception", "zone:waiting", "zone:luggage", "zone:elevator-lobby", "zone:service-route"], ["zone:arrival", "zone:entrance", "zone:reception", "zone:waiting", "zone:luggage", "zone:elevator-lobby"], [["item:reception-desk", 0, 350, "service", ["zone:reception"]], ["item:lounge-seat", 4, 200, "guest", ["zone:waiting"]]], ["item:reception-desk", "item:lounge-seat"], metricRules(12_000, 60_000, 4_500, 4, 6_000, 10, 12), [reputation(0)]),
  facility("all-day-dining", "All-Day Dining", "food-and-beverage", 1, [5_000_000, 18_000_000], [30, 180], "dining", "dining", ["zone:seating", "zone:kitchen", "zone:service-route", "zone:back-of-house"], ["zone:seating", "zone:kitchen", "zone:service-route"], [["item:dining-table", 4, 180, "guest", ["zone:seating"]], ["item:service-counter", 0, 220, "service", ["zone:kitchen", "zone:back-of-house"]]], ["item:dining-table", "item:service-counter"], metricRules(16_000, 90_000, 4_000, 5, 4_500, 5, 10), [reputation(0)]),
  facility("chinese-restaurant", "Chinese Restaurant", "food-and-beverage", 2, [7_000_000, 24_000_000], [24, 160], "dining", "dining", ["zone:seating", "zone:kitchen", "zone:service-route", "zone:back-of-house"], ["zone:seating", "zone:kitchen", "zone:service-route"], [["item:dining-table", 4, 220, "guest", ["zone:seating"]], ["item:service-counter", 0, 240, "service", ["zone:kitchen", "zone:back-of-house"]]], ["item:dining-table", "item:service-counter"], metricRules(18_000, 110_000, 4_300, 5, 4_800, 5, 10), [reputation(6_000)]),
  facility("bar", "Bar", "food-and-beverage", 3, [3_500_000, 14_000_000], [16, 100], "bar", "bar", ["zone:seating", "zone:bar-service", "zone:service-route"], ["zone:seating", "zone:bar-service", "zone:service-route"], [["item:lounge-seat", 2, 220, "guest", ["zone:seating"]], ["item:bar-counter", 0, 300, "service", ["zone:bar-service"]]], ["item:lounge-seat", "item:bar-counter"], metricRules(14_000, 85_000, 4_400, 4, 4_000, 4, 8), [reputation(5_500)]),
  facility("executive-lounge", "Executive Lounge", "arrival", 4, [4_000_000, 12_000_000], [16, 80], "boost", "general", ["zone:quiet", "zone:seating", "zone:service-route"], ["zone:quiet"], [["item:lounge-seat", 4, 260, "guest", ["zone:quiet", "zone:seating"]], ["item:service-counter", 0, 220, "service", ["zone:quiet"]]], ["item:lounge-seat", "item:service-counter"], metricRules(14_000, 75_000, 4_800, 4, 7_000, 12, 10), [reputation(6_500)]),
  facility("spa", "Spa", "wellness", 5, [6_000_000, 20_000_000], [4, 36], "spa", "spa", ["zone:reception", "zone:treatment", "zone:wet", "zone:quiet", "zone:wet-route"], ["zone:reception", "zone:treatment", "zone:wet", "zone:quiet"], [["item:reception-desk", 0, 180, "service", ["zone:reception"]], ["item:treatment-bed", 2, 320, "guest", ["zone:treatment"]]], ["item:reception-desk", "item:treatment-bed"], metricRules(20_000, 130_000, 5_000, 5, 6_000, 18, 10), [reputation(7_500), need("leisure", "room-feature")]),
  facility("pool", "Pool", "wellness", 6, [9_000_000, 30_000_000], [12, 100], "boost", "pool", ["zone:wet", "zone:deck", "zone:wet-route"], ["zone:wet", "zone:deck", "zone:wet-route"], [["item:pool", 12, 500, "feature", ["zone:wet"]], ["item:lounge-seat", 4, 180, "guest", ["zone:deck"]]], ["item:pool"], metricRules(24_000, 160_000, 5_200, 6, 4_000, 4, 12), [reputation(7_000)]),
  facility("gym", "Gym", "wellness", 7, [3_000_000, 11_000_000], [8, 60], "boost", "general", ["zone:fitness"], ["zone:fitness"], [["item:fitness-station", 2, 240, "feature", ["zone:fitness"]]], ["item:fitness-station"], metricRules(13_000, 95_000, 4_200, 4, 4_000, 3, 0), [reputation(5_000)]),
  facility("ballroom", "Ballroom", "events", 8, [12_000_000, 40_000_000], [80, 500], "banquet", "ballroom", ["zone:event", "zone:back-of-house", "zone:stage", "zone:partition", "zone:service-route"], ["zone:event", "zone:back-of-house", "zone:stage", "zone:partition", "zone:service-route"], [["item:event-table", 10, 180, "guest", ["zone:event"]], ["item:service-counter", 0, 160, "service", ["zone:back-of-house"]]], ["item:event-table", "item:service-counter"], metricRules(22_000, 120_000, 4_600, 5, 3_500, 3, 14), [reputation(7_000), built("all-day-dining")]),
  facility("meeting-room", "Meeting Room", "events", 9, [2_500_000, 10_000_000], [6, 80], "banquet", "meeting", ["zone:event", "zone:back-of-house", "zone:meeting-setup", "zone:partition", "zone:service-route"], ["zone:event", "zone:back-of-house", "zone:meeting-setup", "zone:partition"], [["item:meeting-table", 8, 240, "guest", ["zone:event", "zone:meeting-setup"]]], ["item:meeting-table"], metricRules(12_000, 70_000, 4_300, 4, 5_000, 5, 8), [reputation(6_000)]),
  facility("garden-terrace", "Garden Terrace", "leisure", 10, [3_000_000, 12_000_000], [12, 120], "boost", "general", ["zone:terrace"], ["zone:terrace"], [["item:planter", 0, 300, "feature", ["zone:terrace"]], ["item:lounge-seat", 4, 240, "guest", ["zone:terrace"]]], ["item:planter", "item:lounge-seat"], metricRules(14_000, 80_000, 5_000, 5, 3_000, 2, 0), [choice("operations:premium-segments")]),
  facility("boutique", "Boutique", "retail", 11, [2_000_000, 8_000_000], [4, 30], "boost", "general", ["zone:retail"], ["zone:retail"], [["item:display-case", 4, 260, "guest", ["zone:retail"]]], ["item:display-case"], metricRules(11_000, 65_000, 4_500, 4, 4_500, 3, 0), [reputation(7_500), built("sky-lobby")]),
] as const);

export const APPROVED_PUBLIC_SPACE_TYPES: readonly StableId[] = deepFreeze([
  id("facility:sky-lobby"),
  id("facility:all-day-dining"),
  id("facility:chinese-restaurant"),
  id("facility:bar"),
  id("facility:executive-lounge"),
  id("facility:spa"),
  id("facility:pool"),
  id("facility:gym"),
  id("facility:ballroom"),
  id("facility:meeting-room"),
  id("facility:garden-terrace"),
  id("facility:boutique"),
]);

export const FLOOR_TEMPLATE_CATALOG: readonly Readonly<FloorTemplateCatalogEntry>[] = deepFreeze([
  {
    id: id("template:guest:dense-ring"),
    name: "Dense Ring Guest Floor",
    use: "guest",
    slotsPerSide: 8,
    roomAreaSquareMeters: 24,
  },
] as const);

export const TOWER_CATALOG: readonly Readonly<TowerCatalogEntry>[] = deepFreeze([
  {
    id: id("building-template:first-tower"),
    name: "Cloud Inn First Tower",
    minimumFloorNumber: 1,
    maximumFloorNumber: 64,
    entranceFloorNumber: 1,
    skyLobbyFloorNumber: 2,
    serviceFloorNumber: 3,
    guestTemplateId: FLOOR_TEMPLATE_CATALOG[0].id,
  },
] as const);

function validateReferenceCatalog(values: readonly Readonly<CatalogReference>[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    assertStableId(value.id);
    if (!value.name.trim()) throw new Error(`${label}名称不能为空`);
    if (!ids.add(value.id)) throw new Error(`${label}编号重复`);
  }
  return ids;
}

function validateRange(range: { minimum: number; maximum: number }, label: string): void {
  if (!Number.isSafeInteger(range.minimum) || !Number.isSafeInteger(range.maximum) || range.minimum < 0 || range.maximum < range.minimum) {
    throw new Error(`${label}范围无效`);
  }
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function validateContentCatalog(
  catalog: readonly Readonly<FacilityCatalogEntry>[] = FACILITY_CATALOG,
): void {
  const zoneIds = validateReferenceCatalog(ZONE_CATALOG, "分区");
  const itemIds = validateReferenceCatalog(ITEM_CATALOG, "物件");
  const facilityIds = new Set<string>();
  const facilityTypes = new Set<PublicSpaceType>();
  const candidateTypes = new Set(catalog.map(({ type }) => type));
  const completedChoiceIds = new Set(
    REPUTATION_UNLOCKS.map(({ key }) => key),
  );
  const candidateIds = catalog.map(({ id: facilityId }) => facilityId);
  if (
    candidateIds.length !== APPROVED_PUBLIC_SPACE_TYPES.length ||
    candidateIds.some(
      (facilityId, index) => facilityId !== APPROVED_PUBLIC_SPACE_TYPES[index],
    )
  ) {
    throw new Error("设施目录必须包含批准的 12 项并保持批准顺序");
  }

  catalog.forEach((entry, index) => {
    assertStableId(entry.id);
    if (entry.id !== `facility:${entry.type}` || !facilityIds.add(entry.id) || !facilityTypes.add(entry.type)) {
      throw new Error("设施编号或类型必须唯一且相互匹配");
    }
    if (entry.displayOrder !== index) throw new Error("设施展示顺序必须确定且连续");
    if (!entry.name.trim()) throw new Error("设施名称不能为空");
    assertSafeMoney(entry.constructionCostCents.minimum);
    assertSafeMoney(entry.constructionCostCents.maximum);
    validateRange(entry.constructionCostCents, "施工金额");
    validateRange(entry.defaultCapacity, "默认容量");
    if (!(SPACE_VALIDATION_STRATEGIES as readonly string[]).includes(entry.strategy)) {
      throw new Error("公共空间校验策略无效");
    }
    if (!entry.allowedZoneIds.length || hasDuplicates(entry.allowedZoneIds) ||
        entry.allowedZoneIds.some((zoneId) => !zoneIds.has(zoneId))) {
      throw new Error("设施允许分区规则无效");
    }
    if (!entry.requiredZoneIds.length || hasDuplicates(entry.requiredZoneIds) ||
        entry.requiredZoneIds.some((zoneId) => !zoneIds.has(zoneId))) {
      throw new Error("设施引用了未知分区");
    }
    if (entry.requiredZoneIds.some((zoneId) => !entry.allowedZoneIds.includes(zoneId))) {
      throw new Error("设施必需分区必须属于允许分区");
    }
    if (!entry.permittedItemIds.length || hasDuplicates(entry.permittedItemIds) ||
        entry.permittedItemIds.some((itemId) => !itemIds.has(itemId))) {
      throw new Error("设施引用了未知物件");
    }
    if (!entry.requiredItemIds.length || hasDuplicates(entry.requiredItemIds) ||
        entry.requiredItemIds.some((itemId) => !itemIds.has(itemId)) ||
        entry.requiredItemIds.some((itemId) => !entry.permittedItemIds.includes(itemId))) {
      throw new Error("设施必需物件规则无效");
    }
    if (entry.itemRules.length !== entry.permittedItemIds.length ||
        hasDuplicates(entry.itemRules.map(({ id: itemId }) => itemId)) ||
        entry.itemRules.some((rule, itemIndex) => rule.id !== entry.permittedItemIds[itemIndex]) ||
        entry.itemRules.some((rule) => !rule.allowedZoneIds.length || hasDuplicates(rule.allowedZoneIds) ||
          rule.allowedZoneIds.some((zoneId) => !zoneIds.has(zoneId) || !entry.allowedZoneIds.includes(zoneId)) ||
          !Number.isSafeInteger(rule.capacity) || rule.capacity < 0 ||
          !Number.isSafeInteger(rule.appealBps) || rule.appealBps < 0 || rule.appealBps > 10_000 ||
          !(["guest", "service", "feature"] as const).includes(rule.role))) {
      throw new Error("设施物件规则无效");
    }
    const metricValues = Object.values(entry.metrics);
    if (metricValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
        entry.metrics.constructionCellCostCents <= 0 ||
        entry.metrics.constructionItemCostCents <= 0 ||
        entry.metrics.baseAppealBps > 10_000 || entry.metrics.appealPerCellBps > 10_000 ||
        entry.metrics.basePrivacyBps > 10_000 || entry.metrics.quietZonePrivacyBps > 10_000) {
      throw new Error("设施运营指标规则无效");
    }
    for (const prerequisite of entry.unlockRule.all) {
      if (!(CONTENT_PROGRESS_SOURCES as readonly string[]).includes(prerequisite.source)) throw new Error("解锁进度来源无效");
      if (prerequisite.source === "reputation" && (!Number.isSafeInteger(prerequisite.thresholdBps) || prerequisite.thresholdBps < 0 || prerequisite.thresholdBps > 10_000)) throw new Error("解锁声誉无效");
      if (prerequisite.source === "discovered-need") {
        if (!(GUEST_SEGMENT_IDS as readonly string[]).includes(prerequisite.segmentId)) throw new Error("解锁引用了未知客群");
        if (prerequisite.kind !== "room-feature") throw new Error("解锁引用了当前结算无法生产的需求类型");
      }
      if (prerequisite.source === "completed-content-choice") {
        assertStableId(prerequisite.id);
        if (!completedChoiceIds.has(prerequisite.id)) throw new Error("解锁引用了未知内容选择");
      }
      if (prerequisite.source === "built-facility" && !candidateTypes.has(prerequisite.facilityType)) throw new Error("解锁引用了未知设施类型");
    }
  });

  const floorTemplateIds = new Set<string>();
  for (const template of FLOOR_TEMPLATE_CATALOG) {
    assertStableId(template.id);
    if (!floorTemplateIds.add(template.id)) throw new Error("楼层模板编号重复");
    if (!Number.isInteger(template.slotsPerSide) || template.slotsPerSide < 6 || template.slotsPerSide > 8) throw new Error("楼层模板密度无效");
    if (!Number.isSafeInteger(template.roomAreaSquareMeters) || template.roomAreaSquareMeters <= 0) throw new Error("楼层模板客房面积无效");
  }
  const towerIds = new Set<string>();
  for (const tower of TOWER_CATALOG) {
    assertStableId(tower.id);
    if (!towerIds.add(tower.id)) throw new Error("塔楼模板编号重复");
    if (!floorTemplateIds.has(tower.guestTemplateId)) throw new Error("塔楼引用了未知楼层模板");
    if (!Number.isInteger(tower.minimumFloorNumber) || !Number.isInteger(tower.maximumFloorNumber) || tower.minimumFloorNumber < 1 || tower.maximumFloorNumber < tower.minimumFloorNumber) throw new Error("塔楼楼层范围无效");
  }
}
