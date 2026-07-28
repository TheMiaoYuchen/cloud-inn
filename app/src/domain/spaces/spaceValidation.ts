import { FACILITY_CATALOG, ITEM_CATALOG, ZONE_CATALOG } from "../content/contentCatalog";
import { validateSpaceConnectivity, validateSpaceDraft } from "./spaceEditor";
import type { PlacedItem, PlanningIssue, PublicSpaceValidation, SpaceDraft } from "./spaceTypes";

const issue = (code: string, message: string): PlanningIssue => ({ code, message });
const hasZone = (draft: SpaceDraft, zoneId: string) => draft.cells.some((cell) => cell.zoneId === zoneId);

function manhattan(left: PlacedItem, right: PlacedItem): bigint {
  if (![left.x, left.y, right.x, right.y].every(Number.isSafeInteger)) return 0n;
  const horizontal = BigInt(left.x) - BigInt(right.x);
  const vertical = BigInt(left.y) - BigInt(right.y);
  return (horizontal < 0n ? -horizontal : horizontal) +
    (vertical < 0n ? -vertical : vertical);
}

function metrics(draft: SpaceDraft): PublicSpaceValidation["metrics"] {
  const definition = FACILITY_CATALOG.find(({ type }) => type === draft.type);
  if (!definition) throw new Error("公共空间类型未在目录中定义");
  const itemCost = 50_000n * BigInt(draft.items.length);
  const cellCost = 10_000n * BigInt(draft.cells.length);
  const constructionCost = BigInt(definition.constructionCostCents.minimum) + itemCost + cellCost;
  if (constructionCost > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("建造成本超出安全整数范围");
  const seats = draft.items.filter(({ catalogItemId }) =>
    catalogItemId.includes("seat") || catalogItemId.includes("table") || catalogItemId.includes("station"),
  ).length;
  const capacity = Math.min(
    definition.defaultCapacity.maximum,
    Math.max(definition.defaultCapacity.minimum, seats * 4),
  );
  const serviceItems = draft.items.filter(({ catalogItemId }) =>
    catalogItemId.includes("service") || catalogItemId.includes("reception") || catalogItemId.includes("bar-counter"),
  );
  const guestItems = draft.items.filter((item) => !serviceItems.includes(item));
  const distances = serviceItems.flatMap((service) => guestItems.map((guest) => manhattan(service, guest)));
  const distanceTotal = distances.reduce((sum, value) => sum + value, 0n);
  const serviceDistanceBigInt = distances.length === 0
    ? 0n
    : (distanceTotal + BigInt(Math.floor(distances.length / 2))) / BigInt(distances.length);
  if (serviceDistanceBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("服务距离超出安全整数范围");
  }
  const serviceDistance = Number(serviceDistanceBigInt);
  const privacyBps = draft.type === "spa" && draft.items.some((item) =>
    item.catalogItemId === "item:treatment-bed" && draft.cells.some((cell) =>
      cell.zoneId === "zone:wet" && Math.abs(cell.x - item.x) + Math.abs(cell.y - item.y) <= 1,
    ),
  ) ? 4_000 : 8_000;
  return {
    constructionCostCents: Number(constructionCost),
    capacity,
    guestAppealBps: Math.min(10_000, 5_000 + draft.items.length * 250),
    privacyBps,
    serviceDistance,
  };
}

function hasContinuousPoolDeck(draft: SpaceDraft): boolean {
  const pools = draft.items.filter(({ catalogItemId }) => catalogItemId === "item:pool");
  if (pools.length === 0) return false;
  const deckKeys = new Set(
    draft.cells.filter(({ zoneId }) => zoneId === "zone:deck").map(({ x, y }) => `${x},${y}`),
  );
  const deckConnected = validateSpaceConnectivity({
    ...draft,
    cells: draft.cells.filter(({ zoneId }) => zoneId === "zone:deck"),
  }).connected;
  return deckConnected && pools.every((pool) => {
    const perimeter: string[] = [];
    for (let x = pool.x - 1; x <= pool.x + pool.width; x += 1) {
      perimeter.push(`${x},${pool.y - 1}`, `${x},${pool.y + pool.height}`);
    }
    for (let y = pool.y; y < pool.y + pool.height; y += 1) {
      perimeter.push(`${pool.x - 1},${y}`, `${pool.x + pool.width},${y}`);
    }
    return perimeter.every((coordinate) => deckKeys.has(coordinate));
  });
}

function validateStrategy(draft: SpaceDraft, blocking: PlanningIssue[]): void {
  if (draft.type === "sky-lobby") {
    if (draft.doors.length === 0) blocking.push(issue("lobby-entry", "大堂必须设置入口"));
    if (!draft.items.some(({ catalogItemId }) => catalogItemId === "item:reception-desk")) {
      blocking.push(issue("lobby-reception", "大堂必须设置接待台"));
    }
  }
  if (["all-day-dining", "chinese-restaurant"].includes(draft.type) &&
      !hasZone(draft, "zone:kitchen")) {
    blocking.push(issue("dining-kitchen", "必须设置厨房或备餐区"));
  }
  if (draft.type === "bar" && !hasZone(draft, "zone:bar-service")) {
    blocking.push(issue("bar-service", "必须设置酒吧服务区"));
  }
  if (draft.type === "pool" && !hasContinuousPoolDeck(draft)) {
    blocking.push(issue("pool-deck", "泳池必须设置连续池岸"));
  }
  if (draft.type === "spa" && metrics(draft).privacyBps < 6_000) {
    blocking.push(issue("spa-privacy", "护理区私密性不足"));
  }
  if (draft.type === "ballroom" && draft.doors.length < 2) {
    blocking.push(issue("ballroom-egress", "宴会厅疏散出口不足"));
  }
}

export function validatePublicSpace(draft: SpaceDraft): PublicSpaceValidation {
  const definition = FACILITY_CATALOG.find(({ type }) => type === draft.type);
  if (!definition) throw new Error("公共空间类型未在目录中定义");
  const blocking: PlanningIssue[] = [];
  const advisory: PlanningIssue[] = [];
  const editorValidation = validateSpaceDraft(draft);
  if (!editorValidation.ok) {
    editorValidation.reasons.forEach((message, index) => {
      blocking.push(issue(`editor:${index}`, message));
    });
  }
  validateStrategy(draft, blocking);
  for (const zoneId of definition.requiredZoneIds) {
    const handledByStrategy = blocking.some(({ code }) =>
      code === "dining-kitchen" && zoneId === "zone:kitchen",
    );
    if (!handledByStrategy && !hasZone(draft, zoneId)) {
      blocking.push(issue(`required-zone:${zoneId}`, `缺少必需分区：${zoneId}`));
    }
  }
  const knownZones = new Set<string>([
    ...ZONE_CATALOG.map(({ id }) => id),
    "zone:deck",
    "zone:service-route",
    "zone:entrance",
    "zone:reception",
    "zone:waiting",
    "zone:luggage",
    "zone:elevator-lobby",
    "zone:treatment",
    "zone:wet-route",
    "zone:stage",
    "zone:partition",
  ]);
  for (const zoneId of [...new Set(draft.cells.map((cell) => cell.zoneId))].sort()) {
    if (!knownZones.has(zoneId)) {
      blocking.push(issue(`unknown-zone:${zoneId}`, `分区未在目录中定义：${zoneId}`));
    }
  }
  const knownItems = new Set<string>(ITEM_CATALOG.map(({ id }) => id));
  for (const item of draft.items) {
    if (!knownItems.has(item.catalogItemId)) {
      blocking.push(issue(`unknown-item:${item.catalogItemId}`, `物件未在目录中定义：${item.catalogItemId}`));
    } else if (!definition.permittedItemIds.includes(item.catalogItemId as never)) {
      blocking.push(issue(`item-not-permitted:${item.id}`, `物件 ${item.id} 不适用于该空间`));
    }
  }
  if (!draft.items.some(({ catalogItemId }) =>
    definition.permittedItemIds.includes(catalogItemId as never),
  )) {
    advisory.push(issue("recommended-item", "建议至少放置一件适用物件"));
  }
  if (draft.type === "sky-lobby" &&
      !draft.items.some(({ catalogItemId }) => catalogItemId === "item:lounge-seat")) {
    advisory.push(issue("lobby-waiting", "建议设置等候座位并靠近接待区"));
  }
  if (["all-day-dining", "chinese-restaurant", "bar"].includes(draft.type)) {
    const serviceItemIds = draft.type === "bar"
      ? ["item:bar-counter"]
      : ["item:service-counter"];
    if (!draft.items.some(({ catalogItemId }) => serviceItemIds.includes(catalogItemId))) {
      advisory.push(issue("service-point", "建议设置服务点并连接传菜路线"));
    }
  }
  return { blocking, advisory, metrics: metrics(draft) };
}
