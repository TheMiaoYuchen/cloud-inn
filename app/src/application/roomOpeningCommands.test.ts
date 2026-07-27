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
const openings = {
  walls: [{ x: 0, y: 0, side: "north" as const }],
  doors: [{ x: 0, y: 1, side: "west" as const }],
  windows: [{ x: 3, y: 0, side: "east" as const }],
};

describe("room opening saves", () => {
  it("preserves openings in both the room-series and blueprint save paths", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = await commands.saveRoomSeries(createNewGame("openings"), {
      id: "master-openings",
      name: "带开口母版",
      cells,
      openings,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });

    expect(state.phase2?.roomMaster?.openings).toEqual(openings);

    state = await commands.saveRoomBlueprint(
      state,
      "带开口母版",
      cells,
      openings,
    );

    expect(state.roomBlueprint?.openings).toEqual(openings);
    expect((await store.load(state.saveId))?.roomBlueprint?.openings).toEqual(
      openings,
    );
  });

  it.each([
    {
      label: "duplicate doors",
      invalid: {
        walls: [],
        doors: [
          { x: 0, y: 1, side: "west" as const },
          { x: 0, y: 1, side: "west" as const },
        ],
        windows: [],
      },
    },
    {
      label: "different opening kinds on one edge",
      invalid: {
        walls: [{ x: 0, y: 1, side: "west" as const }],
        doors: [{ x: 0, y: 1, side: "west" as const }],
        windows: [],
      },
    },
  ])("rejects $label without changing state or save", async ({ invalid }) => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("invalid-openings");
    const snapshot = structuredClone(state);

    await expect(
      commands.saveRoomBlueprint(state, "非法开口", cells, invalid),
    ).rejects.toThrow("同一房间边只能设置一个开口");

    expect(state).toEqual(snapshot);
    expect(await store.load(state.saveId)).toBeNull();
  });
});
