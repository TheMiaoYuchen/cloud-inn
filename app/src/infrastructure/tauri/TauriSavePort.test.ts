import { describe, expect, it, vi } from "vitest";
import { createNewGame } from "../../domain/game/state";
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
});
