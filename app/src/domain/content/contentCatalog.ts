import { assertStableId, type StableId } from "../building/buildingTypes";
import type { PublicSpaceType } from "../facilities/facilityTypes";
import { assertSafeMoney } from "../primitives";

export const CONTENT_PROGRESS_SOURCES = [
  "reputation",
  "discovered-need",
  "built-facility",
  "completed-content-choice",
] as const;

export type ContentProgressSource = (typeof CONTENT_PROGRESS_SOURCES)[number];

export type ContentUnlockPrerequisite =
  | { source: "reputation"; thresholdBps: number }
  | { source: "discovered-need"; id: StableId }
  | { source: "built-facility"; facilityType: PublicSpaceType }
  | { source: "completed-content-choice"; id: StableId };

export interface FacilityCatalogEntry {
  id: StableId;
  type: PublicSpaceType;
  name: string;
  category: "arrival" | "food-and-beverage" | "wellness" | "events" | "leisure" | "retail";
  displayOrder: number;
  constructionCostCents: { minimum: number; maximum: number };
  operatingMode: "boost" | "light-operation";
  operationGroup: "boost" | "dining" | "bar" | "spa" | "banquet";
  requiredZoneIds: readonly StableId[];
  permittedItemIds: readonly StableId[];
  defaultCapacity: { minimum: number; maximum: number };
  unlockRule: { all: readonly ContentUnlockPrerequisite[] };
}

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

export const ZONE_CATALOG: readonly Readonly<CatalogReference>[] = [
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
] as const;

export const ITEM_CATALOG: readonly Readonly<CatalogReference>[] = [
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
] as const;

const reputation = (thresholdBps: number): ContentUnlockPrerequisite => ({
  source: "reputation",
  thresholdBps,
});
const need = (needId: string): ContentUnlockPrerequisite => ({
  source: "discovered-need",
  id: id(needId),
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
  zones: readonly string[],
  items: readonly string[],
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
  requiredZoneIds: zones.map(id),
  permittedItemIds: items.map(id),
  defaultCapacity: { minimum: capacity[0], maximum: capacity[1] },
  unlockRule: { all: prerequisites },
});

export const FACILITY_CATALOG: readonly Readonly<FacilityCatalogEntry>[] = [
  facility("sky-lobby", "Sky Lobby", "arrival", 0, [3_000_000, 9_000_000], [20, 120], "boost", ["zone:arrival"], ["item:reception-desk", "item:lounge-seat"], [reputation(0)]),
  facility("all-day-dining", "All-Day Dining", "food-and-beverage", 1, [5_000_000, 18_000_000], [30, 180], "dining", ["zone:seating", "zone:kitchen"], ["item:dining-table", "item:service-counter"], [reputation(0)]),
  facility("chinese-restaurant", "Chinese Restaurant", "food-and-beverage", 2, [7_000_000, 24_000_000], [24, 160], "dining", ["zone:seating", "zone:kitchen"], ["item:dining-table", "item:service-counter"], [reputation(6_000)]),
  facility("bar", "Bar", "food-and-beverage", 3, [3_500_000, 14_000_000], [16, 100], "bar", ["zone:seating", "zone:bar-service"], ["item:lounge-seat", "item:bar-counter"], [reputation(5_500)]),
  facility("executive-lounge", "Executive Lounge", "arrival", 4, [4_000_000, 12_000_000], [16, 80], "boost", ["zone:quiet"], ["item:lounge-seat", "item:service-counter"], [reputation(6_500)]),
  facility("spa", "Spa", "wellness", 5, [6_000_000, 20_000_000], [4, 36], "spa", ["zone:quiet", "zone:wet"], ["item:treatment-bed"], [reputation(7_500), need("need:wellness")]),
  facility("pool", "Pool", "wellness", 6, [9_000_000, 30_000_000], [12, 100], "boost", ["zone:wet"], ["item:pool", "item:lounge-seat"], [reputation(7_000)]),
  facility("gym", "Gym", "wellness", 7, [3_000_000, 11_000_000], [8, 60], "boost", ["zone:fitness"], ["item:fitness-station"], [reputation(5_000)]),
  facility("ballroom", "Ballroom", "events", 8, [12_000_000, 40_000_000], [80, 500], "banquet", ["zone:event", "zone:back-of-house"], ["item:event-table", "item:service-counter"], [reputation(7_000), built("all-day-dining")]),
  facility("meeting-room", "Meeting Room", "events", 9, [2_500_000, 10_000_000], [6, 80], "banquet", ["zone:event"], ["item:meeting-table"], [reputation(6_000)]),
  facility("garden-terrace", "Garden Terrace", "leisure", 10, [3_000_000, 12_000_000], [12, 120], "boost", ["zone:terrace"], ["item:planter", "item:lounge-seat"], [choice("operations:premium-segments")]),
  facility("boutique", "Boutique", "retail", 11, [2_000_000, 8_000_000], [4, 30], "boost", ["zone:retail"], ["item:display-case"], [reputation(7_500), built("sky-lobby")]),
] as const;

export const APPROVED_PUBLIC_SPACE_TYPES: readonly StableId[] =
  FACILITY_CATALOG.map(({ id: facilityId }) => facilityId);

export const FLOOR_TEMPLATE_CATALOG: readonly Readonly<FloorTemplateCatalogEntry>[] = [
  {
    id: id("template:guest:dense-ring"),
    name: "Dense Ring Guest Floor",
    use: "guest",
    slotsPerSide: 8,
    roomAreaSquareMeters: 24,
  },
] as const;

export const TOWER_CATALOG: readonly Readonly<TowerCatalogEntry>[] = [
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
] as const;

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

export function validateContentCatalog(
  catalog: readonly Readonly<FacilityCatalogEntry>[] = FACILITY_CATALOG,
): void {
  const zoneIds = validateReferenceCatalog(ZONE_CATALOG, "分区");
  const itemIds = validateReferenceCatalog(ITEM_CATALOG, "物件");
  const facilityIds = new Set<string>();
  const facilityTypes = new Set<PublicSpaceType>();

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
    if (!entry.requiredZoneIds.length || entry.requiredZoneIds.some((zoneId) => !zoneIds.has(zoneId))) {
      throw new Error("设施引用了未知分区");
    }
    if (!entry.permittedItemIds.length || entry.permittedItemIds.some((itemId) => !itemIds.has(itemId))) {
      throw new Error("设施引用了未知物件");
    }
    for (const prerequisite of entry.unlockRule.all) {
      if (!(CONTENT_PROGRESS_SOURCES as readonly string[]).includes(prerequisite.source)) throw new Error("解锁进度来源无效");
      if (prerequisite.source === "reputation" && (!Number.isSafeInteger(prerequisite.thresholdBps) || prerequisite.thresholdBps < 0 || prerequisite.thresholdBps > 10_000)) throw new Error("解锁声誉无效");
      if (prerequisite.source === "discovered-need" || prerequisite.source === "completed-content-choice") assertStableId(prerequisite.id);
      if (prerequisite.source === "built-facility" && !FACILITY_CATALOG.some(({ type }) => type === prerequisite.facilityType)) throw new Error("解锁引用了未知设施类型");
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
