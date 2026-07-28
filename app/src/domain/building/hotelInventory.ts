import { prototypeConfig } from "../config/prototypeConfig";
import type { DesignGene, RoomVariant } from "../design/designTypes";
import type { FacilityState } from "../facilities/facilityTypes";
import type { GameState, RoomBlueprint } from "../game/state";
import type {
  RoomOfferUpgrade,
  RoomPricePolicy,
} from "../operations/operationsTypes";
import type { RoomOffer } from "../operations/roomOffer";
import type { GuestSegmentId } from "../operations/operationsTypes";
import type { BedType } from "../operations/segmentCatalog";
import type { RoomMaster } from "../design/roomSeries";
import type {
  ContentScaleState,
  HotelFloor,
  ScaleFloorTemplate,
  ScaleRoomPlacement,
} from "./buildingTypes";

export interface HotelInventoryRoom extends RoomOffer {
  floorId: string;
  floorNumber: number;
  localPlacementId: string;
  roomBlueprintId: string;
  pricePolicy?: RoomPricePolicy;
  upgrades: RoomOfferUpgrade[];
}

export interface HotelInventory {
  rooms: HotelInventoryRoom[];
  facilities: FacilityState[];
}

type RoomDesign = RoomBlueprint | RoomMaster;

const compareStableIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function geneText(gene?: DesignGene): string {
  if (!gene) return "";
  return [gene.palette, ...gene.materials, gene.metal, gene.lighting, gene.mood]
    .join(" ")
    .toLowerCase();
}

function hasAny(text: string, cues: string[]): boolean {
  return cues.some((cue) => text.includes(cue));
}

function deriveDesignAffinities(
  gene?: DesignGene,
): Record<GuestSegmentId, number> {
  const text = geneText(gene);
  const cultural = hasAny(text, [
    "culturally",
    "walnut",
    "natural stone",
    "hand-finished",
    "aged bronze",
  ]);
  const metropolitan = hasAny(text, [
    "metropolitan",
    "task lighting",
    "leather",
    "oak",
    "charcoal",
  ]);
  const resort = hasAny(text, [
    "nature",
    "rattan",
    "limestone",
    "daylight",
    "botanical",
  ]);

  return {
    business: metropolitan ? 8_500 : 5_000,
    couple: hasAny(text, ["private", "silk", "warm", "restful"])
      ? 7_500
      : 5_000,
    family: resort ? 6_500 : 5_000,
    leisure: resort || cultural ? 7_500 : 5_000,
    "high-net-worth": hasAny(text, [
      "refined",
      "composed",
      "luxury",
      "travertine",
    ])
      ? 8_000
      : 5_000,
    "cultural-experience": cultural ? 9_000 : 4_500,
  };
}

function uniqueCellArea(variant: RoomVariant): number {
  const uniqueCells = new Set(variant.cells.map(({ x, y }) => `${x},${y}`));
  return uniqueCells.size * prototypeConfig.cellAreaSquareMeters;
}

function variantBedType(variant: RoomVariant): BedType {
  if (variant.variantKind === "twin") return "twin";
  if (variant.variantKind === "king" || variant.variantKind === "corner") {
    return "king";
  }
  return "double";
}

function variantOffer(
  state: Readonly<GameState>,
  roomId: string,
  variant: Readonly<RoomVariant>,
  areaSquareMeters: number,
): RoomOffer {
  const text = geneText(variant.gene);
  const corner = variant.variantKind === "corner";
  const metropolitan = hasAny(text, [
    "metropolitan",
    "task lighting",
    "oak",
    "leather",
  ]);
  const quiet = hasAny(text, ["quiet", "private", "restful", "low-glare"]);

  return {
    id: `offer:${roomId}:${variant.id}`,
    sourceRoomId: roomId,
    variantId: variant.id,
    bedType: variantBedType(variant),
    capacity: variant.variantKind === "twin" ? 3 : 2,
    areaSquareMeters,
    nightlyRateCents: state.rateCents,
    viewBps: corner ? 9_000 : variant.overrides.includes("view") ? 7_500 : 5_500,
    workspaceBps: clampBps(metropolitan ? 8_500 : 5_000),
    quietBps: clampBps(quiet ? 8_000 : 5_500),
    privacyBps: clampBps(
      corner ? 8_000 : hasAny(text, ["private", "composed"]) ? 7_500 : 5_500,
    ),
    designAffinities: deriveDesignAffinities(variant.gene),
  };
}

function designGene(
  state: Readonly<GameState>,
  design: Readonly<RoomDesign>,
): DesignGene | undefined {
  return "gene" in design ? design.gene : state.phase2?.hotelGene;
}

function designOffer(
  state: Readonly<GameState>,
  roomId: string,
  design: Readonly<RoomDesign>,
  areaSquareMeters: number,
): RoomOffer {
  return {
    id: `offer:${roomId}:${design.id}`,
    sourceRoomId: roomId,
    bedType: "double",
    capacity: 2,
    areaSquareMeters,
    nightlyRateCents: state.rateCents,
    viewBps: design.openings?.windows.length ? 6_000 : 5_000,
    workspaceBps: clampBps(design.metrics.businessFitBps),
    quietBps: 5_500,
    privacyBps: 5_500,
    designAffinities: deriveDesignAffinities(designGene(state, design)),
  };
}

function lookupGroups<T extends { roomOfferId: string }>(
  record: Readonly<Record<string, T>>,
): Map<string, Array<{ key: string; value: T }>> {
  const groups = new Map<string, Array<{ key: string; value: T }>>();
  for (const [key, value] of Object.entries(record)) {
    const group = groups.get(value.roomOfferId) ?? [];
    group.push({ key, value });
    groups.set(value.roomOfferId, group);
  }
  return groups;
}

function roomWithReferences(
  offer: RoomOffer,
  details: Pick<
    HotelInventoryRoom,
    "floorId" | "floorNumber" | "localPlacementId" | "roomBlueprintId"
  >,
  policyMap: ReadonlyMap<string, RoomPricePolicy>,
  upgradeGroups: ReadonlyMap<
    string,
    Array<{ key: string; value: RoomOfferUpgrade }>
  >,
  strictPolicyReference = true,
): HotelInventoryRoom {
  const pricePolicy = policyMap.get(offer.id);
  if (strictPolicyReference && pricePolicy && pricePolicy.roomOfferId !== offer.id) {
    throw new Error("房价策略客房产品不匹配");
  }
  const upgrades = (upgradeGroups.get(offer.id) ?? [])
    .map(({ key, value }) => {
      if (value.kind !== undefined && key !== `${offer.id}:${value.kind}`) {
        throw new Error("已保存的改造键与内容不一致");
      }
      return structuredClone(value);
    })
    .sort((left, right) => compareStableIds(left.upgradeId, right.upgradeId));
  return {
    ...offer,
    ...details,
    ...(pricePolicy === undefined
      ? {}
      : { pricePolicy: structuredClone(pricePolicy) }),
    upgrades,
  };
}

function projectLegacyInventory(state: Readonly<GameState>): HotelInventory {
  const placements = new Map(
    (state.phase2?.floorPlacements ?? []).map((placement) => [
      placement.slotId,
      placement,
    ]),
  );
  const variants = new Map(
    (state.phase2?.roomVariants ?? []).map((variant) => [variant.id, variant]),
  );
  const policyMap = new Map(
    Object.entries(state.operations?.pricePolicies ?? {}),
  );
  const upgradeGroups = lookupGroups(state.operations?.offerUpgrades ?? {});
  const rooms: HotelInventoryRoom[] = [];

  for (const room of state.floor.rooms) {
    const placement = placements.get(room.slotId);
    const variant = placement ? variants.get(placement.variantId) : undefined;
    if (variant) {
      rooms.push(roomWithReferences(
        variantOffer(
          state,
          room.id,
          variant,
          variant.metrics?.areaSquareMeters ?? uniqueCellArea(variant),
        ),
        {
          floorId: state.floor.id,
          floorNumber: 1,
          localPlacementId: room.slotId,
          roomBlueprintId: room.roomBlueprintId,
        },
        policyMap,
        upgradeGroups,
        false,
      ));
      continue;
    }

    const blueprint = state.roomBlueprint;
    if (!blueprint || blueprint.id !== room.roomBlueprintId) continue;
    rooms.push(roomWithReferences(
      designOffer(
        state,
        room.id,
        blueprint,
        blueprint.metrics.areaSquareMeters,
      ),
      {
        floorId: state.floor.id,
        floorNumber: 1,
        localPlacementId: room.slotId,
        roomBlueprintId: room.roomBlueprintId,
      },
      policyMap,
      upgradeGroups,
      false,
    ));
  }

  return { rooms, facilities: [] };
}

function uniqueRecordMap<T extends { id: string }>(
  record: Readonly<Record<string, T>>,
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const [key, value] of Object.entries(record)) {
    if (key !== value.id) throw new Error(`${label}记录键与编号不匹配`);
    if (map.has(value.id)) throw new Error(`${label}编号冲突：${value.id}`);
    map.set(value.id, value);
  }
  return map;
}

function designMaps(state: Readonly<GameState>): {
  designs: Map<string, RoomDesign>;
  variants: Map<string, RoomVariant>;
} {
  const designs = new Map<string, RoomDesign>();
  const addDesign = (design: RoomDesign | null | undefined): void => {
    if (!design) return;
    if (designs.has(design.id)) throw new Error(`客房设计编号冲突：${design.id}`);
    designs.set(design.id, design);
  };
  addDesign(state.roomBlueprint);
  addDesign(state.phase2?.roomMaster);

  const variants = new Map<string, RoomVariant>();
  for (const variant of state.phase2?.roomVariants ?? []) {
    if (variants.has(variant.id)) throw new Error(`客房变体编号冲突：${variant.id}`);
    if (!designs.has(variant.masterId)) {
      throw new Error(`客房变体 ${variant.id} 引用了未知母版`);
    }
    variants.set(variant.id, variant);
  }
  return { designs, variants };
}

function appliedPlacementMaps(
  phase4: Readonly<ContentScaleState>,
  floors: readonly Readonly<HotelFloor>[],
  templates: ReadonlyMap<string, ScaleFloorTemplate>,
): Map<string, Map<string, ScaleRoomPlacement> | null> {
  const byFloor = new Map<string, Map<string, ScaleRoomPlacement> | null>();
  for (const floor of floors) {
    const canonical = templates.get(floor.templateId);
    if (!canonical) throw new Error(`楼层 ${floor.id} 引用了未知模板`);
    if (canonical.use !== floor.use) throw new Error(`楼层 ${floor.id} 的用途与模板不匹配`);
    const snapshotId = `template-snapshot:${floor.id}`;
    const applied = phase4.floorTemplates[snapshotId];
    if (!applied) {
      byFloor.set(floor.id, null);
      continue;
    }
    if (applied.use !== floor.use) {
      throw new Error(`楼层 ${floor.id} 的快照用途不匹配`);
    }
    const placements = new Map<string, ScaleRoomPlacement>();
    for (const placement of applied.roomPlacements) {
      if (placements.has(placement.id)) {
        throw new Error(`模板 ${applied.id} 的客房放置编号重复`);
      }
      placements.set(placement.id, placement);
    }
    byFloor.set(floor.id, placements);
  }
  return byFloor;
}

function projectPhase4Facilities(
  phase4: Readonly<ContentScaleState>,
  floorMap: ReadonlyMap<string, HotelFloor>,
): FacilityState[] {
  const blueprints = uniqueRecordMap(phase4.spaceBlueprints, "公共空间蓝图");
  const publicSpaces = uniqueRecordMap(phase4.publicSpaces, "公共空间");
  const facilities = uniqueRecordMap(phase4.facilities, "设施");
  for (const floor of floorMap.values()) {
    const listed = new Set<string>();
    for (const publicSpaceId of floor.publicSpaceInstanceIds) {
      if (listed.has(publicSpaceId)) throw new Error(`楼层 ${floor.id} 的公共空间编号重复`);
      listed.add(publicSpaceId);
      const instance = publicSpaces.get(publicSpaceId);
      if (!instance || instance.floorId !== floor.id) {
        throw new Error(`楼层 ${floor.id} 引用了不一致的公共空间`);
      }
    }
  }
  for (const instance of publicSpaces.values()) {
    const floor = floorMap.get(instance.floorId);
    const blueprint = blueprints.get(instance.blueprintId);
    if (!floor || !blueprint) throw new Error(`公共空间 ${instance.id} 引用了未知记录`);
    if (!floor.publicSpaceInstanceIds.includes(instance.id)) {
      throw new Error(`公共空间 ${instance.id} 缺少楼层引用`);
    }
    if (blueprint.type !== instance.type) throw new Error(`公共空间 ${instance.id} 类型不匹配`);
  }
  return [...facilities.values()]
    .sort((left, right) => compareStableIds(left.id, right.id))
    .map((facility) => {
      const instance = publicSpaces.get(facility.publicSpaceInstanceId);
      if (!instance) throw new Error(`设施 ${facility.id} 引用了未知公共空间`);
      if (instance.type !== facility.type) throw new Error(`设施 ${facility.id} 类型不匹配`);
      return structuredClone(facility);
    });
}

function projectPhase4Inventory(state: Readonly<GameState>): HotelInventory {
  const phase4 = state.phase4!;
  const floors = [...phase4.floors].sort(
    (left, right) =>
      left.floorNumber - right.floorNumber || compareStableIds(left.id, right.id),
  );
  const floorMap = new Map<string, HotelFloor>();
  for (const floor of floors) {
    if (floorMap.has(floor.id)) throw new Error(`楼层编号冲突：${floor.id}`);
    floorMap.set(floor.id, floor);
  }
  const purchasedIds = new Set(phase4.building.purchasedFloorIds);
  if (purchasedIds.size !== phase4.building.purchasedFloorIds.length) {
    throw new Error("已购楼层编号重复");
  }
  for (const floor of floors) {
    if (floor.purchased !== purchasedIds.has(floor.id)) {
      throw new Error(`楼层 ${floor.id} 的购买引用不一致`);
    }
  }

  const templates = uniqueRecordMap(phase4.floorTemplates, "楼层模板");
  const placementsByFloor = appliedPlacementMaps(phase4, floors, templates);
  const { designs, variants } = designMaps(state);
  const policyMap = new Map(Object.entries(state.operations?.pricePolicies ?? {}));
  const upgradeGroups = lookupGroups(state.operations?.offerUpgrades ?? {});
  const roomIds = new Set<string>();
  const rooms: HotelInventoryRoom[] = [];

  for (const floor of floors) {
    if (!floor.purchased) continue;
    const placements = placementsByFloor.get(floor.id)!;
    if (placements && placements.size !== floor.rooms.length) {
      throw new Error(`楼层 ${floor.id} 的快照客房集合不一致`);
    }
    for (const room of [...floor.rooms].sort((left, right) =>
      compareStableIds(left.id, right.id))) {
      if (roomIds.has(room.id)) throw new Error(`客房编号冲突：${room.id}`);
      roomIds.add(room.id);
      if (room.floorId !== floor.id) throw new Error(`客房 ${room.id} 的楼层引用不一致`);
      const placement = placements?.get(room.localPlacementId);
      if (placements && !placement) throw new Error(`客房 ${room.id} 引用了未知模板放置`);
      if (placement && (
        placement.roomBlueprintId !== room.roomBlueprintId ||
        placement.variantId !== room.variantId
      )) throw new Error(`客房 ${room.id} 的设计引用与楼层快照不一致`);
      const design = designs.get(room.roomBlueprintId);
      if (!design) throw new Error(`客房 ${room.id} 引用了未知客房设计`);
      let offer: RoomOffer;
      if (room.variantId !== undefined) {
        const variant = variants.get(room.variantId);
        if (!variant) throw new Error(`客房 ${room.id} 引用了未知客房变体`);
        if (variant.masterId !== room.roomBlueprintId) {
          throw new Error(`客房 ${room.id} 的母版与变体引用不一致`);
        }
        if (!variant.metrics) throw new Error(`客房 ${room.id} 的变体缺少权威面积`);
        offer = variantOffer(
          state,
          room.id,
          variant,
          variant.metrics.areaSquareMeters,
        );
      } else {
        offer = designOffer(
          state,
          room.id,
          design,
          design.metrics.areaSquareMeters,
        );
      }
      if (!Number.isSafeInteger(offer.areaSquareMeters) || offer.areaSquareMeters <= 0) {
        throw new Error(`客房 ${room.id} 的权威面积无效`);
      }
      rooms.push(roomWithReferences(
        offer,
        {
          floorId: floor.id,
          floorNumber: floor.floorNumber,
          localPlacementId: room.localPlacementId,
          roomBlueprintId: room.roomBlueprintId,
        },
        policyMap,
        upgradeGroups,
      ));
    }
  }

  return {
    rooms,
    facilities: projectPhase4Facilities(phase4, floorMap),
  };
}

export function projectHotelInventory(
  state: Readonly<GameState>,
): HotelInventory {
  return state.phase4 ? projectPhase4Inventory(state) : projectLegacyInventory(state);
}

export function projectHotelRoomOffers(
  state: Readonly<GameState>,
): RoomOffer[] {
  return projectHotelInventory(state).rooms.map((room) => ({
    id: room.id,
    sourceRoomId: room.sourceRoomId,
    ...(room.variantId === undefined ? {} : { variantId: room.variantId }),
    bedType: room.bedType,
    capacity: room.capacity,
    areaSquareMeters: room.areaSquareMeters,
    nightlyRateCents: room.nightlyRateCents,
    viewBps: room.viewBps,
    workspaceBps: room.workspaceBps,
    quietBps: room.quietBps,
    privacyBps: room.privacyBps,
    designAffinities: { ...room.designAffinities },
  }));
}

function reconciledPhase4References(
  phase4: Readonly<ContentScaleState>,
): ContentScaleState {
  const floors = phase4.floors.map((floor) => ({
    ...floor,
    rooms: floor.rooms.map((room) => ({ ...room })),
    publicSpaceInstanceIds: [] as typeof floor.publicSpaceInstanceIds,
  }));
  const floorMap = new Map(floors.map((floor) => [floor.id, floor]));
  if (floorMap.size !== floors.length) throw new Error("楼层编号冲突");
  const blueprintMap = uniqueRecordMap(phase4.spaceBlueprints, "公共空间蓝图");
  const publicSpaces = Object.fromEntries(
    Object.entries(phase4.publicSpaces)
      .sort(([left], [right]) => compareStableIds(left, right))
      .flatMap(([key, instance]) => {
        if (key !== instance.id) throw new Error("公共空间记录键与编号不匹配");
        const floor = floorMap.get(instance.floorId);
        const blueprint = blueprintMap.get(instance.blueprintId);
        if (!floor || !blueprint) return [];
        if (blueprint.type !== instance.type) throw new Error(`公共空间 ${instance.id} 类型不匹配`);
        floor.publicSpaceInstanceIds.push(instance.id);
        return [[key, structuredClone(instance)] as const];
      }),
  );
  for (const floor of floors) floor.publicSpaceInstanceIds.sort(compareStableIds);
  const facilities = Object.fromEntries(
    Object.entries(phase4.facilities)
      .sort(([left], [right]) => compareStableIds(left, right))
      .flatMap(([key, facility]) => {
        if (key !== facility.id) throw new Error("设施记录键与编号不匹配");
        const instance = publicSpaces[facility.publicSpaceInstanceId];
        if (!instance) return [];
        if (instance.type !== facility.type) throw new Error(`设施 ${facility.id} 类型不匹配`);
        return [[key, structuredClone(facility)] as const];
      }),
  );
  return {
    ...phase4,
    building: {
      ...phase4.building,
      skyLobbyFloorIds: [...phase4.building.skyLobbyFloorIds],
      purchasedFloorIds: [...phase4.building.purchasedFloorIds],
      availableExpansionFloorNumbers: [
        ...phase4.building.availableExpansionFloorNumbers,
      ],
    },
    floorTemplates: Object.fromEntries(
      Object.entries(phase4.floorTemplates).map(([key, template]) => [
        key,
        structuredClone(template),
      ]),
    ),
    floors,
    spaceBlueprints: Object.fromEntries(
      Object.entries(phase4.spaceBlueprints).map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
    ),
    publicSpaces,
    facilities,
    catalogProgress: structuredClone(phase4.catalogProgress),
    recentFlowSnapshot: structuredClone(phase4.recentFlowSnapshot),
  };
}

export function reconcileHotelReferences(
  state: Readonly<GameState>,
): GameState {
  const withPhase4: GameState = {
    ...state,
    ...(state.phase4 === undefined
      ? {}
      : { phase4: reconciledPhase4References(state.phase4) }),
  };
  const operations = withPhase4.operations;
  if (!operations) return withPhase4;
  const offers = projectHotelRoomOffers({
    ...withPhase4,
    operations: { ...operations, pricePolicies: {}, offerUpgrades: {} },
  });
  const offerIds = new Set(offers.map(({ id }) => id));
  const policiesById = new Map(Object.entries(operations.pricePolicies));
  for (const [key, policy] of policiesById) {
    if (key !== policy.roomOfferId) throw new Error("房价策略键与客房产品不匹配");
  }
  const pricePolicies = Object.fromEntries(offers.map((offer) => {
    const existing = policiesById.get(offer.id);
    return [offer.id, structuredClone(existing ?? {
      roomOfferId: offer.id,
      nightlyRateCents: offer.nightlyRateCents,
    })];
  }));
  const offerUpgrades = Object.fromEntries(
    Object.entries(operations.offerUpgrades)
      .sort(([left], [right]) => compareStableIds(left, right))
      .flatMap(([key, upgrade]) => {
        if (upgrade.kind === undefined) return [[key, structuredClone(upgrade)] as const];
        if (key !== `${upgrade.roomOfferId}:${upgrade.kind}`) {
          throw new Error("已保存的改造键与内容不一致");
        }
        return offerIds.has(upgrade.roomOfferId)
          ? [[key, structuredClone(upgrade)] as const]
          : [];
      }),
  );
  return {
    ...withPhase4,
    operations: {
      ...operations,
      pricePolicies,
      offerUpgrades,
    },
  };
}
