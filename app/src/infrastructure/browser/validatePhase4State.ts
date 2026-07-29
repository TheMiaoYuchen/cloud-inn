type JsonObject = Record<string, unknown>;

const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9:-]{0,95}$/;
const PUBLIC_SPACE_TYPES = [
  "sky-lobby", "all-day-dining", "chinese-restaurant", "bar", "executive-lounge", "spa",
  "pool", "gym", "ballroom", "meeting-room", "garden-terrace", "boutique",
] as const;
const FLOOR_USES = ["entrance", "sky-lobby", "guest", "facility", "service"] as const;
const SEGMENTS = ["business", "couple", "family", "leisure", "high-net-worth", "cultural-experience"] as const;
const ZONE_IDS = new Set([
  "zone:arrival", "zone:seating", "zone:kitchen", "zone:bar-service", "zone:quiet", "zone:wet",
  "zone:fitness", "zone:event", "zone:back-of-house", "zone:terrace", "zone:retail", "zone:deck",
  "zone:service-route", "zone:entrance", "zone:reception", "zone:waiting", "zone:luggage",
  "zone:elevator-lobby", "zone:treatment", "zone:wet-route", "zone:stage", "zone:meeting-setup",
  "zone:partition",
]);
const ITEM_IDS = new Set([
  "item:reception-desk", "item:lounge-seat", "item:dining-table", "item:service-counter",
  "item:bar-counter", "item:treatment-bed", "item:pool", "item:fitness-station", "item:event-table",
  "item:meeting-table", "item:planter", "item:display-case",
]);
const FACILITY_IDS = new Set(PUBLIC_SPACE_TYPES.map((type) => `facility:${type}`));
const MARKET_IDS = new Set(SEGMENTS.map((segment) => `market:${segment}`));
const POLICY_GROUPS: Readonly<Record<string, readonly string[]>> = {
  dining: [
    "positioning:international-luxury|price-band:premium|opening-policy:breakfast-dinner",
    "positioning:local-contemporary|price-band:upper-midscale|opening-policy:all-day",
    "positioning:destination-dining|price-band:luxury|opening-policy:dinner-only",
  ],
  bar: [
    "positioning:craft-cocktail|price-band:premium|opening-policy:evening",
    "positioning:social-lounge|price-band:upper-midscale|opening-policy:afternoon-late",
    "positioning:skyline-luxury|price-band:luxury|opening-policy:sunset-late",
  ],
  spa: [
    "positioning:restorative-wellness|price-band:premium|opening-policy:appointment-daily",
    "positioning:clinical-wellness|price-band:luxury|opening-policy:appointment-extended",
    "positioning:express-wellness|price-band:upper-midscale|opening-policy:daytime",
  ],
  banquet: [
    "positioning:corporate-events|price-band:premium|opening-policy:booked-events",
    "positioning:celebration-luxury|price-band:luxury|opening-policy:booked-events",
    "positioning:flexible-events|price-band:upper-midscale|opening-policy:day-evening",
  ],
};
const FACILITY_POLICY_GROUP: Partial<Record<(typeof PUBLIC_SPACE_TYPES)[number], keyof typeof POLICY_GROUPS>> = {
  "all-day-dining": "dining", "chinese-restaurant": "dining", bar: "bar", spa: "spa",
  ballroom: "banquet", "meeting-room": "banquet",
};
const MENU_TYPES: Readonly<Record<string, readonly string[]>> = {
  "menu:all-day-balanced": ["all-day-dining"], "menu:all-day-seasonal": ["all-day-dining"],
  "menu:all-day-chef-led": ["all-day-dining"], "menu:chinese-regional": ["chinese-restaurant"],
  "menu:chinese-banquet": ["chinese-restaurant"], "menu:chinese-modern": ["chinese-restaurant"],
  "menu:bar-classics": ["bar"], "menu:bar-seasonal": ["bar"], "menu:bar-zero-proof": ["bar"],
};
const OFFERING_TYPES: Readonly<Record<string, readonly string[]>> = {
  "dish:tea-smoked-duck": ["all-day-dining", "chinese-restaurant"], "dish:cloud-breakfast": ["all-day-dining"],
  "dish:harbor-seafood": ["all-day-dining"], "dish:crystal-shrimp": ["chinese-restaurant"],
  "dish:mountain-broth": ["chinese-restaurant"], "drink:cloud-negroni": ["bar"],
  "drink:tea-spritz": ["bar"], "drink:night-orchard": ["bar"], "service:cloud-restoration": ["spa"],
  "service:express-recovery": ["spa"], "service:couples-ritual": ["spa"],
  "service:cloud-wedding": ["ballroom", "meeting-room"], "service:executive-summit": ["ballroom", "meeting-room"],
  "service:cultural-gala": ["ballroom", "meeting-room"],
};
const CREDENTIAL_KEYS = new Set([
  "password", "passwd", "secret", "apikey", "accesstoken", "refreshtoken", "authtoken",
  "privatekey", "clientsecret", "credential", "credentials",
]);
const CREDENTIAL_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|password|secret|credentials?)\s*[:=]|\bBearer\s+[A-Za-z0-9._~-]{16,})/i;
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function phase4Error(detail: string): never {
  throw new Error(`浏览器存档已损坏：内容规模存档${detail}`);
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) phase4Error(`${label}结构无效`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) phase4Error(`${label}结构无效`);
  return value;
}

function boundedString(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximum || value.trim() !== value) {
    phase4Error(`${label}文本无效`);
  }
  return value;
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) phase4Error(`${label}必须是稳定 ID`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    phase4Error(`${label}必须是安全整数`);
  }
  return value as number;
}

function bps(value: unknown, label: string, minimum = 0, maximum = 10_000): number {
  return integer(value, label, minimum, maximum);
}

function oneOf(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) phase4Error(`${label}目录引用无效`);
  return value;
}

function uniqueIds(values: unknown, label: string, allowed?: ReadonlySet<string>): string[] {
  const result = array(values, label).map((value) => stableId(value, label));
  if (new Set(result).size !== result.length) phase4Error(`${label}编号重复`);
  if (allowed && result.some((value) => !allowed.has(value))) phase4Error("目录引用无效");
  return result;
}

function isStrictBase64(value: string): boolean {
  const payload = value.startsWith("data:") && value.includes(";base64,")
    ? value.slice(value.indexOf(",") + 1)
    : value;
  return payload.length >= 128 && payload.length % 4 === 0 && STRICT_BASE64.test(payload);
}

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function validateTree(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 32) phase4Error("JSON嵌套过深");
    if (typeof current.value === "string") {
      if (Array.from(current.value).length > 4_096) phase4Error("文本超过长度限制");
      if (CREDENTIAL_VALUE.test(current.value)) phase4Error("禁止持久化凭据");
      if (isStrictBase64(current.value)) {
        phase4Error("禁止持久化Base64数据");
      }
    } else if (Array.isArray(current.value)) {
      if (seen.has(current.value)) phase4Error("JSON包含循环或重复对象引用");
      seen.add(current.value);
      current.value.forEach((child) => pending.push({ value: child, depth: current.depth + 1 }));
    } else if (typeof current.value === "object" && current.value !== null) {
      if (seen.has(current.value)) phase4Error("JSON包含循环或重复对象引用");
      seen.add(current.value);
      for (const [key, child] of Object.entries(current.value)) {
        if (Array.from(key).length > 128) phase4Error("字段名超过长度限制");
        if (isCredentialKey(key)) phase4Error("禁止持久化凭据");
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (!["number", "boolean"].includes(typeof current.value) && current.value !== null) {
      phase4Error("JSON结构无效");
    }
  }
}

function validateIdentityRecord(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): JsonObject {
  const record = object(value, label);
  const entries = Object.entries(record);
  const ids = new Set<string>();
  for (const [key, raw] of entries) {
    stableId(key, "记录键");
    const definition = object(raw, label);
    const id = stableId(definition.id, `${label}编号`);
    if (ids.has(id)) phase4Error(`${label}编号重复`);
    ids.add(id);
  }
  for (const [key, raw] of entries) {
    const definition = object(raw, label);
    if (key !== definition.id) phase4Error("记录键与编号不一致");
  }
  if (entries.length > maximum) phase4Error(`${label}最多保留${maximum}项`);
  return record;
}

function validateMoneyFields(value: JsonObject): void {
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Cents")) integer(child, key);
  }
}

function validateFacilityHistory(facility: JsonObject, currentDay: number): void {
  const history = array(facility.dailyResults, "设施历史");
  if (history.length > 30) phase4Error("设施历史最多保留30天");
  let priorDay = 0;
  for (const raw of history) {
    const result = object(raw, "设施历史");
    const day = integer(result.day, "设施历史日期", 1, 30);
    if (day <= priorDay || day > currentDay) phase4Error("设施历史日期无效");
    priorDay = day;
    integer(result.visits, "设施到访量");
    integer(result.revenueCents, "设施收入");
    integer(result.operatingCostCents, "设施经营成本");
    bps(result.utilizationBps, "设施利用率");
    bps(result.satisfactionDeltaBps, "设施满意度变化", -200, 200);
    bps(result.appealDeltaBps, "设施吸引力变化", -200, 200);
    uniqueIds(result.reasonCodes, "设施原因");
  }
}

export function validatePhase4State(value: unknown, gameValue?: unknown): void {
  validateTree(value);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") phase4Error("JSON结构无效");
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) phase4Error("JSON超过大小限制");
  const phase4 = object(value, "状态");
  const game = gameValue === undefined ? undefined : object(gameValue, "游戏");
  if (phase4.rulesetVersion !== "content-scale-v1") phase4Error("规则版本无效");

  const building = object(phase4.building, "建筑");
  if (building.templateId !== "building-template:first-tower") phase4Error("目录引用无效");
  const templates = validateIdentityRecord(phase4.floorTemplates, "楼层模板", 64);
  const blueprints = validateIdentityRecord(phase4.spaceBlueprints, "公共空间蓝图", 32);
  const publicSpaces = validateIdentityRecord(phase4.publicSpaces, "公共空间", 32);
  const facilities = validateIdentityRecord(phase4.facilities, "设施", 32);
  const floors = array(phase4.floors, "楼层");
  if (floors.length > 64) phase4Error("楼层最多保留64层");
  object(phase4.catalogProgress, "目录进度");
  if (!(phase4.recentFlowSnapshot === null || typeof phase4.recentFlowSnapshot === "object")) {
    phase4Error("近期流动快照结构无效");
  }

  const designIds = new Set<string>();
  const variantMasterIds = new Map<string, string>();
  if (game) {
    const phase2 = game.phase2 === undefined ? undefined : object(game.phase2, "二期状态");
    if (phase2?.roomMaster) designIds.add(stableId(object(phase2.roomMaster, "客房母版").id, "客房母版编号"));
    for (const rawVariant of phase2 ? array(phase2.roomVariants, "客房变体") : []) {
      const variant = object(rawVariant, "客房变体");
      const id = stableId(variant.id, "客房变体编号");
      const masterId = stableId(variant.masterId, "客房母版编号");
      if (variantMasterIds.has(id)) phase4Error("客房变体编号重复");
      variantMasterIds.set(id, masterId);
    }
    if (game.roomBlueprint) designIds.add(stableId(object(game.roomBlueprint, "客房设计").id, "客房设计编号"));
  }

  const templatePlacements = new Map<string, Map<string, JsonObject>>();
  const templateSlots = new Map<string, Map<string, readonly string[]>>();
  for (const [id, raw] of Object.entries(templates)) {
    const template = object(raw, "楼层模板");
    oneOf(template.use, FLOOR_USES, "楼层用途");
    integer(template.columns, "楼层模板列数", 1, 512);
    integer(template.rows, "楼层模板行数", 1, 512);
    if (template.cellAreaSquareMeters !== 1) phase4Error("楼层模板单元面积无效");
    const placements = new Map<string, JsonObject>();
    for (const rawPlacement of array(template.roomPlacements, "客房放置")) {
      const placement = object(rawPlacement, "客房放置");
      const placementId = stableId(placement.id, "客房放置编号");
      if (placements.has(placementId)) phase4Error("客房放置编号重复");
      const masterId = stableId(placement.roomBlueprintId, "客房母版编号");
      if (designIds.size > 0 && !designIds.has(masterId)) phase4Error("客房设计引用无效");
      if (placement.variantId !== undefined) {
        const variantId = stableId(placement.variantId, "客房变体编号");
        if (variantMasterIds.get(variantId) !== masterId) phase4Error("客房变体引用无效");
      }
      integer(placement.anchorX, "客房横坐标", 0, Number(template.columns) - 1);
      integer(placement.anchorY, "客房纵坐标", 0, Number(template.rows) - 1);
      integer(placement.width, "客房宽度", 1, Number(template.columns));
      integer(placement.height, "客房高度", 1, Number(template.rows));
      if (
        Number(placement.anchorX) + Number(placement.width) > Number(template.columns)
        || Number(placement.anchorY) + Number(placement.height) > Number(template.rows)
      ) phase4Error("客房放置超出楼层模板");
      if (![0, 90, 180, 270].includes(Number(placement.rotation)) || typeof placement.mirrored !== "boolean") {
        phase4Error("客房放置几何无效");
      }
      placements.set(placementId, placement);
    }
    templatePlacements.set(id, placements);
    const slots = new Map<string, readonly string[]>();
    for (const rawSlot of array(template.publicSpaceSlots, "公共空间槽位")) {
      const slot = object(rawSlot, "公共空间槽位");
      const slotId = stableId(slot.id, "公共空间槽位编号");
      if (slots.has(slotId)) phase4Error("公共空间槽位编号重复");
      const permitted = array(slot.permittedTypes, "允许设施类型").map((type) => oneOf(type, PUBLIC_SPACE_TYPES, "设施类型"));
      if (permitted.length === 0 || new Set(permitted).size !== permitted.length) phase4Error("允许设施类型无效");
      const geometry = [slot.anchorX, slot.anchorY, slot.width, slot.height];
      const geometryFieldCount = geometry.filter((value) => value !== undefined).length;
      if (geometryFieldCount !== 0 && geometryFieldCount !== geometry.length) {
        phase4Error("公共空间槽位几何必须完整");
      }
      if (geometryFieldCount === geometry.length) {
        const anchorX = integer(slot.anchorX, "公共空间槽位几何", 0, Number(template.columns) - 1);
        const anchorY = integer(slot.anchorY, "公共空间槽位几何", 0, Number(template.rows) - 1);
        const width = integer(slot.width, "公共空间槽位几何", 1, Number(template.columns));
        const height = integer(slot.height, "公共空间槽位几何", 1, Number(template.rows));
        if (
          anchorX + width > Number(template.columns)
          || anchorY + height > Number(template.rows)
        ) phase4Error("公共空间槽位几何超出楼层模板");
      }
      slots.set(slotId, permitted);
    }
    templateSlots.set(id, slots);
  }

  const floorIds = new Set<string>();
  const floorNumbers = new Set<number>();
  const floorById = new Map<string, JsonObject>();
  const roomIds = new Set<string>();
  for (const rawFloor of floors) {
    const floor = object(rawFloor, "楼层");
    const floorId = stableId(floor.id, "楼层编号");
    const floorNumber = integer(floor.floorNumber, "楼层号", 1, 64);
    if (floorIds.has(floorId)) phase4Error("楼层编号重复");
    if (floorNumbers.has(floorNumber)) phase4Error("楼层号重复");
    floorIds.add(floorId);
    floorNumbers.add(floorNumber);
  }
  let roomCount = 0;
  for (const rawFloor of floors) {
    const floor = object(rawFloor, "楼层");
    const floorId = stableId(floor.id, "楼层编号");
    floorById.set(floorId, floor);
    const templateId = stableId(floor.templateId, "楼层模板编号");
    const template = templates[templateId];
    if (!template || object(template, "楼层模板").use !== floor.use) phase4Error("楼层模板引用无效");
    oneOf(floor.use, FLOOR_USES, "楼层用途");
    if (typeof floor.purchased !== "boolean") phase4Error("楼层购买状态无效");
    uniqueIds(floor.publicSpaceInstanceIds, "楼层公共空间");
    const rooms = array(floor.rooms, "客房");
    roomCount += rooms.length;
    if (roomCount > 240) phase4Error("客房最多保留240间");
    for (const rawRoom of rooms) {
      const room = object(rawRoom, "客房");
      const roomId = stableId(room.id, "客房编号");
      if (roomIds.has(roomId)) phase4Error("客房编号重复");
      roomIds.add(roomId);
      if (!floorIds.has(String(room.floorId))) phase4Error("客房楼层引用无效");
      if (room.floorId !== floorId) phase4Error("客房必须属于所在楼层");
      const placementId = stableId(room.localPlacementId, "客房放置编号");
      const placement = templatePlacements.get(templateId)?.get(placementId);
      if (!placement || placement.roomBlueprintId !== room.roomBlueprintId || placement.variantId !== room.variantId) {
        phase4Error("客房放置或设计引用无效");
      }
      stableId(room.roomBlueprintId, "客房母版编号");
      if (room.variantId !== undefined) stableId(room.variantId, "客房变体编号");
      integer(room.committedBuildCostCents, "施工金额");
    }
  }

  const entranceFloorId = stableId(building.entranceFloorId, "入口楼层编号");
  if (!floorIds.has(entranceFloorId) || floorById.get(entranceFloorId)?.use !== "entrance") phase4Error("入口楼层引用无效");
  for (const id of uniqueIds(building.skyLobbyFloorIds, "空中大堂楼层")) {
    if (floorById.get(id)?.use !== "sky-lobby") phase4Error("空中大堂楼层引用无效");
  }
  for (const id of uniqueIds(building.purchasedFloorIds, "已购买楼层")) {
    if (!floorIds.has(id)) phase4Error("已购买楼层引用无效");
  }
  const expansionNumbers = array(building.availableExpansionFloorNumbers, "可扩建楼层").map((number) => integer(number, "可扩建楼层号", 1, 64));
  if (new Set(expansionNumbers).size !== expansionNumbers.length || expansionNumbers.some((number) => floorNumbers.has(number))) {
    phase4Error("可扩建楼层引用无效");
  }

  for (const raw of Object.values(blueprints)) {
    const blueprint = object(raw, "公共空间蓝图");
    oneOf(blueprint.type, PUBLIC_SPACE_TYPES, "公共空间类型");
    boundedString(blueprint.name, "公共空间名称", 256);
    const columns = integer(blueprint.columns, "公共空间列数", 1, 512);
    const rows = integer(blueprint.rows, "公共空间行数", 1, 512);
    const cells = array(blueprint.cells, "公共空间蓝图格子");
    if (cells.length > 8_192) phase4Error("公共空间蓝图格子最多保留8192项");
    const coordinates = new Set<string>();
    for (const rawCell of cells) {
      const cell = object(rawCell, "公共空间格子");
      const x = integer(cell.x, "公共空间格子横坐标", 0, columns - 1);
      const y = integer(cell.y, "公共空间格子纵坐标", 0, rows - 1);
      if (!coordinates.add(`${x},${y}`)) phase4Error("公共空间格子坐标重复");
      if (!ZONE_IDS.has(stableId(cell.zoneId, "分区编号"))) phase4Error("目录引用无效");
    }
    const items = array(blueprint.placedItems, "公共空间蓝图物品");
    if (items.length > 256) phase4Error("公共空间蓝图物品最多保留256项");
    const itemIds = new Set<string>();
    for (const rawItem of items) {
      const item = object(rawItem, "公共空间物品");
      if (!itemIds.add(stableId(item.id, "公共空间物品编号"))) phase4Error("公共空间物品编号重复");
      if (!ITEM_IDS.has(stableId(item.catalogItemId, "物品目录编号"))) phase4Error("目录引用无效");
      const x = integer(item.x, "物品横坐标", 0, columns - 1);
      const y = integer(item.y, "物品纵坐标", 0, rows - 1);
      const width = integer(item.width, "物品宽度", 1, columns);
      const height = integer(item.height, "物品高度", 1, rows);
      if (x + width > columns || y + height > rows) phase4Error("公共空间物品超出蓝图");
      if (![0, 90, 180, 270].includes(Number(item.rotation))) phase4Error("物品旋转无效");
    }
    integer(blueprint.committedBuildCostCents, "施工金额");
  }

  const ownedSpaces = new Map<string, string>();
  for (const rawFloor of floors) {
    const floor = object(rawFloor, "楼层");
    for (const instanceId of uniqueIds(floor.publicSpaceInstanceIds, "楼层公共空间")) {
      if (ownedSpaces.has(instanceId)) phase4Error("公共空间所属楼层重复");
      ownedSpaces.set(instanceId, String(floor.id));
    }
  }
  const occupiedPublicSpacePlacements = new Set<string>();
  for (const [id, raw] of Object.entries(publicSpaces)) {
    const space = object(raw, "公共空间");
    const floorId = stableId(space.floorId, "公共空间楼层编号");
    const floor = floorById.get(floorId);
    if (!floor || ownedSpaces.get(id) !== floorId) phase4Error("公共空间楼层引用无效");
    const localPlacementId = stableId(space.localPlacementId, "公共空间槽位编号");
    const placementKey = `${floorId}\u0000${localPlacementId}`;
    if (occupiedPublicSpacePlacements.has(placementKey)) phase4Error("公共空间放置重复");
    occupiedPublicSpacePlacements.add(placementKey);
    const permitted = templateSlots.get(String(floor.templateId))?.get(localPlacementId);
    const type = oneOf(space.type, PUBLIC_SPACE_TYPES, "公共空间类型");
    if (!permitted?.includes(type)) phase4Error("公共空间槽位或类型引用无效");
    const blueprint = blueprints[stableId(space.blueprintId, "公共空间蓝图编号")];
    if (!blueprint || object(blueprint, "公共空间蓝图").type !== type) phase4Error("公共空间蓝图引用无效");
    integer(space.committedBuildCostCents, "施工金额");
  }
  if (ownedSpaces.size !== Object.keys(publicSpaces).length) phase4Error("楼层公共空间反向引用不完整");

  const facilitySpaceIds = new Set<string>();
  for (const raw of Object.values(facilities)) {
    const facility = object(raw, "设施");
    const type = oneOf(facility.type, PUBLIC_SPACE_TYPES, "设施类型");
    const instanceId = stableId(facility.publicSpaceInstanceId, "设施公共空间编号");
    if (facilitySpaceIds.has(instanceId)) phase4Error("设施公共空间引用重复");
    facilitySpaceIds.add(instanceId);
    const instance = publicSpaces[instanceId];
    if (!instance || object(instance, "公共空间").type !== type) phase4Error("设施公共空间引用无效");
    oneOf(facility.status, ["planned", "operating", "closed"], "设施状态");
    if (typeof facility.enabled !== "boolean") phase4Error("设施启用状态无效");
    integer(facility.dailyOperatingCostCents, "设施每日成本");
    const inputs = object(facility.segmentInputs, "设施客群输入");
    if (Object.keys(inputs).length !== SEGMENTS.length || SEGMENTS.some((segment) => !(segment in inputs))) phase4Error("设施客群目录不完整");
    for (const segment of SEGMENTS) {
      const input = object(inputs[segment], "设施客群输入");
      bps(input.appealBps, "客群吸引力");
      bps(input.satisfactionBps, "客群满意度");
      integer(input.dailyDemand, "客群每日需求");
    }
    const developed = uniqueIds(facility.developedOfferingIds, "已开发产品");
    if (developed.some((id) => !OFFERING_TYPES[id]?.includes(type))) phase4Error("目录引用无效");
    if (facility.policy !== null) {
      const policy = object(facility.policy, "设施策略");
      const combination = [policy.positioningId, policy.priceBandId, policy.openingPolicyId].map((id) => stableId(id, "设施策略编号")).join("|");
      const group = FACILITY_POLICY_GROUP[type as keyof typeof FACILITY_POLICY_GROUP];
      if (!group || !POLICY_GROUPS[group].includes(combination)) phase4Error("目录引用无效");
      integer(policy.capacity, "设施容量", 1, 10_000);
      integer(policy.serviceBudgetCents, "设施服务预算");
      if (policy.signatureOfferingId !== undefined) {
        const offeringId = stableId(policy.signatureOfferingId, "招牌产品编号");
        if (!OFFERING_TYPES[offeringId]?.includes(type) || !developed.includes(offeringId)) phase4Error("目录引用无效");
      }
    }
    if (facility.menuSelection !== null) {
      const selection = object(facility.menuSelection, "菜单选择");
      const menuId = stableId(selection.menuStructureId, "菜单编号");
      if (!MENU_TYPES[menuId]?.includes(type)) phase4Error("目录引用无效");
      uniqueIds(selection.selectedItemIds, "菜单条目");
    }
    validateFacilityHistory(facility, game ? integer(game.currentDay, "当前营业日", 0, 30) : 30);
    validateMoneyFields(facility);
  }

  const progress = object(phase4.catalogProgress, "目录进度");
  uniqueIds(progress.unlockedIds, "内容解锁", FACILITY_IDS);
  uniqueIds(progress.discoveredMarketEntryIds, "市场目录", MARKET_IDS);

  if (phase4.recentFlowSnapshot !== null) {
    const snapshot = object(phase4.recentFlowSnapshot, "近期流动快照");
    integer(snapshot.day, "流动快照日期", 0, 30);
    if (!floorIds.has(stableId(snapshot.visibleFloorId, "可见楼层编号"))) phase4Error("流动楼层引用无效");
    const events = array(snapshot.events, "流动事件");
    if (events.length > 150) phase4Error("流动事件最多保留150项");
    const eventIds = new Set<string>();
    const graphIds = new Set([
      ...floorIds,
      ...Object.keys(publicSpaces),
      ...Object.keys(facilities),
      "flow:hotel-residents",
    ]);
    for (const rawEvent of events) {
      const event = object(rawEvent, "流动事件");
      if (!eventIds.add(stableId(event.id, "流动事件编号"))) phase4Error("流动事件编号重复");
      oneOf(event.kind, ["guest", "staff", "service"], "流动事件类型");
      if (!graphIds.has(stableId(event.fromId, "流动起点编号")) || !graphIds.has(stableId(event.toId, "流动终点编号"))) {
        phase4Error("流动引用无效");
      }
      integer(event.count, "流动数量", 1);
    }
  }
}
