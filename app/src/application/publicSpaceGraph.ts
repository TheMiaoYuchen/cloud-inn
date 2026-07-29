import {
  assertStableId,
  type ContentScaleState,
  type HotelFloor,
  type ScaleFloorTemplate,
  type ScalePublicSpaceSlot,
  type StableId,
} from "../domain/building/buildingTypes";
import type {
  FacilityState,
  PublicSpaceBlueprint,
  PublicSpaceInstance,
  PublicSpaceType,
} from "../domain/facilities/facilityTypes";

export interface PublicSpaceGraph {
  floors: ReadonlyMap<StableId, Readonly<HotelFloor>>;
  instances: ReadonlyMap<StableId, Readonly<PublicSpaceInstance>>;
  facilities: ReadonlyMap<StableId, Readonly<FacilityState>>;
  blueprints: ReadonlyMap<StableId, Readonly<PublicSpaceBlueprint>>;
}

export interface PublicSpacePlacementProjection {
  floorIndex: number;
  floor: Readonly<HotelFloor>;
  templateId: StableId;
  template: Readonly<ScaleFloorTemplate>;
  slot: Readonly<ScalePublicSpaceSlot>;
  compatibleSlots: readonly Readonly<ScalePublicSpaceSlot>[];
  previous?: Readonly<PublicSpaceInstance>;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function appliedFloorTemplate(
  phase4: Readonly<ContentScaleState>,
  floor: Readonly<HotelFloor>,
): { templateId: StableId; template: Readonly<ScaleFloorTemplate> } | undefined {
  const snapshotId = `template-snapshot:${floor.id}` as StableId;
  const snapshot = phase4.floorTemplates[snapshotId];
  if (snapshot) return { templateId: snapshotId, template: snapshot };
  const template = phase4.floorTemplates[floor.templateId];
  return template ? { templateId: floor.templateId, template } : undefined;
}

function stableId(value: unknown, label: string): StableId {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}必须是非空稳定 ID`);
  }
  try {
    return assertStableId(value);
  } catch {
    throw new Error(`${label}不是有效稳定 ID`);
  }
}

export function assertPublicSpaceGraph(
  phase4: Readonly<ContentScaleState>,
): PublicSpaceGraph {
  const floors = new Map<StableId, Readonly<HotelFloor>>();
  for (const floor of phase4.floors) {
    const floorId = stableId(floor.id, "楼层编号");
    if (floors.has(floorId)) throw new Error("楼层编号重复");
    floors.set(floorId, floor);
  }

  const blueprints = new Map<StableId, Readonly<PublicSpaceBlueprint>>();
  for (const [key, blueprint] of Object.entries(phase4.spaceBlueprints)) {
    const blueprintId = stableId(blueprint?.id, "公共空间蓝图编号");
    if (key !== blueprintId) throw new Error("公共空间蓝图记录键与编号不一致");
    blueprints.set(blueprintId, blueprint);
  }

  const instances = new Map<StableId, Readonly<PublicSpaceInstance>>();
  const occupiedSlots = new Set<string>();
  for (const [key, instance] of Object.entries(phase4.publicSpaces)) {
    const instanceId = stableId(instance?.id, "公共空间实例编号");
    if (key !== instanceId) throw new Error("公共空间实例记录键与编号不一致");
    const floorId = stableId(instance.floorId, "公共空间楼层编号");
    const slotId = stableId(instance.localPlacementId, "公共空间槽位编号");
    const blueprintId = stableId(instance.blueprintId, "公共空间蓝图编号");
    const floor = floors.get(floorId);
    if (!floor) throw new Error("公共空间实例引用的楼层不存在");
    const template = appliedFloorTemplate(phase4, floor)?.template;
    if (!template || template.use !== floor.use) {
      throw new Error("公共空间实例引用的设施楼层模板无效");
    }
    const slots = template.publicSpaceSlots.filter(({ id }) => id === slotId);
    if (slots.length !== 1 || !slots[0].permittedTypes.includes(instance.type)) {
      throw new Error("公共空间实例的槽位或类型引用无效");
    }
    const blueprint = blueprints.get(blueprintId);
    if (!blueprint || blueprint.type !== instance.type) {
      throw new Error("公共空间实例的蓝图引用无效");
    }
    const occupancyKey = `${floorId}\u0000${slotId}`;
    if (occupiedSlots.has(occupancyKey)) throw new Error("同一公共空间槽位被重复占用");
    occupiedSlots.add(occupancyKey);
    instances.set(instanceId, instance);
  }

  const floorReferences = new Set<StableId>();
  for (const floor of phase4.floors) {
    const localReferences = new Set<StableId>();
    for (const rawInstanceId of floor.publicSpaceInstanceIds) {
      const instanceId = stableId(rawInstanceId, "楼层公共空间引用");
      if (localReferences.has(instanceId) || floorReferences.has(instanceId)) {
        throw new Error("楼层公共空间引用重复");
      }
      const instance = instances.get(instanceId);
      if (!instance || instance.floorId !== floor.id) {
        throw new Error("楼层包含悬空或错层的公共空间引用");
      }
      localReferences.add(instanceId);
      floorReferences.add(instanceId);
    }
  }
  for (const instanceId of instances.keys()) {
    if (!floorReferences.has(instanceId)) throw new Error("公共空间实例缺少楼层反向引用");
  }

  const facilities = new Map<StableId, Readonly<FacilityState>>();
  const facilityInstances = new Set<StableId>();
  for (const [key, facility] of Object.entries(phase4.facilities)) {
    const facilityId = stableId(facility?.id, "设施编号");
    if (key !== facilityId) throw new Error("设施记录键与编号不一致");
    const instanceId = stableId(facility.publicSpaceInstanceId, "设施公共空间实例编号");
    const instance = instances.get(instanceId);
    if (!instance || instance.type !== facility.type) throw new Error("设施公共空间引用无效");
    if (facilityInstances.has(instanceId)) throw new Error("公共空间实例关联了多个设施记录");
    facilityInstances.add(instanceId);
    facilities.set(facilityId, facility);
  }

  return { floors, instances, facilities, blueprints };
}

export function projectPublicSpacePlacement(
  phase4: Readonly<ContentScaleState>,
  floorId: string,
  type: PublicSpaceType,
): PublicSpacePlacementProjection {
  const graph = assertPublicSpaceGraph(phase4);
  const floorIndex = phase4.floors.findIndex(({ id }) => id === floorId);
  if (floorIndex < 0) throw new Error("目标楼层不存在");
  const floor = phase4.floors[floorIndex];
  if (floor.use !== "facility" && !(floor.use === "sky-lobby" && type === "sky-lobby")) {
    throw new Error("公共空间只能放置在适用的设施楼层");
  }
  if (!floor.purchased) throw new Error("目标设施楼层尚未购买");
  const applied = appliedFloorTemplate(phase4, floor);
  if (!applied || applied.template.use !== floor.use) {
    throw new Error("设施楼层模板引用无效");
  }
  const compatibleSlots = applied.template.publicSpaceSlots
    .filter(({ permittedTypes }) => permittedTypes.includes(type))
    .sort((left, right) => compareIds(left.id, right.id));
  if (compatibleSlots.length === 0) {
    throw new Error("设施楼层没有允许该类型的公共空间槽位");
  }
  const bySlot = new Map([...graph.instances.values()]
    .filter((instance) => instance.floorId === floor.id)
    .map((instance) => [instance.localPlacementId, instance]));
  const sameType = [...graph.facilities.values()].filter((facility) =>
    facility.type === type && graph.instances.get(facility.publicSpaceInstanceId)?.floorId === floor.id);
  if (sameType.length > 1) throw new Error("同一楼层存在多个同类型设施记录");
  const sameTypeInstance = sameType.length === 1
    ? graph.instances.get(sameType[0].publicSpaceInstanceId)
    : undefined;
  if (sameType.length === 1 && (!sameTypeInstance ||
      !compatibleSlots.some(({ id }) => id === sameTypeInstance.localPlacementId))) {
    throw new Error("同类型设施的公共空间槽位引用无效");
  }
  const slot = sameTypeInstance
    ? compatibleSlots.find(({ id }) => id === sameTypeInstance.localPlacementId)
    : compatibleSlots.find(({ id }) => !bySlot.has(id)) ??
      compatibleSlots.find(({ id }) => bySlot.has(id));
  if (!slot) throw new Error("设施楼层没有可用公共空间槽位");
  return {
    floorIndex,
    floor,
    templateId: applied.templateId,
    template: applied.template,
    slot,
    compatibleSlots,
    previous: bySlot.get(slot.id),
  };
}
