import { describe, expect, it, vi } from "vitest";
import type {
  AssetId,
  GenerationJobId,
  VisualJobProjection,
} from "../../domain/reliability/reliabilityTypes";
import { TauriReliabilityPort } from "./TauriReliabilityPort";

const jobId = "job-1" as GenerationJobId;

function job(status: VisualJobProjection["status"] = "queued"): VisualJobProjection {
  return {
    jobId,
    saveId: "save-1",
    jobRevision: 0,
    status,
    targetKind: "master",
    targetFingerprint: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    resolution: "1k",
    selectedModel: null,
    attemptCount: 0,
    nextAttemptAtMs: null,
    asset: null,
    errorCode: null,
    responseAmbiguous: false,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("TauriReliabilityPort", () => {
  it("activates the native asset scope before a save becomes current", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const port = new TauriReliabilityPort(invoke);

    await expect(port.activateSaveAssets("save-1")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("activate_asset_save", { saveId: "save-1" });
  });

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

  it("uses the narrow preferences DTO and monotonic revision command", async () => {
    const projection = {
      preferencesRevision: 3,
      dailyRequestCeiling: 5,
      requireSendConfirmation: true,
      allowAutomatic1kFallback: false,
      lastQuotaDay: 20_000,
      effectiveQuotaDay: 20_000,
      usedAttempts: 1,
      updatedAtMs: 10,
    };
    const writable = {
      dailyRequestCeiling: 6,
      requireSendConfirmation: false,
      allowAutomatic1kFallback: true,
    };
    const invoke = vi.fn().mockResolvedValue(projection);
    const port = new TauriReliabilityPort(invoke);

    await expect(port.getProviderPreferences()).resolves.toEqual(projection);
    await expect(port.updateProviderPreferences(3, writable)).resolves.toEqual(projection);
    expect(invoke).toHaveBeenNthCalledWith(1, "get_provider_preferences");
    expect(invoke).toHaveBeenNthCalledWith(2, "update_provider_preferences", {
      expectedRevision: 3,
      preferences: writable,
    });
  });

  it("maps every visual queue operation to a typed native command", async () => {
    const queued = job();
    const adopted = {
      job: {
        ...job("adopted"),
        asset: {
          assetId: "asset-1" as AssetId,
          mimeType: "image/png" as const,
          byteLength: 10,
          width: 1,
          height: 1,
          sha256: "c".repeat(64),
          resolverUrl: "cloudinn-asset://asset-1" as const,
        },
      },
      gameRevision: 10,
    };
    const invoke = vi.fn()
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce([queued])
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce(adopted);
    const port = new TauriReliabilityPort(invoke);
    const enqueue = {
      saveId: "save-1",
      expectedRevision: 9,
      targetFingerprint: "a".repeat(64),
      request: {
        targetKind: "master" as const,
        prompt: "cloud inn",
        resolution: "1k" as const,
        referenceAssetIds: [] as readonly AssetId[],
      },
    };
    const current = { saveId: "save-1", jobId, expectedJobRevision: 0 };

    await expect(port.enqueueVisualJob(enqueue)).resolves.toEqual(queued);
    await expect(port.listVisualJobs("save-1")).resolves.toEqual([queued]);
    await expect(port.retryVisualJob(current)).resolves.toEqual(queued);
    await expect(port.chooseVisualFallback({ ...current, choice: "compatible-1k" })).resolves.toEqual(queued);
    await expect(port.cancelVisualJob(current)).resolves.toEqual(queued);
    await expect(port.confirmVisualSend(current)).resolves.toEqual(queued);
    await expect(port.confirmVisualAdoption({
      ...current,
      expectedRevision: 9,
      targetFingerprint: "a".repeat(64),
    })).resolves.toEqual(adopted);

    expect(invoke.mock.calls).toEqual([
      ["enqueue_visual_job", enqueue],
      ["list_visual_jobs", { saveId: "save-1" }],
      ["retry_visual_job", current],
      ["choose_visual_fallback", { ...current, choice: "compatible-1k" }],
      ["cancel_visual_job", current],
      ["confirm_visual_send", current],
      ["confirm_visual_adoption", {
        ...current,
        expectedRevision: 9,
        targetFingerprint: "a".repeat(64),
      }],
    ]);
  });
});
