type JsonObject = Record<string, unknown>;

const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9:-]{0,95}$/;

function phase4Error(detail: string): never {
  throw new Error(`浏览器存档已损坏：内容规模存档${detail}`);
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    phase4Error(`${label}结构无效`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) phase4Error(`${label}结构无效`);
  return value;
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    phase4Error(`${label}必须是稳定 ID`);
  }
  return value;
}

function constructionMoney(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    phase4Error("施工金额必须是安全整数");
  }
}

function validateStableIds(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(validateStableIds);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (key === "id" || key.endsWith("Id")) {
      stableId(child, key);
    } else if (key.endsWith("Ids") || key === "reasonCodes") {
      for (const id of array(child, key)) stableId(id, key);
    }
    validateStableIds(child);
  }
}

function validateIdentityRecord(
  value: unknown,
  label: string,
): void {
  const entries = Object.entries(object(value, label));
  const ids = new Set<string>();
  for (const [key, rawDefinition] of entries) {
    stableId(key, "记录键");
    const definition = object(rawDefinition, label);
    const id = stableId(definition.id, `${label}编号`);
    if (ids.has(id)) phase4Error(`${label}编号重复`);
    ids.add(id);
  }
  for (const [key, rawDefinition] of entries) {
    if (object(rawDefinition, label).id !== key) {
      phase4Error("记录键与编号不一致");
    }
  }
}

function requireCollections(phase4: JsonObject): void {
  object(phase4.building, "建筑");
  object(phase4.floorTemplates, "楼层模板");
  array(phase4.floors, "楼层");
  object(phase4.spaceBlueprints, "公共空间蓝图");
  object(phase4.publicSpaces, "公共空间");
  object(phase4.facilities, "设施");
  object(phase4.catalogProgress, "目录进度");
  if (
    !("recentFlowSnapshot" in phase4) ||
    !(phase4.recentFlowSnapshot === null ||
      (typeof phase4.recentFlowSnapshot === "object" &&
        !Array.isArray(phase4.recentFlowSnapshot)))
  ) {
    phase4Error("近期流动快照结构无效");
  }
}

export function validatePhase4State(value: unknown): void {
  const phase4 = object(value, "状态");
  if (phase4.rulesetVersion !== "content-scale-v1") {
    phase4Error("规则版本无效");
  }
  requireCollections(phase4);
  validateStableIds(phase4);
  validateIdentityRecord(phase4.floorTemplates, "楼层模板");
  validateIdentityRecord(phase4.spaceBlueprints, "公共空间蓝图");
  validateIdentityRecord(phase4.publicSpaces, "公共空间");
  validateIdentityRecord(phase4.facilities, "设施");

  const floorIds = new Set<string>();
  const roomIds = new Set<string>();
  const roomOwners: Array<{ floorId: string; containingFloorId: string }> = [];
  for (const rawFloor of array(phase4.floors, "楼层")) {
    const floor = object(rawFloor, "楼层");
    const floorId = stableId(floor.id, "楼层编号");
    if (floorIds.has(floorId)) phase4Error("楼层编号重复");
    floorIds.add(floorId);

    for (const rawRoom of array(floor.rooms, "客房")) {
      const room = object(rawRoom, "客房");
      const roomId = stableId(room.id, "客房编号");
      if (roomIds.has(roomId)) phase4Error("客房编号重复");
      roomIds.add(roomId);
      roomOwners.push({
        floorId: stableId(room.floorId, "客房楼层编号"),
        containingFloorId: floorId,
      });
      constructionMoney(room.committedBuildCostCents);
    }
  }
  if (roomOwners.some(({ floorId }) => !floorIds.has(floorId))) {
    phase4Error("客房楼层引用无效");
  }
  if (roomOwners.some(({ floorId, containingFloorId }) => floorId !== containingFloorId)) {
    phase4Error("客房必须属于所在楼层");
  }

  for (const rawSpace of Object.values(
    object(phase4.publicSpaces, "公共空间"),
  )) {
    const space = object(rawSpace, "公共空间");
    constructionMoney(space.committedBuildCostCents);
  }

  for (const rawBlueprint of Object.values(
    object(phase4.spaceBlueprints, "公共空间蓝图"),
  )) {
    const blueprint = object(rawBlueprint, "公共空间蓝图");
    constructionMoney(blueprint.committedBuildCostCents);
  }
}
