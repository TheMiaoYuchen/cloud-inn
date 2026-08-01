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

  it("uses typed native provider token commands without reading token values", async () => {
    const missing = { state: "missing" as const };
    const available = { state: "available" as const };
    const invoke = vi.fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(missing);
    const port = new TauriReliabilityPort(invoke);

    await expect(port.providerTokenStatus()).resolves.toEqual(missing);
    await expect(port.setProviderToken("token-value")).resolves.toEqual(available);
    await expect(port.deleteProviderToken()).resolves.toEqual(missing);
    expect(invoke).toHaveBeenNthCalledWith(1, "provider_token_status");
    expect(invoke).toHaveBeenNthCalledWith(2, "set_provider_token", {
      token: "token-value",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "delete_provider_token");
  });

  it("lists recovery points by opaque save identifier", async () => {
    const points = [{
      recoveryId: "recovery-1", kind: "automatic", restoreRevision: 3,
      reason: "construction", createdAtMs: 1,
    }];
    const invoke = vi.fn().mockResolvedValue(points);
    const port = new TauriReliabilityPort(invoke);

    await expect(port.listRecoveryPoints("save-1")).resolves.toEqual(points);
    expect(invoke).toHaveBeenCalledWith("list_recovery_points", { saveId: "save-1" });
  });
});
