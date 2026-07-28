import {
  FACILITY_CATALOG,
  ITEM_CATALOG,
  ZONE_CATALOG,
  type SpaceItemRule,
  type SpaceTypeDefinition,
} from "../content/contentCatalog";
import {
  validateSpaceConnectivity,
  validateSpaceDraft,
} from "./spaceEditor";
import {
  SPACE_EDITOR_MAX_CELLS,
  SPACE_EDITOR_MAX_ITEMS,
  SPACE_EDITOR_MAX_OPENINGS,
  type PlacedItem,
  type PlanningIssue,
  type PublicSpaceValidation,
  type SpaceCell,
  type SpaceDraft,
} from "./spaceTypes";

const issue = (code: string, message: string): PlanningIssue => ({ code, message });
const coordinateKey = (x: number, y: number) => `${x},${y}`;

function definitionFor(draft: SpaceDraft): Readonly<SpaceTypeDefinition> {
  const definition = FACILITY_CATALOG.find(({ type }) => type === draft.type);
  if (!definition) throw new Error("公共空间类型未在目录中定义");
  return definition;
}

function validCellGeometry(draft: SpaceDraft, cell: SpaceCell): boolean {
  return Number.isSafeInteger(draft.columns) && Number.isSafeInteger(draft.rows) &&
    Number.isSafeInteger(cell.x) && Number.isSafeInteger(cell.y) &&
    cell.x >= 0 && cell.y >= 0 && cell.x < draft.columns && cell.y < draft.rows;
}

function validItemGeometry(draft: SpaceDraft, item: PlacedItem): boolean {
  return Number.isSafeInteger(draft.columns) && Number.isSafeInteger(draft.rows) &&
    Number.isSafeInteger(item.x) && Number.isSafeInteger(item.y) &&
    Number.isSafeInteger(item.width) && Number.isSafeInteger(item.height) &&
    item.x >= 0 && item.y >= 0 && item.width > 0 && item.height > 0 &&
    item.x < draft.columns && item.y < draft.rows &&
    item.width <= draft.columns - item.x && item.height <= draft.rows - item.y;
}

function normalizedValidCells(draft: SpaceDraft): SpaceCell[] {
  const byCoordinate = new Map<string, SpaceCell>();
  for (const cell of draft.cells.slice(0, SPACE_EDITOR_MAX_CELLS)) {
    if (validCellGeometry(draft, cell)) byCoordinate.set(coordinateKey(cell.x, cell.y), cell);
  }
  return [...byCoordinate.values()].sort((left, right) => left.y - right.y || left.x - right.x);
}

function itemRuleFor(
  definition: Readonly<SpaceTypeDefinition>,
  item: PlacedItem,
): Readonly<SpaceItemRule> | undefined {
  return definition.itemRules.find(({ id }) => id === item.catalogItemId);
}

function itemInAllowedZone(
  draft: SpaceDraft,
  cells: SpaceCell[],
  item: PlacedItem,
  rule: Readonly<SpaceItemRule>,
): boolean {
  if (!validItemGeometry(draft, item)) return false;
  const area = BigInt(item.width) * BigInt(item.height);
  if (area > BigInt(SPACE_EDITOR_MAX_CELLS)) return false;
  const covered = new Set<string>();
  for (const cell of cells) {
    if (cell.x >= item.x && cell.x < item.x + item.width &&
        cell.y >= item.y && cell.y < item.y + item.height &&
        rule.allowedZoneIds.includes(cell.zoneId as never)) {
      covered.add(coordinateKey(cell.x, cell.y));
    }
  }
  return BigInt(covered.size) === area;
}

function validCatalogItems(
  draft: SpaceDraft,
  definition: Readonly<SpaceTypeDefinition>,
  cells: SpaceCell[],
): Array<{ item: PlacedItem; rule: Readonly<SpaceItemRule> }> {
  const values: Array<{ item: PlacedItem; rule: Readonly<SpaceItemRule> }> = [];
  const itemIds = new Set<string>();
  for (const item of draft.items.slice(0, SPACE_EDITOR_MAX_ITEMS)) {
    const rule = itemRuleFor(definition, item);
    if (!rule || itemIds.has(item.id) || !itemInAllowedZone(draft, cells, item, rule)) continue;
    const collides = values.some(({ item: accepted }) =>
      accepted.x < item.x + item.width && accepted.x + accepted.width > item.x &&
      accepted.y < item.y + item.height && accepted.y + accepted.height > item.y,
    );
    if (collides) continue;
    itemIds.add(item.id);
    values.push({ item, rule });
  }
  return values;
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}超出安全整数范围`);
  }
  return Number(value);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function calculateMetrics(
  draft: SpaceDraft,
  definition: Readonly<SpaceTypeDefinition>,
): PublicSpaceValidation["metrics"] {
  const allowedZones = new Set<string>(definition.allowedZoneIds);
  const cells = normalizedValidCells(draft).filter(({ zoneId }) => allowedZones.has(zoneId));
  const items = validCatalogItems(draft, definition, cells);
  const construction = BigInt(definition.constructionCostCents.minimum) +
    BigInt(cells.length) * BigInt(definition.metrics.constructionCellCostCents) +
    BigInt(items.length) * BigInt(definition.metrics.constructionItemCostCents);
  const constructionCostCents = safeNumber(
    construction > BigInt(definition.constructionCostCents.maximum)
      ? BigInt(definition.constructionCostCents.maximum)
      : construction,
    "建造成本",
  );
  const capacityTotal = items.reduce((sum, { rule }) => sum + BigInt(rule.capacity), 0n);
  const capacity = safeNumber(
    capacityTotal > BigInt(definition.defaultCapacity.maximum)
      ? BigInt(definition.defaultCapacity.maximum)
      : capacityTotal,
    "空间容量",
  );
  const appealTotal = BigInt(definition.metrics.baseAppealBps) +
    BigInt(cells.length) * BigInt(definition.metrics.appealPerCellBps) +
    items.reduce((sum, { rule }) => sum + BigInt(rule.appealBps), 0n);
  const guestAppealBps = safeNumber(appealTotal > 10_000n ? 10_000n : appealTotal, "宾客吸引力");
  const quietCells = cells.filter(({ zoneId }) => zoneId === "zone:quiet").length;
  let privacy = BigInt(definition.metrics.basePrivacyBps) +
    BigInt(quietCells) * BigInt(definition.metrics.quietZonePrivacyBps);
  if (privacy > 10_000n) privacy = 10_000n;
  if (definition.strategy === "spa") {
    const hasTreatmentZone = cells.some(({ zoneId }) => zoneId === "zone:treatment");
    const hasTreatmentBed = items.some(({ item }) => item.catalogItemId === "item:treatment-bed");
    if (!hasTreatmentZone || !hasTreatmentBed || zonesAdjacent(cells, "zone:treatment", "zone:wet")) {
      privacy = privacy > 4_000n ? 4_000n : privacy;
    }
  }
  const privacyBps = safeNumber(privacy, "私密性");
  const serviceItems = items.filter(({ rule }) => rule.role === "service");
  const guestItems = items.filter(({ rule }) => rule.role === "guest");
  let serviceDistance = 0;
  if (serviceItems.length > 0 && guestItems.length > 0) {
    let total = 0n;
    let pairs = 0n;
    for (const { item: service } of serviceItems) {
      for (const { item: guest } of guestItems) {
        total += absolute(BigInt(service.x) - BigInt(guest.x)) +
          absolute(BigInt(service.y) - BigInt(guest.y));
        pairs += 1n;
      }
    }
    serviceDistance = safeNumber((total + pairs / 2n) / pairs, "服务距离");
  }
  return { constructionCostCents, capacity, guestAppealBps, privacyBps, serviceDistance };
}

function cellsForZone(cells: SpaceCell[], zoneId: string): SpaceCell[] {
  return cells.filter((cell) => cell.zoneId === zoneId);
}

function zonesAdjacent(cells: SpaceCell[], leftZoneId: string, rightZoneId: string): boolean {
  const right = new Set(cellsForZone(cells, rightZoneId).map(({ x, y }) => coordinateKey(x, y)));
  return cellsForZone(cells, leftZoneId).some(({ x, y }) =>
    right.has(coordinateKey(x - 1, y)) || right.has(coordinateKey(x + 1, y)) ||
    right.has(coordinateKey(x, y - 1)) || right.has(coordinateKey(x, y + 1)),
  );
}

function openingOnZone(draft: SpaceDraft, cells: SpaceCell[], zoneId: string): boolean {
  const coordinates = new Set(cellsForZone(cells, zoneId).map(({ x, y }) => coordinateKey(x, y)));
  return validBoundaryDoors(draft, cells).some(({ x, y }) => coordinates.has(coordinateKey(x, y)));
}

function validBoundaryDoors(draft: SpaceDraft, cells: SpaceCell[]): SpaceDraft["doors"] {
  const occupied = new Set(cells.map(({ x, y }) => coordinateKey(x, y)));
  const offsets = {
    north: [0, -1],
    east: [1, 0],
    south: [0, 1],
    west: [-1, 0],
  } as const;
  return draft.doors.slice(0, SPACE_EDITOR_MAX_OPENINGS).filter((door) => {
    const offset = offsets[door.side];
    if (!offset || !Number.isSafeInteger(door.x) || !Number.isSafeInteger(door.y) ||
        !occupied.has(coordinateKey(door.x, door.y))) return false;
    return !occupied.has(coordinateKey(door.x + offset[0], door.y + offset[1]));
  });
}

function itemAdjacentToZone(item: PlacedItem, cells: SpaceCell[], zoneId: string): boolean {
  return cellsForZone(cells, zoneId).some(({ x, y }) =>
    x >= item.x - 1 && x <= item.x + item.width &&
    y >= item.y - 1 && y <= item.y + item.height &&
    !(x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height),
  );
}

function hasContinuousPoolDeck(draft: SpaceDraft, cells: SpaceCell[]): boolean {
  const pools = draft.items.slice(0, SPACE_EDITOR_MAX_ITEMS).filter(
    (item) => item.catalogItemId === "item:pool" && validItemGeometry(draft, item),
  );
  if (pools.length === 0) return false;
  const deckKeys = new Set(cellsForZone(cells, "zone:deck").map(({ x, y }) => coordinateKey(x, y)));
  const deckConnected = validateSpaceConnectivity({
    ...draft,
    cells: cellsForZone(cells, "zone:deck"),
    items: [],
  }).connected;
  return deckConnected && pools.every((pool) => {
    const perimeterLength = (BigInt(pool.width) + 2n) * 2n + BigInt(pool.height) * 2n;
    if (perimeterLength > BigInt(SPACE_EDITOR_MAX_CELLS)) return false;
    for (let x = pool.x - 1; x <= pool.x + pool.width; x += 1) {
      if (!deckKeys.has(coordinateKey(x, pool.y - 1)) ||
          !deckKeys.has(coordinateKey(x, pool.y + pool.height))) return false;
    }
    for (let y = pool.y; y < pool.y + pool.height; y += 1) {
      if (!deckKeys.has(coordinateKey(pool.x - 1, y)) ||
          !deckKeys.has(coordinateKey(pool.x + pool.width, y))) return false;
    }
    return true;
  });
}

function validateStrategy(
  draft: SpaceDraft,
  definition: Readonly<SpaceTypeDefinition>,
  cells: SpaceCell[],
  validItems: Array<{ item: PlacedItem; rule: Readonly<SpaceItemRule> }>,
  blocking: PlanningIssue[],
): void {
  if (definition.strategy === "lobby") {
    if (!openingOnZone(draft, cells, "zone:entrance")) {
      blocking.push(issue("lobby-entry", "大堂必须设置入口"));
    }
    if (!zonesAdjacent(cells, "zone:entrance", "zone:reception")) {
      blocking.push(issue("lobby-entry-reception", "大堂入口必须连接接待区"));
    }
    if (!zonesAdjacent(cells, "zone:reception", "zone:waiting") ||
        !zonesAdjacent(cells, "zone:reception", "zone:luggage") ||
        !(zonesAdjacent(cells, "zone:waiting", "zone:elevator-lobby") ||
          zonesAdjacent(cells, "zone:luggage", "zone:elevator-lobby"))) {
      blocking.push(issue("lobby-flow", "大堂等候与行李动线必须连接电梯厅"));
    }
  }
  if (definition.strategy === "dining" || definition.strategy === "bar") {
    const serviceZone = definition.strategy === "bar" ? "zone:bar-service" : "zone:kitchen";
    const connectivity = validateSpaceConnectivity(draft);
    const serviceItem = validItems.find(({ rule }) => rule.role === "service")?.item;
    if (cells.some(({ zoneId }) => zoneId === serviceZone) && serviceItem &&
        (!connectivity.serviceRouteConnected ||
        !zonesAdjacent(cells, "zone:service-route", "zone:seating") ||
        !zonesAdjacent(cells, "zone:service-route", serviceZone) ||
        !itemAdjacentToZone(serviceItem, cells, "zone:service-route"))) {
      blocking.push(issue("dining-service-route", "餐饮服务路线必须连接服务区与座位区"));
    }
  }
  if (definition.strategy === "pool") {
    if (!hasContinuousPoolDeck(draft, cells)) {
      blocking.push(issue("pool-deck", "泳池必须设置连续池岸"));
    }
    if (cells.some(({ zoneId }) => zoneId === "zone:deck") &&
        !zonesAdjacent(cells, "zone:wet-route", "zone:deck")) {
      blocking.push(issue("pool-wet-route", "泳池湿区通道必须连接池岸"));
    }
    if (!openingOnZone(draft, cells, "zone:wet-route")) {
      blocking.push(issue("pool-access", "泳池必须设置安全通达入口"));
    }
  }
  if (definition.strategy === "spa") {
    const hasTreatmentBed = validItems.some(({ item }) => item.catalogItemId === "item:treatment-bed");
    if (!hasTreatmentBed || !cells.some(({ zoneId }) => zoneId === "zone:treatment") ||
        !cells.some(({ zoneId }) => zoneId === "zone:quiet") ||
        zonesAdjacent(cells, "zone:treatment", "zone:wet")) {
      blocking.push(issue("spa-privacy", "护理区私密性不足"));
    }
  }
  const egressCount = validBoundaryDoors(draft, cells).length;
  if (definition.strategy === "ballroom" && egressCount < 2) {
    blocking.push(issue("ballroom-egress", "宴会厅疏散出口不足"));
  }
  if (definition.strategy === "meeting" && egressCount < 1) {
    blocking.push(issue("meeting-egress", "会议空间疏散出口不足"));
  }
}

export function validatePublicSpace(draft: SpaceDraft): PublicSpaceValidation {
  const definition = definitionFor(draft);
  const blocking: PlanningIssue[] = [];
  const advisory: PlanningIssue[] = [];
  const editorValidation = validateSpaceDraft(draft);
  if (!editorValidation.ok) {
    editorValidation.reasons.forEach((message, index) => {
      blocking.push(issue(`editor:${index}`, message));
    });
  }
  const cells = normalizedValidCells(draft);
  const validItems = validCatalogItems(draft, definition, cells);
  for (const zoneId of definition.requiredZoneIds) {
    if (!cells.some((cell) => cell.zoneId === zoneId)) {
      if (definition.strategy === "dining" && zoneId === "zone:kitchen") {
        blocking.push(issue("dining-kitchen", "必须设置厨房或备餐区"));
      } else if (definition.strategy === "pool" && zoneId === "zone:deck") {
        // The strategy emits the actionable continuous-deck issue below.
      } else {
        blocking.push(issue(`required-zone:${zoneId}`, `缺少必需分区：${zoneId}`));
      }
    }
  }
  const knownZoneIds = new Set<string>(ZONE_CATALOG.map(({ id }) => id));
  const presentZoneIds = [...new Set(cells.map(({ zoneId }) => zoneId))].sort();
  for (const zoneId of presentZoneIds) {
    if (!knownZoneIds.has(zoneId)) {
      blocking.push(issue(`unknown-zone:${zoneId}`, `分区未在目录中定义：${zoneId}`));
    } else if (!definition.allowedZoneIds.includes(zoneId as never)) {
      blocking.push(issue(`disallowed-zone:${zoneId}`, `分区不适用于该空间：${zoneId}`));
    }
  }
  const knownItemIds = new Set<string>(ITEM_CATALOG.map(({ id }) => id));
  const boundedItems = draft.items.slice(0, SPACE_EDITOR_MAX_ITEMS);
  for (const item of [...boundedItems].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )) {
    if (!knownItemIds.has(item.catalogItemId)) {
      blocking.push(issue(`unknown-item:${item.catalogItemId}`, `物件未在目录中定义：${item.catalogItemId}`));
      continue;
    }
    const rule = itemRuleFor(definition, item);
    if (!rule) {
      blocking.push(issue(`item-not-permitted:${item.id}`, `物件 ${item.id} 不适用于该空间`));
    } else if (validItemGeometry(draft, item) && !itemInAllowedZone(draft, cells, item, rule)) {
      blocking.push(issue(`item-zone:${item.id}`, `物件 ${item.id} 必须放置于适用分区`));
    }
  }
  for (const itemId of definition.requiredItemIds) {
    if (!validItems.some(({ item }) => item.catalogItemId === itemId)) {
      blocking.push(issue(`required-item:${itemId}`, `缺少必需物件：${itemId}`));
    }
  }
  const metrics = calculateMetrics(draft, definition);
  if (metrics.capacity < definition.defaultCapacity.minimum) {
    blocking.push(issue(
      "minimum-capacity",
      `实际容量低于最低要求：${definition.defaultCapacity.minimum}`,
    ));
  }
  validateStrategy(draft, definition, cells, validItems, blocking);
  if (definition.metrics.serviceDistanceAdvisoryMaximum > 0 &&
      metrics.serviceDistance > definition.metrics.serviceDistanceAdvisoryMaximum) {
    advisory.push(issue("service-distance", "服务距离过长，建议优化服务动线"));
  }
  return { blocking, advisory, metrics };
}
