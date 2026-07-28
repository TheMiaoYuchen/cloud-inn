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
  validatePricePolicy,
  type PricePolicy,
  type PricingContext,
} from "../domain/operations/pricing";
import { pricingContextForState } from "./pricingContextForState";
import { projectRoomOffers, type RoomOffer } from "../domain/operations/roomOffer";
import {
  calculateTrainingCostCents,
  validateDepartmentConfiguration,
  type DepartmentConfiguration,
} from "../domain/operations/departmentCatalog";
import { settleOperationsDay } from "../domain/operations/settleOperationsDay";
import { projectPeriodicReports } from "../domain/operations/reporting";
import { offlineDaysForElapsed } from "../domain/operations/offlineSettlement";
import {
  applyLoanRepayment,
  coverCasualShortfall,
  createLoan,
  DEPARTMENT_TRAINING_SAFETY_LOAN_ID,
  ROOM_RENOVATION_SAFETY_LOAN_ID,
  type LoanRequest,
} from "../domain/operations/finance";
import {
  previewRoomOfferUpgrade,
  roomOfferUpgradeKey,
  roomOfferRenovationKind,
  validateRoomOfferUpgrades,
  type RoomOfferUpgradeRequest,
  type RoomRenovationPreview,
} from "../domain/operations/renovation";
import { createBuildingCommands } from "./buildingCommands";

export function previewRoomRenovation(
  state: Readonly<GameState>,
  input: Readonly<RoomOfferUpgradeRequest>,
): RoomRenovationPreview {
  const operations = state.operations;
  if (!operations) throw new Error("经营系统尚未初始化");
  const offers = projectRoomOffers(state);
  validateRoomOfferUpgrades(offers, operations);
  const baseOffer = offers.find(({ id }) => id === input.roomOfferId);
  if (!baseOffer) throw new Error("客房产品不存在");
  const policy = operations.pricePolicies[baseOffer.id];
  if (policy && policy.roomOfferId !== baseOffer.id) throw new Error("房价策略客房产品不匹配");
  if (policy && "baseRateCents" in policy) validatePricePolicy(policy as PricePolicy);
  if (policy && (!Number.isSafeInteger(policy.nightlyRateCents) || policy.nightlyRateCents < 0)) {
    throw new Error("当前房价必须是非负整数分");
  }
  const offer = {
    ...baseOffer,
    nightlyRateCents: policy?.nightlyRateCents ?? baseOffer.nightlyRateCents,
  };
  return previewRoomOfferUpgrade(offer, operations, input);
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
  const doubledBaseRate = BigInt(baseRateCents) * 2n;
  const maximumSafeRate = BigInt(Number.MAX_SAFE_INTEGER);
  const policy: PricePolicy = {
    roomOfferId,
    baseRateCents,
    minRateCents: Math.max(1, Math.trunc(baseRateCents / 2)),
    maxRateCents: Number(
      doubledBaseRate > maximumSafeRate ? maximumSafeRate : doubledBaseRate,
    ),
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
    const policy: PricePolicy = {
      ...(existing as PricePolicy),
      roomOfferId,
    };
    validatePricePolicy(policy);
    return { ...policy, nightlyRateCents: effectiveRate(policy, context) };
  }
  return defaultPolicy(roomOfferId, existing?.nightlyRateCents ?? legacyRateCents, context);
}

function withReconciledPricePolicies(
  previous: Readonly<GameState>,
  state: GameState,
): GameState {
  const operations = state.operations;
  if (!operations) return state;

  const context = pricingContextForState(state);
  const pricePolicies: OperationsState["pricePolicies"] = {};
  const offers = projectRoomOffers(state);
  const placeholderId = previous.roomBlueprint
    ? `offer:legacy:${previous.roomBlueprint.id}`
    : null;
  const placeholder = placeholderId
    ? operations.pricePolicies[placeholderId]
    : undefined;
  const migratedOfferId = projectRoomOffers(previous).length === 0 && placeholder
    ? offers[0]?.id
    : undefined;

  for (const offer of offers) {
    const existing = operations.pricePolicies[offer.id];
    pricePolicies[offer.id] = existing
      ?? (offer.id === migratedOfferId
        ? asPricePolicy(placeholder, offer.id, offer.nightlyRateCents, context)
        : defaultPolicy(offer.id, offer.nightlyRateCents, context));
  }

  return {
    ...state,
    operations: { ...operations, pricePolicies },
  };
}

function operationsWithCurrentAutomaticRates(
  state: Readonly<GameState>,
  offers: ReadonlyArray<Readonly<RoomOffer>>,
): OperationsState {
  const operations = state.operations;
  if (!operations) throw new Error("经营系统尚未初始化");
  const context = pricingContextForState(state);
  const pricePolicies = { ...operations.pricePolicies };

  for (const offer of offers) {
    const existing = pricePolicies[offer.id];
    if (!existing) continue;
    if (existing.roomOfferId !== offer.id) throw new Error("房价策略客房产品不匹配");
    if (
      "baseRateCents" in existing
      && "minRateCents" in existing
      && "maxRateCents" in existing
      && "automaticPricing" in existing
    ) {
      const policy = existing as PricePolicy;
      validatePricePolicy(policy);
      pricePolicies[offer.id] = policy.automaticPricing
        ? { ...policy, nightlyRateCents: effectiveRate(policy, context) }
        : { ...policy };
    } else {
      if (!Number.isSafeInteger(existing.nightlyRateCents) || existing.nightlyRateCents < 0) {
        throw new Error("当前房价必须是非负整数分");
      }
      pricePolicies[offer.id] = { ...existing };
    }
  }

  return { ...operations, pricePolicies };
}

const MAX_OPERATIONS_DAY = 30;

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

  function assertNowMs(nowMs: number, label = "离线检查点"): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error(`${label}必须是非负安全整数`);
    }
  }

  function projectOperationsDay(state: GameState, nowMs: number): GameState {
    if (state.phase !== "open" || !state.roomBlueprint) {
      throw new Error("酒店尚未开业");
    }
    const operations = state.operations;
    if (!operations) throw new Error("经营系统尚未初始化");
    if (state.currentDay >= MAX_OPERATIONS_DAY) throw new Error("经营模拟已到第 30 日终点");
    assertNowMs(nowMs, "日结时间");
    if (
      operations.lastOfflineCheckpointMs !== null
      && nowMs < operations.lastOfflineCheckpointMs
    ) throw new Error("离线检查点不能倒退");
    const offers = projectRoomOffers(state);
    const pricedOperations = operationsWithCurrentAutomaticRates(state, offers);
    const settled = settleOperationsDay({
      day: state.currentDay + 1,
      cashCents: state.cashCents,
      operations: pricedOperations,
      offers,
    });
    const periodic = projectPeriodicReports(settled.operations);
    const nextOperations: OperationsState = {
      ...settled.operations,
      ...periodic,
      timeSpeed: settled.report.day === MAX_OPERATIONS_DAY ? 0 : settled.operations.timeSpeed,
      lastOfflineCheckpointMs: nowMs,
    };
    return {
      ...state,
      currentDay: settled.report.day,
      cashCents: settled.cashCents,
      operations: nextOperations,
      reports: [...state.reports, settled.legacyReport],
      latestReport: settled.legacyReport,
    };
  }

  return {
    ...createBuildingCommands(savePort),
    async takeLoan(
      state: GameState,
      request: Readonly<LoanRequest>,
    ): Promise<GameState> {
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      const currentCashCents = assertSafeMoney(state.cashCents);
      const loan = createLoan(request, operations.loans);
      const nextCash = BigInt(currentCashCents) + BigInt(loan.principalCents);
      if (nextCash > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("金额超出安全整数范围");
      return persist(state, {
        ...state,
        cashCents: Number(nextCash),
        operations: {
          ...operations,
          loans: [...operations.loans.map((item) => ({ ...item })), loan]
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        },
      });
    },

    async repayLoan(
      state: GameState,
      loanId: string,
      amountCents: number,
    ): Promise<GameState> {
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      const currentCashCents = assertSafeMoney(state.cashCents);
      const loans = applyLoanRepayment(operations.loans, loanId, amountCents);
      if (amountCents > currentCashCents) throw new Error("现金不足以偿还贷款");
      return persist(state, {
        ...state,
        cashCents: currentCashCents - amountCents,
        operations: { ...operations, loans },
      });
    },

    async setDifficulty(
      state: GameState,
      difficulty: Difficulty,
    ): Promise<GameState> {
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      if (difficulty !== "casual" && difficulty !== "management") throw new Error("经营难度无效");
      return persist(state, {
        ...state,
        operations: { ...operations, difficulty },
      });
    },

    async setTimeSpeed(
      state: GameState,
      speed: OperationsState["timeSpeed"],
    ): Promise<GameState> {
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      if (speed !== 0 && speed !== 1 && speed !== 2 && speed !== 4) {
        throw new Error("时间速度仅支持 0、1、2、4");
      }
      if (state.currentDay >= MAX_OPERATIONS_DAY && speed !== 0) {
        throw new Error("经营模拟已到第 30 日终点");
      }
      return persist(state, {
        ...state,
        operations: { ...operations, timeSpeed: speed },
      });
    },

    async checkpointOfflineTime(state: GameState, nowMs: number): Promise<GameState> {
      assertNowMs(nowMs);
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      const previous = operations.lastOfflineCheckpointMs;
      if (previous !== null && nowMs < previous) throw new Error("离线检查点不能倒退");
      if (previous === nowMs) return state;
      return persist(state, {
        ...state,
        operations: { ...operations, lastOfflineCheckpointMs: nowMs },
      });
    },

    async initializeOperations(
      state: GameState,
      difficulty: Difficulty = "casual",
    ): Promise<GameState> {
      if (difficulty !== "casual" && difficulty !== "management") {
        throw new Error("经营难度无效");
      }
      const current = state.operations ?? createOperationsState(difficulty);
      const context = pricingContextForState({ ...state, operations: current });
      const pricePolicies: OperationsState["pricePolicies"] = {};
      for (const roomOfferId of offerIds(state)) {
        pricePolicies[roomOfferId] = asPricePolicy(
          current.pricePolicies[roomOfferId],
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

    async configureDepartment(
      state: GameState,
      input: Readonly<DepartmentConfiguration>,
    ): Promise<GameState> {
      validateDepartmentConfiguration(input);
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      const currentCashCents = assertSafeMoney(state.cashCents);
      const previous = operations.departments[input.id];
      if (!previous) throw new Error("部门配置不完整");
      const trainingCostCents = calculateTrainingCostCents(
        previous.trainingBps,
        input.trainingBps,
      );
      if (operations.difficulty === "management" && trainingCostCents > currentCashCents) {
        throw new Error("现金不足以支付一次性培训费用");
      }
      const payment = operations.difficulty === "casual"
        ? coverCasualShortfall(
            currentCashCents,
            trainingCostCents,
            operations.loans,
            DEPARTMENT_TRAINING_SAFETY_LOAN_ID,
          )
        : {
            endingCashCents: currentCashCents - trainingCostCents,
            loans: operations.loans.map((loan) => ({ ...loan })),
          };
      const nextDepartment = structuredClone(input);
      return persist(state, {
        ...state,
        cashCents: payment.endingCashCents,
        operations: {
          ...operations,
          loans: payment.loans,
          departments: {
            ...operations.departments,
            [input.id]: nextDepartment,
          },
        },
      });
    },

    async renovateRoomOffer(
      state: GameState,
      input: Readonly<RoomOfferUpgradeRequest>,
    ): Promise<GameState> {
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      if (state.currentDay >= MAX_OPERATIONS_DAY) throw new Error("经营模拟已到第 30 日终点");
      const currentCashCents = assertSafeMoney(state.cashCents);
      const preview = previewRoomRenovation(state, input);
      if (operations.difficulty === "management" && preview.costCents > currentCashCents) {
        throw new Error("现金不足以支付客房改造费用");
      }
      const payment = operations.difficulty === "casual"
        ? coverCasualShortfall(
            currentCashCents,
            preview.costCents,
            operations.loans,
            ROOM_RENOVATION_SAFETY_LOAN_ID,
          )
        : {
            endingCashCents: currentCashCents - preview.costCents,
            loans: operations.loans.map((loan) => ({ ...loan })),
          };
      const upgrade = {
        ...preview.upgrade,
        committedDay: state.currentDay,
      };
      return persist(state, {
        ...state,
        cashCents: payment.endingCashCents,
        operations: {
          ...operations,
          loans: payment.loans,
          offerUpgrades: {
            ...operations.offerUpgrades,
            [roomOfferUpgradeKey(input.roomOfferId, input.kind)]: upgrade,
          },
        },
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
        nightlyRateCents: effectiveRate(input, pricingContextForState(state)),
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
        pricingContextForState(state),
      );
      const policy: PricePolicy = {
        ...current,
        automaticPricing,
        nightlyRateCents: current.baseRateCents,
      };
      policy.nightlyRateCents = effectiveRate(policy, pricingContextForState(state));
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
      const existingRoom = state.floor.rooms.find(room=>room.slotId===input.slotId);
      if (existingRoom && state.operations) {
        const existingOfferIds = new Set(
          projectRoomOffers(state)
            .filter(({ sourceRoomId }) => sourceRoomId === existingRoom.id)
            .map(({ id }) => id),
        );
        const hasRenovation = Object.values(state.operations.offerUpgrades).some((upgrade) =>
          roomOfferRenovationKind(upgrade) !== null && existingOfferIds.has(upgrade.roomOfferId),
        );
        if (hasRenovation) throw new Error("客房产品已有改造记录，不支持换型");
      }
      const footprint = getTransformedRoomSize(variant.cells, input.rotation);
      if (footprint.width > slot.width || footprint.height > slot.height) {
        throw new Error(`客房尺寸 ${footprint.width}×${footprint.height} 超出槽位 ${slot.width}×${slot.height}`);
      }
      const refundedCash = state.cashCents + (existingRoom?.committedBuildCostCents ?? 0);
      if (refundedCash < variant.metrics.buildCostCents) throw new Error("资金不足，设计已保留");
      const floorPlacements = [...(phase2.floorPlacements ?? []).filter(item => item.slotId !== input.slotId), structuredClone(input)];
      const room = { id:`room-${input.slotId}`, slotId:input.slotId, roomBlueprintId:state.roomBlueprint.id, committedBuildCostCents:variant.metrics.buildCostCents };
      const rooms=[...state.floor.rooms.filter(item=>item.slotId!==input.slotId),room];
      const changed: GameState = {
        ...state,
        phase: rooms.length ? "ready" : "floor",
        cashCents: refundedCash - variant.metrics.buildCostCents,
        floor: { ...state.floor, rooms },
        phase2: { ...phase2, floorPlacements },
      };
      return persist(state, withReconciledPricePolicies(state, changed));
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
      const changed: GameState = {
        ...state,
        phase: placed.rooms.length > 0 ? "ready" : "floor",
        cashCents,
        floor: { ...state.floor, rooms: placed.rooms },
      };
      return persist(state, withReconciledPricePolicies(state, changed));
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

    async advanceDay(state: GameState, nowMs?: number): Promise<GameState> {
      if (state.phase !== "open" || !state.roomBlueprint) {
        throw new Error("酒店尚未开业");
      }

      if (state.operations) {
        if (nowMs === undefined) throw new Error("日结时间必须由应用层提供");
        return persist(state, projectOperationsDay(state, nowMs));
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

    async advanceOperationsDays(
      state: GameState,
      requestedDays: number,
      nowMs: number,
    ): Promise<GameState> {
      if (!Number.isSafeInteger(requestedDays) || requestedDays < 0) {
        throw new Error("批量营业日数必须是非负安全整数");
      }
      assertNowMs(nowMs, "批量日结时间");
      if (requestedDays === 0) return state;
      const daysToSettle = Math.min(requestedDays, Math.max(0, MAX_OPERATIONS_DAY - state.currentDay));
      if (daysToSettle === 0) throw new Error("经营模拟已到第 30 日终点");
      let projected = state;
      for (let index = 0; index < daysToSettle; index += 1) {
        projected = projectOperationsDay(projected, nowMs);
      }
      return persist(state, projected);
    },

    async settleOffline(
      state: GameState,
      nowMs: number,
      millisecondsPerGameDay: number,
    ): Promise<GameState> {
      assertNowMs(nowMs);
      const operations = state.operations;
      if (!operations) throw new Error("经营系统尚未初始化");
      const checkpoint = operations.lastOfflineCheckpointMs;
      if (checkpoint === null) {
        return persist(state, {
          ...state,
          operations: {
            ...operations,
            timeSpeed: state.currentDay >= MAX_OPERATIONS_DAY ? 0 : operations.timeSpeed,
            lastOfflineCheckpointMs: nowMs,
          },
        });
      }
      if (nowMs < checkpoint) throw new Error("离线检查点不能倒退");
      if (state.currentDay > MAX_OPERATIONS_DAY) throw new Error("经营日不能超过第 30 日终点");
      if (state.currentDay === MAX_OPERATIONS_DAY) {
        if (operations.timeSpeed === 0 && checkpoint === nowMs) return state;
        return persist(state, {
          ...state,
          operations: { ...operations, timeSpeed: 0, lastOfflineCheckpointMs: nowMs },
        });
      }
      const days = offlineDaysForElapsed(nowMs - checkpoint, millisecondsPerGameDay);
      if (days === 0 || state.phase !== "open" || !state.roomBlueprint) {
        if (checkpoint === nowMs) return state;
        return persist(state, {
          ...state,
          operations: { ...operations, lastOfflineCheckpointMs: nowMs },
        });
      }
      const daysToSettle = Math.min(days, Math.max(0, MAX_OPERATIONS_DAY - state.currentDay));
      if (daysToSettle === 0) {
        return persist(state, {
          ...state,
          operations: { ...operations, timeSpeed: 0, lastOfflineCheckpointMs: nowMs },
        });
      }
      let projected = state;
      for (let index = 0; index < daysToSettle; index += 1) {
        projected = projectOperationsDay(projected, nowMs);
      }
      return persist(state, projected);
    },
  };
}
