import { prototypeConfig } from "../domain/config/prototypeConfig";
import type { DesignGene } from "../domain/design/designTypes";
import {
  applySelectedSync,
  createRoomMaster,
  createRoomVariants,
  previewMasterSync,
  type RoomMaster,
  type SyncChange,
} from "../domain/design/roomSeries";
import { placeRoom as planRoom } from "../domain/floor/planFloor";
import { getTransformedRoomSize } from "../domain/floor/corridorTemplate";
import type { CorridorTemplate } from "../domain/design/designTypes";
import type { Cell, GameState } from "../domain/game/state";
import { createRoomDraft, validateRoomDraft, type Opening } from "../domain/room/editRoom";
import { assertSafeMoney } from "../domain/primitives";
import { evaluateRoom } from "../domain/room/evaluateRoom";
import { settleDay } from "../domain/simulation/settleDay";
import type { SavePort } from "./ports/SavePort";
import type { VisualProvider } from "./ports/VisualProvider";
import { requestRoomVisual } from "./requestRoomVisual";
import {
  DesignVisualQueue,
  type DesignVisualProvider,
} from "./designVisualQueue";
import type { PersistedDesignVisuals } from "../domain/game/state";
import { createOperationsState } from "../domain/operations/createOperationsState";
import type { Difficulty, OperationsState } from "../domain/operations/operationsTypes";
import {
  effectiveRate,
  seasonForGameDay,
  validatePricePolicy,
  type PricePolicy,
  type PricingContext,
} from "../domain/operations/pricing";
import { projectRoomOffers } from "../domain/operations/roomOffer";

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.trunc(value)));
}

function pricingContext(state: Readonly<GameState>): PricingContext {
  const recentReports = state.reports.slice(-7);
  const availableRooms = recentReports.reduce(
    (total, report) => total + report.availableRooms,
    0,
  );
  const soldRooms = recentReports.reduce(
    (total, report) => total + report.soldRooms,
    0,
  );
  const occupancyBps = availableRooms === 0
    ? 5_000
    : Math.trunc((soldRooms * 10_000) / availableRooms);
  const latestReport = recentReports[recentReports.length - 1];
  const remainingInventoryBps = !latestReport || latestReport.availableRooms === 0
    ? 5_000
    : Math.trunc(
        ((latestReport.availableRooms - latestReport.soldRooms) * 10_000) /
          latestReport.availableRooms,
      );
  const operationsReports = state.operations?.dailyReports.slice(-7) ?? [];
  const totalDemand = operationsReports.reduce(
    (total, report) =>
      total + report.segments.reduce((dayTotal, segment) => dayTotal + segment.demand, 0),
    0,
  );
  const demandCapacity = state.floor.rooms.length * operationsReports.length;

  return {
    season: seasonForGameDay(state.currentDay),
    trailingSevenDayOccupancyBps: clampBps(occupancyBps),
    segmentDemandBps: demandCapacity === 0
      ? 5_000
      : clampBps(Math.trunc((totalDemand * 10_000) / demandCapacity)),
    reputationBps: clampBps(state.operations?.reputationBps ?? 5_000),
    remainingInventoryBps: clampBps(remainingInventoryBps),
  };
}

function offerIds(state: Readonly<GameState>): string[] {
  const projected = projectRoomOffers(state).map(({ id }) => id);
  if (projected.length > 0) return projected;
  return state.roomBlueprint ? [`offer:legacy:${state.roomBlueprint.id}`] : [];
}

function defaultPolicy(
  roomOfferId: string,
  baseRateCents: number,
  context: Readonly<PricingContext>,
): PricePolicy {
  const policy: PricePolicy = {
    roomOfferId,
    baseRateCents,
    minRateCents: Math.max(1, Math.trunc(baseRateCents / 2)),
    maxRateCents: assertSafeMoney(baseRateCents * 2),
    automaticPricing: true,
    nightlyRateCents: baseRateCents,
  };
  return { ...policy, nightlyRateCents: effectiveRate(policy, context) };
}

function asPricePolicy(
  existing: OperationsState["pricePolicies"][string] | undefined,
  roomOfferId: string,
  legacyRateCents: number,
  context: Readonly<PricingContext>,
): PricePolicy {
  if (
    existing &&
    "baseRateCents" in existing &&
    "minRateCents" in existing &&
    "maxRateCents" in existing &&
    "automaticPricing" in existing
  ) {
    const policy = existing as PricePolicy;
    validatePricePolicy(policy);
    return { ...policy, nightlyRateCents: effectiveRate(policy, context) };
  }
  return defaultPolicy(roomOfferId, existing?.nightlyRateCents ?? legacyRateCents, context);
}

export function createGameCommands(savePort: SavePort) {
  async function persist(
    current: GameState,
    changed: GameState,
  ): Promise<GameState> {
    const next: GameState = {
      ...changed,
      revision: current.revision + 1,
    };
    await savePort.commit(current.revision, next);
    return next;
  }

  return {
    async initializeOperations(
      state: GameState,
      difficulty: Difficulty = "casual",
    ): Promise<GameState> {
      if (difficulty !== "casual" && difficulty !== "management") {
        throw new Error("经营难度无效");
      }
      const current = state.operations ?? createOperationsState(difficulty);
      const context = pricingContext({ ...state, operations: current });
      const pricePolicies = { ...current.pricePolicies };
      for (const roomOfferId of offerIds(state)) {
        pricePolicies[roomOfferId] = asPricePolicy(
          pricePolicies[roomOfferId],
          roomOfferId,
          state.rateCents,
          context,
        );
      }
      return persist(state, {
        ...state,
        operations: { ...current, pricePolicies },
      });
    },

    async setRoomPricePolicy(
      state: GameState,
      input: Readonly<PricePolicy>,
    ): Promise<GameState> {
      validatePricePolicy(input);
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      if (!offerIds(state).includes(input.roomOfferId)) {
        throw new Error("客房产品不存在");
      }
      const policy: PricePolicy = {
        ...structuredClone(input),
        nightlyRateCents: effectiveRate(input, pricingContext(state)),
      };
      return persist(state, {
        ...state,
        operations: {
          ...operations,
          pricePolicies: {
            ...operations.pricePolicies,
            [policy.roomOfferId]: policy,
          },
        },
      });
    },

    async setAutomaticPricing(
      state: GameState,
      roomOfferId: string,
      automaticPricing: boolean,
    ): Promise<GameState> {
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      if (!offerIds(state).includes(roomOfferId)) throw new Error("客房产品不存在");
      if (typeof automaticPricing !== "boolean") throw new Error("自动定价开关无效");
      const existing = operations.pricePolicies[roomOfferId];
      if (!existing) throw new Error("房价策略不存在");
      const current = asPricePolicy(
        existing,
        roomOfferId,
        state.rateCents,
        pricingContext(state),
      );
      const policy: PricePolicy = {
        ...current,
        automaticPricing,
        nightlyRateCents: current.baseRateCents,
      };
      policy.nightlyRateCents = effectiveRate(policy, pricingContext(state));
      return persist(state, {
        ...state,
        operations: {
          ...operations,
          pricePolicies: {
            ...operations.pricePolicies,
            [roomOfferId]: policy,
          },
        },
      });
    },

    async saveRoomSeries(
      state: GameState,
      input: {
        id: string;
        name: string;
        cells: Cell[];
        gene: DesignGene;
        openings?: { walls: Opening[]; doors: Opening[]; windows: Opening[] };
      },
    ): Promise<GameState> {
      if (state.phase !== "design") {
        throw new Error("当前不能修改客房系列");
      }
      const roomMaster = createRoomMaster({
        ...input,
        columns: prototypeConfig.roomColumns,
        rows: prototypeConfig.roomRows,
      });
      const phase2 = {
        hotelGene: structuredClone(input.gene),
        roomMaster,
        roomVariants: createRoomVariants(roomMaster),
        corridorTemplate: state.phase2?.corridorTemplate ?? null,
      };
      return persist(state, { ...state, phase2 });
    },

    async syncRoomSeries(
      state: GameState,
      changedMaster: RoomMaster,
      changes: SyncChange[],
    ): Promise<GameState> {
      const phase2 = state.phase2;
      if (!phase2?.roomMaster) {
        throw new Error("请先创建客房母版");
      }
      if (changedMaster.id !== phase2.roomMaster.id) {
        throw new Error("母版与客房系列不匹配");
      }
      const legalChanges = previewMasterSync(
        phase2.roomMaster,
        changedMaster,
        phase2.roomVariants,
      );
      const legalById = new Map(legalChanges.map((change) => [change.id, change]));
      if (changes.some((change) => !legalById.has(change.id))) {
        throw new Error("同步选项已过期，请重新预览");
      }
      const normalizedChanges = changes.map(change => ({ ...legalById.get(change.id)!, selected: change.selected }));
      const roomMaster = createRoomMaster({
        id: changedMaster.id,
        name: changedMaster.name,
        cells: changedMaster.cells,
        columns: changedMaster.columns,
        rows: changedMaster.rows,
        gene: changedMaster.gene,
        openings: changedMaster.openings,
      });
      const roomVariants = applySelectedSync(
        roomMaster,
        phase2.roomVariants,
        normalizedChanges,
      );
      const { designVisuals: _staleVisuals, ...phase2WithoutVisuals } = phase2;
      const nextPhase2 = legalChanges.length > 0 ? phase2WithoutVisuals : phase2;
      return persist(state, {
        ...state,
        phase2: { ...nextPhase2, roomMaster, roomVariants },
      });
    },

    async chooseCorridorTemplate(state: GameState, corridorTemplate: CorridorTemplate): Promise<GameState> {
      if (!state.phase2) throw new Error("请先创建客房系列");
      if (state.floor.rooms.length > 0 || (state.phase2.floorPlacements?.length ?? 0) > 0) {
        throw new Error("已有客房施工，不能切换环廊模板");
      }
      return persist(state, { ...state, phase2: { ...state.phase2, corridorTemplate: structuredClone(corridorTemplate), floorPlacements: [] } });
    },

    async placeRoomVariant(state: GameState, input: { slotId: string; variantId: string; rotation: 0|90|180|270; mirrored: boolean }): Promise<GameState> {
      const phase2 = state.phase2;
      const template = phase2?.corridorTemplate;
      if (!phase2 || !template) throw new Error("请先选择环廊模板");
      const slot = template.slots.find(slot => slot.id === input.slotId);
      if (!slot) throw new Error("房间槽位无效");
      const variant = phase2.roomVariants.find(item => item.id === input.variantId);
      if (!variant?.metrics || !state.roomBlueprint) throw new Error("客房变体无效");
      const footprint = getTransformedRoomSize(variant.cells, input.rotation);
      if (footprint.width > slot.width || footprint.height > slot.height) {
        throw new Error(`客房尺寸 ${footprint.width}×${footprint.height} 超出槽位 ${slot.width}×${slot.height}`);
      }
      const existingRoom = state.floor.rooms.find(room=>room.slotId===input.slotId);
      const refundedCash = state.cashCents + (existingRoom?.committedBuildCostCents ?? 0);
      if (refundedCash < variant.metrics.buildCostCents) throw new Error("资金不足，设计已保留");
      const floorPlacements = [...(phase2.floorPlacements ?? []).filter(item => item.slotId !== input.slotId), structuredClone(input)];
      const room = { id:`room-${input.slotId}`, slotId:input.slotId, roomBlueprintId:state.roomBlueprint.id, committedBuildCostCents:variant.metrics.buildCostCents };
      const rooms=[...state.floor.rooms.filter(item=>item.slotId!==input.slotId),room];
      return persist(state, { ...state, phase:rooms.length?'ready':'floor', cashCents:refundedCash-variant.metrics.buildCostCents, floor:{...state.floor,rooms}, phase2: { ...phase2, floorPlacements } });
    },

    async saveRoomBlueprint(
      state: GameState,
      name: string,
      cells: Cell[],
      openings: { walls: Opening[]; doors: Opening[]; windows: Opening[] } = {
        walls: [],
        doors: [],
        windows: [],
      },
    ): Promise<GameState> {
      if (state.phase !== "design") {
        throw new Error("当前不能修改房型");
      }
      const trimmedName = name.trim();
      if (trimmedName.length === 0) {
        throw new Error("房型名称不能为空");
      }

      const blueprintCells = structuredClone(cells);
      const blueprintOpenings = structuredClone(openings);
      const validation = validateRoomDraft({
        ...createRoomDraft(
          blueprintCells,
          prototypeConfig.roomColumns,
          prototypeConfig.roomRows,
        ),
        ...blueprintOpenings,
      });
      if (!validation.ok) throw new Error(validation.reason);
      const metrics = evaluateRoom(
        blueprintCells,
        prototypeConfig.roomColumns,
        prototypeConfig.roomRows,
      );
      return persist(state, {
        ...state,
        phase: "floor",
        roomBlueprint: {
          id: "room-type-1",
          name: trimmedName,
          columns: prototypeConfig.roomColumns,
          rows: prototypeConfig.roomRows,
          cells: blueprintCells,
          openings: blueprintOpenings,
          metrics,
          visual: { status: "idle" },
        },
      });
    },

    async placeRoom(state: GameState, slotId: string): Promise<GameState> {
      if (!state.roomBlueprint) {
        throw new Error("请先保存房型");
      }
      if (state.phase !== "floor" && state.phase !== "ready") {
        throw new Error("当前不能布置楼层");
      }

      const currentCashCents = assertSafeMoney(state.cashCents);
      const placed = planRoom(state.floor.rooms, state.roomBlueprint, slotId);
      if (currentCashCents < placed.costCents) {
        throw new Error("资金不足，设计已保留");
      }
      const cashCents = assertSafeMoney(currentCashCents - placed.costCents);
      return persist(state, {
        ...state,
        phase: placed.rooms.length > 0 ? "ready" : "floor",
        cashCents,
        floor: { ...state.floor, rooms: placed.rooms },
      });
    },

    async setRate(state: GameState, rateCents: number): Promise<GameState> {
      if (!Number.isSafeInteger(rateCents) || rateCents <= 0) {
        throw new Error("房价必须大于零");
      }
      const safeRateCents = assertSafeMoney(rateCents);
      if (!state.roomBlueprint) {
        throw new Error("请先保存房型");
      }

      return persist(state, { ...state, rateCents: safeRateCents });
    },

    async requestVisual(
      state: GameState,
      provider: VisualProvider,
    ): Promise<GameState> {
      if (!state.roomBlueprint) {
        throw new Error("请先保存房型");
      }

      const roomBlueprint = await requestRoomVisual(state.roomBlueprint, provider);
      return persist(state, { ...state, roomBlueprint });
    },

    async requestDesignVisuals(
      state: GameState,
      provider: DesignVisualProvider,
      focuses: string[] = ["bathroom", "lighting", "view"],
    ): Promise<GameState> {
      const phase2 = state.phase2;
      if (!phase2?.roomMaster) {
        throw new Error("请先保存客房系列");
      }
      const result = await new DesignVisualQueue(provider).enqueue(
        phase2.roomMaster,
        [
          { kind: "master" },
          ...focuses.map((focus) => ({ kind: "focus" as const, focus })),
        ],
      );
      const designVisuals: PersistedDesignVisuals = {
        status: result.status,
        assets: structuredClone(result.assets),
        errors: structuredClone(result.errors),
      };
      return persist(state, {
        ...state,
        phase2: { ...phase2, designVisuals },
      });
    },

    async openHotel(state: GameState): Promise<GameState> {
      if (state.floor.rooms.length === 0) {
        throw new Error("至少建造一间客房才能开业");
      }
      if (state.phase !== "ready") {
        throw new Error("当前不能开业");
      }

      return persist(state, { ...state, phase: "open" });
    },

    async advanceDay(state: GameState): Promise<GameState> {
      if (state.phase !== "open" || !state.roomBlueprint) {
        throw new Error("酒店尚未开业");
      }

      const report = settleDay({
        day: state.currentDay + 1,
        cashCents: state.cashCents,
        availableRooms: state.floor.rooms.length,
        rateCents: state.rateCents,
        suggestedRateCents: state.roomBlueprint.metrics.suggestedRateCents,
        areaSquareMeters: state.roomBlueprint.metrics.areaSquareMeters,
      });
      return persist(state, {
        ...state,
        currentDay: report.day,
        cashCents: report.endingCashCents,
        reports: [...state.reports, report],
        latestReport: report,
      });
    },
  };
}
