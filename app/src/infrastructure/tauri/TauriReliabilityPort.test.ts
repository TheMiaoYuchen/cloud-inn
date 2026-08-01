import { describe, expect, it, vi } from "vitest";
import { TauriReliabilityPort } from "./TauriReliabilityPort";

describe("TauriReliabilityPort", () => {
  it("uses the typed native save catalog commands", async () => {
    const summary = {
      saveId: "save-1", displayName: "云岫酒店", metadataRevision: 0,
      gameRevision: 0, currentDay: 0, roomCount: 0, schemaHealthy: true,
      recoveryAvailable: false, lastPlayedAtMs: 0,
    };
    const invoke = vi.fn()
      .mockResolvedValueOnce([summary])
      .mockResolvedValueOnce(summary)
      .mockResolvedValueOnce({ ...summary, displayName: "新名称", metadataRevision: 1 });
    const port = new TauriReliabilityPort(invoke);

    await expect(port.listSaves()).resolves.toEqual([summary]);
    await expect(port.createSave("云岫酒店")).resolves.toEqual(summary);
    await expect(port.renameSave("save-1", "新名称", 0)).resolves.toMatchObject({ metadataRevision: 1 });
    expect(invoke).toHaveBeenNthCalledWith(1, "list_saves");
    expect(invoke).toHaveBeenNthCalledWith(2, "create_save", { displayName: "云岫酒店" });
    expect(invoke).toHaveBeenNthCalledWith(3, "rename_save", {
      saveId: "save-1", displayName: "新名称", expectedMetadataRevision: 0,
    });
  });
});
