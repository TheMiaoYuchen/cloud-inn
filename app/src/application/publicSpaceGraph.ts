import {
  assertStableId,
  type ContentScaleState,
  type HotelFloor,
  type StableId,
} from "../domain/building/buildingTypes";
import type {
  FacilityState,
  PublicSpaceBlueprint,
  PublicSpaceInstance,
} from "../domain/facilities/facilityTypes";

export interface PublicSpaceGraph {
  floors: ReadonlyMap<StableId, Readonly<HotelFloor>>;
  instances: ReadonlyMap<StableId, Readonly<PublicSpaceInstance>>;
  facilities: ReadonlyMap<StableId, Readonly<FacilityState>>;
  blueprints: ReadonlyMap<StableId, Readonly<PublicSpaceBlueprint>>;
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
    const template = phase4.floorTemplates[floor.templateId];
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
