import { describe, expect, it } from "vitest";

import { CONTEMPORARY_ORIENTAL } from "../domain/design/stylePresets";
import { createNewGame } from "../domain/game/state";
import { createRectangle } from "../domain/room/grid";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createGameCommands } from "./gameCommands";

const cells = [
  ...createRectangle(0, 0, 4, 3, "bedroom"),
  ...createRectangle(0, 3, 4, 1, "bathroom"),
];

describe("authoritative design visuals", () => {
  it("persists master and focus assets without changing economics", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomSeries(createNewGame("design-visuals"), {
      id: "master-visuals",
      name: "视觉母版",
      cells,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    state = await commands.saveRoomBlueprint(state, "视觉母版", cells);
    const economics = {
      cashCents: state.cashCents,
      rateCents: state.rateCents,
      metrics: structuredClone(state.phase2!.roomMaster!.metrics),
    };

    state = await commands.requestDesignVisuals(
      state,
      {
        generate: async (_room, request) => ({
          assetPath: request.kind === "master"
            ? "/visuals/master.png"
            : `/visuals/focus-${request.focus}.png`,
        }),
      },
      ["bathroom", "lighting", "view", "ignored"],
    );

    expect(state.phase2?.designVisuals).toMatchObject({
      status: "complete",
      assets: [
        { request: { kind: "master" }, assetPath: "/visuals/master.png" },
        { request: { kind: "focus", focus: "bathroom" }, assetPath: "/visuals/focus-bathroom.png" },
        { request: { kind: "focus", focus: "lighting" }, assetPath: "/visuals/focus-lighting.png" },
        { request: { kind: "focus", focus: "view" }, assetPath: "/visuals/focus-view.png" },
      ],
      errors: [],
    });
    expect({
      cashCents: state.cashCents,
      rateCents: state.rateCents,
      metrics: state.phase2!.roomMaster!.metrics,
    }).toEqual(economics);
    expect((await store.load(state.saveId))?.phase2?.designVisuals).toEqual(
      state.phase2?.designVisuals,
    );
  });

  it("persists retryable visual errors without rejecting the command", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomSeries(createNewGame("design-visual-errors"), {
      id: "master-errors",
      name: "错误母版",
      cells,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    state = await commands.saveRoomBlueprint(state, "错误母版", cells);
    const cashBefore = state.cashCents;

    state = await commands.requestDesignVisuals(state, {
      generate: async () => {
        throw new Error("网络暂不可用");
      },
    }, ["bathroom"]);

    expect(state.phase2?.designVisuals?.errors).toHaveLength(2);
    expect(state.phase2?.designVisuals?.errors[0]).toMatchObject({
      message: "网络暂不可用",
      retryable: true,
    });
    expect(state.cashCents).toBe(cashBefore);
  });

  it("generates directly from the saved room master before a blueprint exists", async () => {
    const commands = createGameCommands(new InMemorySavePort());
    let state = await commands.saveRoomSeries(createNewGame("master-only-visual"), {
      id: "master-only",
      name: "仅母版",
      cells,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    expect(state.roomBlueprint).toBeNull();

    state = await commands.requestDesignVisuals(state, {
      generate: async (room, request) => ({
        assetPath: `/visuals/${room.id}-${request.kind}.png`,
      }),
    });

    expect(state.phase2?.designVisuals?.assets[0]?.assetPath).toBe(
      "/visuals/master-only-master.png",
    );
  });

  it("clears stale design visuals when the master actually changes", async () => {
    const commands = createGameCommands(new InMemorySavePort());
    let state = await commands.saveRoomSeries(createNewGame("stale-visual"), {
      id: "master-stale",
      name: "旧图母版",
      cells,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    state = await commands.requestDesignVisuals(state, {
      generate: async () => ({ assetPath: "/visuals/stale.png" }),
    });
    const changedMaster = {
      ...state.phase2!.roomMaster!,
      gene: {
        ...state.phase2!.roomMaster!.gene,
        lighting: "changed lighting",
      },
    };

    state = await commands.syncRoomSeries(state, changedMaster, []);

    expect(state.phase2?.designVisuals).toBeUndefined();
  });
});
