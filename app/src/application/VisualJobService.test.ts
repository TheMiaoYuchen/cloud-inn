import { describe, expect, it } from "vitest";

import type { SaveId } from "../domain/primitives";
import type {
  CancelVisualJobInput,
  EnqueueVisualJobInput,
  GenerationJobId,
  RetryVisualJobInput,
  VisualJobProjection,
} from "../domain/reliability/reliabilityTypes";
import {
  VISUAL_JOB_ATTEMPT_ERROR,
  VISUAL_JOB_TRANSITION_ERROR,
} from "../domain/visualJobs/visualJob";
import {
  type VisualJobReliabilityPort,
  VisualJobService,
} from "./VisualJobService";

const saveId = "save-visual-jobs" as SaveId;
const jobId = "visual-job-01" as GenerationJobId;

function job(overrides: Partial<VisualJobProjection> = {}): VisualJobProjection {
  return {
    jobId,
    saveId,
    jobRevision: 4,
    status: "queued",
    targetKind: "master",
    targetFingerprint: "target-fingerprint",
    requestFingerprint: "request-fingerprint",
    resolution: "1k",
    selectedModel: null,
    attemptCount: 0,
    nextAttemptAtMs: null,
    asset: null,
    errorCode: null,
    responseAmbiguous: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

const enqueueInput: EnqueueVisualJobInput = {
  saveId,
  expectedRevision: 9,
  targetFingerprint: "target-fingerprint",
  request: {
    targetKind: "master",
    prompt: "A calm cloud inn suite",
    resolution: "1k",
    referenceAssetIds: [],
  },
};

class FakeVisualJobPort implements VisualJobReliabilityPort {
  jobs: readonly VisualJobProjection[] = [];
  enqueued: EnqueueVisualJobInput[] = [];
  retried: RetryVisualJobInput[] = [];
  cancelled: CancelVisualJobInput[] = [];
  enqueueResult = job();
  retryResult = job({ jobRevision: 5 });
  cancelResult = job({ jobRevision: 5, status: "cancelled" });

  enqueueVisualJob(input: EnqueueVisualJobInput): Promise<VisualJobProjection> {
    this.enqueued.push(input);
    return Promise.resolve(this.enqueueResult);
  }

  listVisualJobs(_saveId: SaveId): Promise<readonly VisualJobProjection[]> {
    return Promise.resolve(this.jobs);
  }

  retryVisualJob(input: RetryVisualJobInput): Promise<VisualJobProjection> {
    this.retried.push(input);
    return Promise.resolve(this.retryResult);
  }

  cancelVisualJob(input: CancelVisualJobInput): Promise<VisualJobProjection> {
    this.cancelled.push(input);
    return Promise.resolve(this.cancelResult);
  }
}

describe("VisualJobService", () => {
  it("only enqueues a fresh queued job through the injected durable boundary", async () => {
    const port = new FakeVisualJobPort();
    const service = new VisualJobService(port);

    await expect(service.enqueue(enqueueInput)).resolves.toEqual(job());
    expect(port.enqueued).toEqual([enqueueInput]);
  });

  it("rejects an enqueue result that already consumed an attempt or skipped the queued state", async () => {
    const attempted = new FakeVisualJobPort();
    attempted.enqueueResult = job({ attemptCount: 1 });
    await expect(new VisualJobService(attempted).enqueue(enqueueInput))
      .rejects.toThrow(VISUAL_JOB_ATTEMPT_ERROR);

    const advanced = new FakeVisualJobPort();
    advanced.enqueueResult = job({ status: "checking-model" });
    await expect(new VisualJobService(advanced).enqueue(enqueueInput))
      .rejects.toThrow(VISUAL_JOB_TRANSITION_ERROR);
  });

  it("lists only through the injected durable boundary", async () => {
    const port = new FakeVisualJobPort();
    port.jobs = [job({ status: "ready-for-review", attemptCount: 3 })];

    await expect(new VisualJobService(port).list(saveId)).resolves.toEqual(port.jobs);
    expect(port.enqueued).toEqual([]);
    expect(port.retried).toEqual([]);
    expect(port.cancelled).toEqual([]);
  });

  it("requeues a current retryable job only while a billable attempt remains", async () => {
    const port = new FakeVisualJobPort();
    port.jobs = [job({ status: "failed-retryable", attemptCount: 2 })];
    port.retryResult = job({ status: "queued", attemptCount: 2, jobRevision: 5 });
    const input: RetryVisualJobInput = { saveId, jobId, expectedJobRevision: 4 };

    await expect(new VisualJobService(port).retry(input)).resolves.toEqual(port.retryResult);
    expect(port.retried).toEqual([input]);
  });

  it("blocks retry before the boundary for exhausted attempts, stale revisions, and illegal edges", async () => {
    const exhausted = new FakeVisualJobPort();
    exhausted.jobs = [job({ status: "failed-retryable", attemptCount: 3 })];
    await expect(new VisualJobService(exhausted).retry({ saveId, jobId, expectedJobRevision: 4 }))
      .rejects.toThrow(VISUAL_JOB_ATTEMPT_ERROR);
    expect(exhausted.retried).toEqual([]);

    const stale = new FakeVisualJobPort();
    stale.jobs = [job({ status: "failed-retryable", jobRevision: 5 })];
    await expect(new VisualJobService(stale).retry({ saveId, jobId, expectedJobRevision: 4 }))
      .rejects.toThrow("provider.job-stale");
    expect(stale.retried).toEqual([]);

    const active = new FakeVisualJobPort();
    active.jobs = [job({ status: "staging-asset" })];
    await expect(new VisualJobService(active).retry({ saveId, jobId, expectedJobRevision: 4 }))
      .rejects.toThrow(VISUAL_JOB_TRANSITION_ERROR);
    expect(active.retried).toEqual([]);
  });

  it("checks durable retry results against the transition graph and revision CAS", async () => {
    const illegal = new FakeVisualJobPort();
    illegal.jobs = [job({ status: "failed-retryable" })];
    illegal.retryResult = job({ status: "running-primary", jobRevision: 5 });
    await expect(new VisualJobService(illegal).retry({ saveId, jobId, expectedJobRevision: 4 }))
      .rejects.toThrow(VISUAL_JOB_TRANSITION_ERROR);

    const stale = new FakeVisualJobPort();
    stale.jobs = [job({ status: "failed-retryable" })];
    stale.retryResult = job({ status: "queued", jobRevision: 4 });
    await expect(new VisualJobService(stale).retry({ saveId, jobId, expectedJobRevision: 4 }))
      .rejects.toThrow("provider.job-stale");
  });

  it("cancels only a current cancellable job and requires a terminal cancellation result", async () => {
    const port = new FakeVisualJobPort();
    port.jobs = [job({ status: "waiting-network" })];
    port.cancelResult = job({ status: "cancelled", jobRevision: 5 });
    const input: CancelVisualJobInput = { saveId, jobId, expectedJobRevision: 4 };

    await expect(new VisualJobService(port).cancel(input)).resolves.toEqual(port.cancelResult);
    expect(port.cancelled).toEqual([input]);

    const adopted = new FakeVisualJobPort();
    adopted.jobs = [job({ status: "adopted" })];
    await expect(new VisualJobService(adopted).cancel(input))
      .rejects.toThrow(VISUAL_JOB_TRANSITION_ERROR);
    expect(adopted.cancelled).toEqual([]);
  });
});
