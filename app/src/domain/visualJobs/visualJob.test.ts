import { describe, expect, it } from "vitest";
import { JOB_STATUSES, type JobStatus } from "../reliability/reliabilityTypes";
import {
  assertVisualJobAttemptAllowed,
  assertVisualJobTransition,
  canAttemptVisualJob,
  canTransitionVisualJob,
  MAX_VISUAL_JOB_ATTEMPTS,
  VISUAL_JOB_ATTEMPT_ERROR,
  VISUAL_JOB_TRANSITION_ERROR,
  VISUAL_JOB_TRANSITIONS,
} from "./visualJob";

const expectedTransitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["queued", "blocked-no-credential", "waiting-network", "checking-model", "needs-player-confirmation", "superseded", "failed-terminal", "cancelled"],
  "blocked-no-credential": ["blocked-no-credential", "queued", "waiting-network", "checking-model", "needs-player-confirmation", "superseded", "failed-terminal", "cancelled"],
  "waiting-network": ["waiting-network", "queued", "blocked-no-credential", "checking-model", "needs-player-confirmation", "superseded", "failed-terminal", "cancelled"],
  "checking-model": ["checking-model", "blocked-no-credential", "waiting-network", "running-primary", "needs-player-confirmation", "failed-retryable", "failed-terminal", "superseded", "cancelled"],
  "running-primary": ["running-primary", "retry-delay", "running-fallback", "staging-asset", "needs-retry-confirmation", "needs-player-confirmation", "failed-retryable", "failed-terminal", "superseded", "cancelled"],
  "retry-delay": ["retry-delay", "running-primary", "running-fallback", "blocked-no-credential", "waiting-network", "needs-retry-confirmation", "needs-player-confirmation", "failed-retryable", "failed-terminal", "superseded", "cancelled"],
  "running-fallback": ["running-fallback", "retry-delay", "staging-asset", "needs-retry-confirmation", "needs-player-confirmation", "failed-retryable", "failed-terminal", "superseded", "cancelled"],
  "staging-asset": ["staging-asset", "ready-for-review", "needs-player-confirmation", "failed-retryable", "failed-terminal", "superseded", "cancelled"],
  "ready-for-review": ["ready-for-review", "adopted", "superseded", "failed-terminal", "cancelled"],
  adopted: ["superseded", "failed-terminal"],
  "needs-retry-confirmation": ["needs-retry-confirmation", "checking-model", "running-primary", "running-fallback", "needs-player-confirmation", "superseded", "failed-terminal", "cancelled"],
  "needs-player-confirmation": ["needs-player-confirmation", "queued", "blocked-no-credential", "waiting-network", "checking-model", "running-primary", "running-fallback", "superseded", "failed-terminal", "cancelled"],
  superseded: [],
  "failed-retryable": ["failed-retryable", "queued", "checking-model", "needs-player-confirmation", "superseded", "failed-terminal", "cancelled"],
  "failed-terminal": [],
  cancelled: [],
};

describe("visual job domain state machine", () => {
  it("covers the frozen 16-status vocabulary exactly", () => {
    expect(Object.keys(VISUAL_JOB_TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it("accepts every native legal edge and rejects every other edge", () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const legal = expectedTransitions[from].includes(to);
        expect(canTransitionVisualJob(from, to), `${from} -> ${to}`).toBe(legal);
        if (legal) {
          expect(() => assertVisualJobTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertVisualJobTransition(from, to)).toThrow(VISUAL_JOB_TRANSITION_ERROR);
        }
      }
    }
  });

  it("keeps the transition projection synchronized with its complete contract", () => {
    expect(VISUAL_JOB_TRANSITIONS).toEqual(expectedTransitions);
  });

  it("allows only the first three billable attempts", () => {
    expect(MAX_VISUAL_JOB_ATTEMPTS).toBe(3);
    expect([0, 1, 2].map(canAttemptVisualJob)).toEqual([true, true, true]);
    expect([3, -1, 1.5, Number.POSITIVE_INFINITY].map(canAttemptVisualJob))
      .toEqual([false, false, false, false]);
    expect(() => assertVisualJobAttemptAllowed(2)).not.toThrow();
    expect(() => assertVisualJobAttemptAllowed(3)).toThrow(VISUAL_JOB_ATTEMPT_ERROR);
  });
});
