import { beforeEach, describe, expect, it } from "vitest";

import type {
  AssetId,
  GenerationJobId,
  VisualJobProjection,
} from "../../domain/reliability/reliabilityTypes";
import { LocalStorageSavePort } from "./LocalStorageSavePort";
import { BrowserReliabilityPort } from "./BrowserReliabilityPort";

function fakeLocks(): LockManager {
  return {
    request: (_name: string, callback: LockGrantedCallback) => callback({
      name: _name,
      mode: "exclusive",
    }),
    query: async () => ({ held: [], pending: [] }),
  } as LockManager;
}

const jobsKey = (saveId: string) => `cloud-inn:visual-jobs:${saveId}`;

function replaceStoredJob(
  saveId: string,
  patch: Partial<VisualJobProjection>,
): VisualJobProjection {
  const jobs = JSON.parse(window.localStorage.getItem(jobsKey(saveId)) ?? "[]") as VisualJobProjection[];
  const next = { ...jobs[0], ...patch };
  window.localStorage.setItem(jobsKey(saveId), JSON.stringify([next]));
  return next;
}

describe("BrowserReliabilityPort visual reliability adapter", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists narrow provider preferences with revision CAS and derived fields", async () => {
    let nowMs = 5 * 86_400_000 + 12;
    const port = new BrowserReliabilityPort(
      new LocalStorageSavePort(fakeLocks()),
      () => nowMs,
    );

    await expect(port.getProviderPreferences()).resolves.toEqual({
      preferencesRevision: 0,
      dailyRequestCeiling: 10,
      requireSendConfirmation: true,
      allowAutomatic1kFallback: false,
      lastQuotaDay: 5,
      effectiveQuotaDay: 5,
      usedAttempts: 0,
      updatedAtMs: nowMs,
    });

    await expect(port.updateProviderPreferences(0, {
      dailyRequestCeiling: 4,
      requireSendConfirmation: false,
      allowAutomatic1kFallback: true,
    })).resolves.toMatchObject({
      preferencesRevision: 1,
      dailyRequestCeiling: 4,
      lastQuotaDay: 5,
      usedAttempts: 0,
    });
    await expect(port.updateProviderPreferences(0, {
      dailyRequestCeiling: 3,
      requireSendConfirmation: true,
      allowAutomatic1kFallback: false,
    })).rejects.toThrow("provider.control-invalid");

    nowMs = 4 * 86_400_000;
    await expect(port.getProviderPreferences()).resolves.toMatchObject({
      lastQuotaDay: 5,
      effectiveQuotaDay: 5,
    });
  });

  it("enqueues deterministic durable offline jobs without consuming an attempt", async () => {
    const port = new BrowserReliabilityPort(
      new LocalStorageSavePort(fakeLocks()),
      () => 1_234,
    );
    const save = await port.createSave("离线酒店");
    const input = {
      saveId: save.saveId,
      expectedRevision: save.gameRevision,
      targetFingerprint: "a".repeat(64),
      request: {
        targetKind: "master" as const,
        prompt: "A calm cloud inn",
        resolution: "1k" as const,
        referenceAssetIds: [] as readonly AssetId[],
      },
    };

    const first = await port.enqueueVisualJob(input);
    const second = await port.enqueueVisualJob(input);

    expect(first).toMatchObject({
      jobId: "browser-visual-job-0001",
      status: "queued",
      attemptCount: 0,
      selectedModel: null,
      errorCode: null,
    });
    expect(first.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.jobId).toBe("browser-visual-job-0002");
    await expect(port.listVisualJobs(save.saveId)).resolves.toEqual([first, second]);

    const reloaded = new BrowserReliabilityPort(
      new LocalStorageSavePort(fakeLocks()),
      () => 9_999,
    );
    await expect(reloaded.listVisualJobs(save.saveId)).resolves.toEqual([first, second]);
  });

  it("uses VisualJobService guards for retry and cancel CAS transitions", async () => {
    const port = new BrowserReliabilityPort(
      new LocalStorageSavePort(fakeLocks()),
      () => 100,
    );
    const save = await port.createSave("队列酒店");
    const queued = await port.enqueueVisualJob({
      saveId: save.saveId,
      expectedRevision: 1,
      targetFingerprint: "a".repeat(64),
      request: {
        targetKind: "master",
        prompt: "retry",
        resolution: "1k",
        referenceAssetIds: [],
      },
    });
    replaceStoredJob(save.saveId, {
      status: "failed-retryable",
      attemptCount: 2,
      errorCode: "network.timeout",
    });

    const retried = await port.retryVisualJob({
      saveId: save.saveId,
      jobId: queued.jobId,
      expectedJobRevision: 0,
    });
    expect(retried).toMatchObject({
      status: "queued",
      jobRevision: 1,
      attemptCount: 2,
      errorCode: null,
    });
    await expect(port.retryVisualJob({
      saveId: save.saveId,
      jobId: queued.jobId,
      expectedJobRevision: 0,
    })).rejects.toThrow("provider.job-stale");

    const cancelled = await port.cancelVisualJob({
      saveId: save.saveId,
      jobId: queued.jobId,
      expectedJobRevision: 1,
    });
    expect(cancelled).toMatchObject({ status: "cancelled", jobRevision: 2 });
    await expect(port.cancelVisualJob({
      saveId: save.saveId,
      jobId: queued.jobId,
      expectedJobRevision: 2,
    })).rejects.toThrow("provider.invalid-transition");
  });

  it("keeps confirmed sends and fallback selection offline", async () => {
    const port = new BrowserReliabilityPort(
      new LocalStorageSavePort(fakeLocks()),
      () => 200,
    );
    const save = await port.createSave("无网酒店");
    const queued = await port.enqueueVisualJob({
      saveId: save.saveId,
      expectedRevision: 1,
      targetFingerprint: "a".repeat(64),
      request: {
        targetKind: "master",
        prompt: "offline",
        resolution: "1k",
        referenceAssetIds: [],
      },
    });

    const waiting = await port.confirmVisualSend({
      saveId: save.saveId,
      jobId: queued.jobId,
      expectedJobRevision: 0,
    });
    expect(waiting).toMatchObject({
      status: "waiting-network",
      attemptCount: 0,
      errorCode: "network.offline",
      selectedModel: null,
    });

    replaceStoredJob(save.saveId, {
      status: "needs-player-confirmation",
      jobRevision: 2,
      errorCode: "provider.model-unavailable",
    });
    const fallback = await port.chooseVisualFallback({
      saveId: save.saveId,
      jobId: queued.jobId,
      expectedJobRevision: 2,
      choice: "compatible-1k",
    });
    expect(fallback).toMatchObject({
      status: "waiting-network",
      attemptCount: 0,
      errorCode: "network.offline",
      selectedModel: "browser-offline-compatible-1k",
    });
  });

  it("adopts only a current verified review job and advances the save revision", async () => {
    const savePort = new LocalStorageSavePort(fakeLocks());
    const port = new BrowserReliabilityPort(savePort, () => 300);
    const save = await port.createSave("采用酒店");
    const queued = await port.enqueueVisualJob({
      saveId: save.saveId,
      expectedRevision: 1,
      targetFingerprint: "a".repeat(64),
      request: {
        targetKind: "master",
        prompt: "ready",
        resolution: "1k",
        referenceAssetIds: [],
      },
    });
    replaceStoredJob(save.saveId, {
      status: "ready-for-review",
      asset: {
        assetId: "asset-1" as AssetId,
        mimeType: "image/png",
        byteLength: 10,
        width: 1,
        height: 1,
        sha256: "b".repeat(64),
        resolverUrl: "cloudinn-asset://asset-1",
      },
    });

    const adopted = await port.confirmVisualAdoption({
      saveId: save.saveId,
      jobId: queued.jobId,
      expectedJobRevision: 0,
      expectedRevision: 1,
      targetFingerprint: "a".repeat(64),
    });
    expect(adopted).toMatchObject({
      gameRevision: 2,
      job: { status: "adopted", jobRevision: 1 },
    });
    expect((await savePort.load(save.saveId))?.revision).toBe(2);

    await expect(port.confirmVisualAdoption({
      saveId: save.saveId,
      jobId: "missing" as GenerationJobId,
      expectedJobRevision: 0,
      expectedRevision: 2,
      targetFingerprint: "a".repeat(64),
    })).rejects.toThrow("provider.job-not-found");
  });

  it("rejects invalid local queue data instead of presenting it as durable state", async () => {
    window.localStorage.setItem(jobsKey("save-corrupt"), "{not-json");
    const port = new BrowserReliabilityPort(new LocalStorageSavePort(fakeLocks()));

    await expect(port.listVisualJobs("save-corrupt")).rejects.toThrow(
      "provider.control-invalid",
    );
  });
});
