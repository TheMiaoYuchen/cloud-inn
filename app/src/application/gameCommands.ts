import { prototypeConfig } from "../domain/config/prototypeConfig";
import { placeRoom as planRoom } from "../domain/floor/planFloor";
import type { Cell, GameState } from "../domain/game/state";
import { assertSafeMoney } from "../domain/primitives";
import { evaluateRoom } from "../domain/room/evaluateRoom";
import { settleDay } from "../domain/simulation/settleDay";
import type { SavePort } from "./ports/SavePort";
import type { VisualProvider } from "./ports/VisualProvider";
import { requestRoomVisual } from "./requestRoomVisual";

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
    async saveRoomBlueprint(
      state: GameState,
      name: string,
      cells: Cell[],
    ): Promise<GameState> {
      if (state.phase !== "design") {
        throw new Error("当前不能修改房型");
      }
      const trimmedName = name.trim();
      if (trimmedName.length === 0) {
        throw new Error("房型名称不能为空");
      }

      const blueprintCells = structuredClone(cells);
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
