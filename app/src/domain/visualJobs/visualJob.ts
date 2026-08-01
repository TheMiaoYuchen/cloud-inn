import type { JobStatus } from "../reliability/reliabilityTypes";

/**
 * A visual request may make at most three billable attempts.  The durable
 * coordinator remains authoritative; this module only makes the same limit
 * explicit for deterministic, offline-facing domain decisions.
 */
export const MAX_VISUAL_JOB_ATTEMPTS = 3;
export const MAX_VISUAL_JOB_RETRIES = MAX_VISUAL_JOB_ATTEMPTS;

export const VISUAL_JOB_TRANSITION_ERROR = "provider.invalid-transition";
export const VISUAL_JOB_ATTEMPT_ERROR = "provider.retry-limit-reached";

export class VisualJobTransitionError extends Error {
  readonly code = VISUAL_JOB_TRANSITION_ERROR;

  constructor() {
    super(VISUAL_JOB_TRANSITION_ERROR);
    this.name = "VisualJobTransitionError";
  }
}

export class VisualJobAttemptError extends Error {
  readonly code = VISUAL_JOB_ATTEMPT_ERROR;

  constructor() {
    super(VISUAL_JOB_ATTEMPT_ERROR);
    this.name = "VisualJobAttemptError";
  }
}

/** Complete, shared projection of the native job state graph. */
export const VISUAL_JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: [
    "queued", "blocked-no-credential", "waiting-network", "checking-model",
    "needs-player-confirmation", "superseded", "failed-terminal", "cancelled",
  ],
  "blocked-no-credential": [
    "blocked-no-credential", "queued", "waiting-network", "checking-model",
    "needs-player-confirmation", "superseded", "failed-terminal", "cancelled",
  ],
  "waiting-network": [
    "waiting-network", "queued", "blocked-no-credential", "checking-model",
    "needs-player-confirmation", "superseded", "failed-terminal", "cancelled",
  ],
  "checking-model": [
    "checking-model", "blocked-no-credential", "waiting-network", "running-primary",
    "needs-player-confirmation", "failed-retryable", "failed-terminal", "superseded", "cancelled",
  ],
  "running-primary": [
    "running-primary", "retry-delay", "running-fallback", "staging-asset",
    "needs-retry-confirmation", "needs-player-confirmation", "failed-retryable",
    "failed-terminal", "superseded", "cancelled",
  ],
  "retry-delay": [
    "retry-delay", "running-primary", "running-fallback", "blocked-no-credential",
    "waiting-network", "needs-retry-confirmation", "needs-player-confirmation",
    "failed-retryable", "failed-terminal", "superseded", "cancelled",
  ],
  "running-fallback": [
    "running-fallback", "retry-delay", "staging-asset", "needs-retry-confirmation",
    "needs-player-confirmation", "failed-retryable", "failed-terminal", "superseded", "cancelled",
  ],
  "staging-asset": [
    "staging-asset", "ready-for-review", "needs-player-confirmation",
    "failed-retryable", "failed-terminal", "superseded", "cancelled",
  ],
  "ready-for-review": ["ready-for-review", "adopted", "superseded", "failed-terminal", "cancelled"],
  adopted: ["superseded", "failed-terminal"],
  "needs-retry-confirmation": [
    "needs-retry-confirmation", "checking-model", "running-primary", "running-fallback",
    "needs-player-confirmation", "superseded", "failed-terminal", "cancelled",
  ],
  "needs-player-confirmation": [
    "needs-player-confirmation", "queued", "blocked-no-credential", "waiting-network",
    "checking-model", "running-primary", "running-fallback", "superseded", "failed-terminal", "cancelled",
  ],
  superseded: [],
  "failed-retryable": [
    "failed-retryable", "queued", "checking-model", "needs-player-confirmation",
    "superseded", "failed-terminal", "cancelled",
  ],
  "failed-terminal": [],
  cancelled: [],
};

export function canTransitionVisualJob(from: JobStatus, to: JobStatus): boolean {
  return VISUAL_JOB_TRANSITIONS[from].includes(to);
}

export function assertVisualJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionVisualJob(from, to)) throw new VisualJobTransitionError();
}

export function canAttemptVisualJob(attemptCount: number): boolean {
  return Number.isSafeInteger(attemptCount)
    && attemptCount >= 0
    && attemptCount < MAX_VISUAL_JOB_ATTEMPTS;
}

export function assertVisualJobAttemptAllowed(attemptCount: number): void {
  if (!canAttemptVisualJob(attemptCount)) throw new VisualJobAttemptError();
}
