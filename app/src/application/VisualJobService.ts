import type { SaveId } from "../domain/primitives";
import type {
  CancelVisualJobInput,
  EnqueueVisualJobInput,
  GenerationJobId,
  RetryVisualJobInput,
  VisualJobProjection,
} from "../domain/reliability/reliabilityTypes";
import {
  assertVisualJobAttemptAllowed,
  assertVisualJobTransition,
  VisualJobAttemptError,
  VisualJobTransitionError,
} from "../domain/visualJobs/visualJob";

/**
 * The deliberately small durable boundary needed by UI/application code.
 *
 * This is structural rather than the full ReliabilityPort so the service has
 * no dependency on credentials, provider transport, or native implementation
 * details.  The durable coordinator remains the sole authority that writes
 * jobs and eventually performs provider I/O.
 */
export interface VisualJobReliabilityPort {
  enqueueVisualJob(input: EnqueueVisualJobInput): Promise<VisualJobProjection>;
  listVisualJobs(saveId: SaveId): Promise<readonly VisualJobProjection[]>;
  retryVisualJob(input: RetryVisualJobInput): Promise<VisualJobProjection>;
  cancelVisualJob(input: CancelVisualJobInput): Promise<VisualJobProjection>;
}

const JOB_NOT_FOUND = "provider.job-not-found";
const JOB_STALE = "provider.job-stale";

function staleJobError(): Error {
  return new Error(JOB_STALE);
}

function assertJobIdentity(
  job: Readonly<VisualJobProjection>,
  saveId: SaveId,
  jobId?: GenerationJobId,
): void {
  if (job.saveId !== saveId || (jobId !== undefined && job.jobId !== jobId)) {
    throw staleJobError();
  }
}

function assertFreshRevision(
  job: Readonly<VisualJobProjection>,
  expectedJobRevision: number,
): void {
  if (job.jobRevision !== expectedJobRevision) throw staleJobError();
}

/**
 * Pure application facade for persisted visual generation jobs.
 *
 * It intentionally never imports a visual provider or starts work itself.
 * It only asks the injected reliability boundary to mutate durable work after
 * validating the player-visible state machine locally.
 */
export class VisualJobService {
  constructor(private readonly reliability: VisualJobReliabilityPort) {}

  async enqueue(input: EnqueueVisualJobInput): Promise<VisualJobProjection> {
    const job = await this.reliability.enqueueVisualJob(input);
    assertJobIdentity(job, input.saveId);

    // Enqueue is only a durable reservation: no billable attempt has happened.
    assertVisualJobAttemptAllowed(job.attemptCount);
    if (job.attemptCount !== 0 || job.status !== "queued") {
      throw job.attemptCount !== 0
        ? new VisualJobAttemptError()
        : new VisualJobTransitionError();
    }
    return job;
  }

  list(saveId: SaveId): Promise<readonly VisualJobProjection[]> {
    return this.reliability.listVisualJobs(saveId);
  }

  async retry(input: RetryVisualJobInput): Promise<VisualJobProjection> {
    const current = await this.requireCurrentJob(
      input.saveId,
      input.jobId,
      input.expectedJobRevision,
    );
    assertVisualJobAttemptAllowed(current.attemptCount);
    assertVisualJobTransition(current.status, "queued");

    const next = await this.reliability.retryVisualJob(input);
    this.assertTransitionResult(current, next, "queued");
    return next;
  }

  async cancel(input: CancelVisualJobInput): Promise<VisualJobProjection> {
    const current = await this.requireCurrentJob(
      input.saveId,
      input.jobId,
      input.expectedJobRevision,
    );
    assertVisualJobTransition(current.status, "cancelled");

    const next = await this.reliability.cancelVisualJob(input);
    this.assertTransitionResult(current, next, "cancelled");
    return next;
  }

  private async requireCurrentJob(
    saveId: SaveId,
    jobId: GenerationJobId,
    expectedJobRevision: number,
  ): Promise<VisualJobProjection> {
    const jobs = await this.reliability.listVisualJobs(saveId);
    const job = jobs.find((candidate) => candidate.jobId === jobId);
    if (!job) throw new Error(JOB_NOT_FOUND);
    assertJobIdentity(job, saveId, jobId);
    assertFreshRevision(job, expectedJobRevision);
    return job;
  }

  private assertTransitionResult(
    current: Readonly<VisualJobProjection>,
    next: Readonly<VisualJobProjection>,
    expectedStatus: "queued" | "cancelled",
  ): void {
    assertJobIdentity(next, current.saveId, current.jobId);
    if (next.jobRevision <= current.jobRevision) throw staleJobError();
    assertVisualJobTransition(current.status, next.status);
    if (next.status !== expectedStatus) throw new VisualJobTransitionError();
  }
}
