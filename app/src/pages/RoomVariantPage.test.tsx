import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { SavePort } from "../application/ports/SavePort";
import { CONTEMPORARY_ORIENTAL } from "../domain/design/stylePresets";
import { createRoomMaster, createRoomVariants } from "../domain/design/roomSeries";
import { createNewGame, type GameState } from "../domain/game/state";
import { createRectangle } from "../domain/room/grid";
import { GameProvider } from "../state/GameProvider";
import { RoomVariantPage } from "./RoomVariantPage";

class LoadedSavePort implements SavePort {
  constructor(private state: GameState) {}
  async load() {
    return structuredClone(this.state);
  }
  async commit(_expectedRevision: number, next: GameState) {
    this.state = structuredClone(next);
  }
}

describe("room variant direct load", () => {
  it("seeds the lighting input when the persisted master arrives asynchronously", async () => {
    const base = createNewGame("variant-direct-load");
    const cells = [
      ...createRectangle(0, 0, 4, 3, "bedroom"),
      ...createRectangle(0, 3, 4, 1, "bathroom"),
    ];
    const master = createRoomMaster({
      id: "master-direct",
      name: "直接载入母版",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    const state: GameState = {
      ...base,
      revision: 1,
      phase2: {
        hotelGene: CONTEMPORARY_ORIENTAL.gene,
        roomMaster: master,
        roomVariants: createRoomVariants(master),
        corridorTemplate: null,
      },
    };

    render(
      <GameProvider savePort={new LoadedSavePort(state)} saveId={state.saveId}>
        <RoomVariantPage />
      </GameProvider>,
    );

    expect(await screen.findByLabelText("母版灯光")).toHaveValue(
      CONTEMPORARY_ORIENTAL.gene.lighting,
    );
  });

  it("generates and renders persisted master and focus visuals", async () => {
    const base = createNewGame("variant-visuals");
    const cells = [
      ...createRectangle(0, 0, 4, 3, "bedroom"),
      ...createRectangle(0, 3, 4, 1, "bathroom"),
    ];
    const master = createRoomMaster({
      id: "master-visual-page",
      name: "视觉页母版",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    const state: GameState = {
      ...base,
      revision: 1,
      phase2: {
        hotelGene: CONTEMPORARY_ORIENTAL.gene,
        roomMaster: master,
        roomVariants: createRoomVariants(master),
        corridorTemplate: null,
      },
    };
    const user = userEvent.setup();

    render(
      <GameProvider
        savePort={new LoadedSavePort(state)}
        saveId={state.saveId}
        visualProvider={{
          generate: async (_room, request) => ({
            assetPath: request?.kind === "focus"
              ? `/visuals/${request.focus}.png`
              : "/visuals/master.png",
          }),
        }}
      >
        <RoomVariantPage />
      </GameProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "生成系列效果图" }));

    expect(await screen.findByRole("img", { name: "客房系列主效果图" })).toHaveAttribute(
      "src",
      "/visuals/master.png",
    );
    expect(screen.getAllByRole("img", { name: /客房系列焦点效果图/ })).toHaveLength(3);
  });

  it("restores visual errors from a loaded save", async () => {
    const base = createNewGame("variant-visual-errors-load");
    const cells = [
      ...createRectangle(0, 0, 4, 3, "bedroom"),
      ...createRectangle(0, 3, 4, 1, "bathroom"),
    ];
    const master = createRoomMaster({
      id: "master-visual-errors-load",
      name: "错误恢复母版",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    const state: GameState = {
      ...base,
      revision: 1,
      phase2: {
        hotelGene: CONTEMPORARY_ORIENTAL.gene,
        roomMaster: master,
        roomVariants: createRoomVariants(master),
        corridorTemplate: null,
        designVisuals: {
          status: "complete",
          assets: [],
          errors: [{
            request: { kind: "focus", focus: "bathroom" },
            message: "网络暂不可用",
            retryable: true,
          }],
        },
      },
    };

    render(
      <GameProvider savePort={new LoadedSavePort(state)} saveId={state.saveId}>
        <RoomVariantPage />
      </GameProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("浴室：网络暂不可用");
  });
});
