import { vi } from "vitest";
import type { ReliabilityPort } from "../application/ports/ReliabilityPort";
import type { SaveId } from "../domain/primitives";
import type { ProviderPreferencesProjection, SaveSummary } from "../domain/reliability/reliabilityTypes";

export const TEST_SAVE: SaveSummary = {
  saveId: "save-1" as SaveId,
  displayName: "云端一号",
  metadataRevision: 0,
  gameRevision: 1,
  currentDay: 3,
  roomCount: 8,
  schemaHealthy: true,
  recoveryAvailable: true,
  lastPlayedAtMs: 1_700_000_000_000,
};

const TEST_PREFERENCES: ProviderPreferencesProjection = {
  preferencesRevision: 0,
  dailyRequestCeiling: 10,
  requireSendConfirmation: true,
  allowAutomatic1kFallback: false,
  lastQuotaDay: 1,
  effectiveQuotaDay: 1,
  usedAttempts: 2,
  updatedAtMs: 1_700_000_000_000,
};

export function makeReliabilityPort(overrides: Partial<ReliabilityPort> = {}): ReliabilityPort {
  return {
    listSaves: vi.fn(async () => [TEST_SAVE]),
    createSave: vi.fn(async () => TEST_SAVE),
    renameSave: vi.fn(async () => ({ ...TEST_SAVE, displayName: "新名字", metadataRevision: 1 })),
    listRecoveryPoints: vi.fn(async () => []),
    restoreRecoveryPoint: vi.fn(async () => ({ saveId: TEST_SAVE.saveId, revision: 2 })),
    exportSave: vi.fn(async () => ({ archiveVersion: 1 as const, suggestedFileName: "cloud-inn.cloudinn", byteLength: 120, sha256: "a".repeat(64) })),
    inspectImport: vi.fn(async () => { throw new Error("archive.cancelled"); }),
    importSave: vi.fn(async () => TEST_SAVE),
    providerTokenStatus: vi.fn(async () => ({ state: "missing" as const })),
    setProviderToken: vi.fn(async () => ({ state: "available" as const })),
    deleteProviderToken: vi.fn(async () => ({ state: "missing" as const })),
    checkProvider: vi.fn(async () => ({ credential: { state: "available" as const }, reachability: "reachable" as const, primaryModelAvailable: true, fallbackModelAvailable: true, checkedAtMs: 1_700_000_000_000 })),
    getProviderPreferences: vi.fn(async () => TEST_PREFERENCES),
    updateProviderPreferences: vi.fn(async () => TEST_PREFERENCES),
    enqueueVisualJob: vi.fn(async () => { throw new Error("provider.invalid-request"); }),
    listVisualJobs: vi.fn(async () => []),
    retryVisualJob: vi.fn(async () => { throw new Error("provider.job-not-found"); }),
    chooseVisualFallback: vi.fn(async () => { throw new Error("provider.job-not-found"); }),
    cancelVisualJob: vi.fn(async () => { throw new Error("provider.job-not-found"); }),
    confirmVisualSend: vi.fn(async () => { throw new Error("provider.job-not-found"); }),
    confirmVisualAdoption: vi.fn(async () => { throw new Error("provider.job-not-found"); }),
    ...overrides,
  };
}
