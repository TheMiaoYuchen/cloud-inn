import { describe, expect, it, vi } from "vitest";
import { assertStableId } from "../../domain/building/buildingTypes";
import { createNewGame } from "../../domain/game/state";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { TauriSavePort } from "./TauriSavePort";

describe("TauriSavePort", () => {
  it("uses typed load and commit commands", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    const port = new TauriSavePort(invoke);
    const game = createNewGame("save-1");
    expect(await port.load("save-1")).toBeNull();
    await port.commit(0, { ...game, revision: 1 });
    expect(invoke).toHaveBeenNthCalledWith(1, "load_game", { saveId: "save-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "commit_game", {
      expectedRevision: 0,
      game: { ...game, revision: 1 },
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects Phase 4 %s before invoking Tauri", async (_label, invalid) => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const port = new TauriSavePort(invoke);
    const game = createPhase4AcceptanceState("tauri-phase4-non-finite");
    game.phase4!.recentFlowSnapshot!.events[0].count = invalid;

    await expect(port.commit(game.revision - 1, game))
      .rejects.toThrow("数字必须是有限安全 JSON 数字");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates Phase 4 references against the enclosing game before invoking Tauri", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const port = new TauriSavePort(invoke);
    const game = createPhase4AcceptanceState("tauri-phase4-game-value");
    const template = Object.values(game.phase4!.floorTemplates)
      .find(({ roomPlacements }) => roomPlacements.length > 0)!;
    template.roomPlacements[0].roomBlueprintId = assertStableId("room-blueprint:unknown");

    await expect(port.commit(game.revision - 1, game))
      .rejects.toThrow("客房设计引用无效");
    expect(invoke).not.toHaveBeenCalled();
  });
});
