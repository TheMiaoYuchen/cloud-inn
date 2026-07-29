import type { Revision, SaveId } from "../primitives";

export type RecoveryId = string & { readonly __recoveryId: unique symbol };
export type AssetId = string & { readonly __assetId: unique symbol };
export type GenerationJobId = string & {
  readonly __generationJobId: unique symbol;
};
export type ImportInspectionToken = string & {
  readonly __importInspectionToken: unique symbol;
};

export const CLOUD_INN_ARCHIVE_VERSION = 1 as const;
export type CloudInnArchiveVersion = typeof CLOUD_INN_ARCHIVE_VERSION;

export const JOB_STATUSES = [
  "queued",
  "blocked-no-credential",
  "waiting-network",
  "checking-model",
  "running-primary",
  "retry-delay",
  "running-fallback",
  "staging-asset",
  "ready-for-review",
  "adopted",
  "needs-retry-confirmation",
  "needs-player-confirmation",
  "superseded",
  "failed-retryable",
  "failed-terminal",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const PROVIDER_CREDENTIAL_STATES = [
  "missing",
  "available",
  "locked",
  "denied",
  "unavailable",
] as const;

export type ProviderCredentialState =
  (typeof PROVIDER_CREDENTIAL_STATES)[number];

export const RELIABILITY_ERROR_CODES = [
  "save.not-found",
  "save.invalid-id",
  "save.invalid-name",
  "save.conflict",
  "save.locked",
  "save.corrupt",
  "migration.unsupported-version",
  "migration.backup-failed",
  "migration.failed",
  "migration.validation-failed",
  "recovery.not-found",
  "recovery.corrupt",
  "recovery.restore-failed",
  "archive.cancelled",
  "archive.invalid",
  "archive.unsupported-version",
  "archive.too-large",
  "archive.insufficient-space",
  "archive.expired-inspection",
  "archive.conflict",
  "archive.import-failed",
  "archive.export-failed",
  "asset.not-found",
  "asset.corrupt",
  "asset.unsupported-type",
  "asset.too-large",
  "asset.write-failed",
  "keychain.missing",
  "keychain.locked",
  "keychain.denied",
  "keychain.unavailable",
  "keychain.invalid-token",
  "provider.control-invalid",
  "provider.quota-exceeded",
  "provider.confirmation-required",
  "provider.job-not-found",
  "provider.job-stale",
  "provider.invalid-transition",
  "provider.model-unavailable",
  "provider.authentication-failed",
  "provider.safety-rejected",
  "provider.invalid-request",
  "provider.malformed-response",
  "network.offline",
  "network.timeout",
  "network.rate-limited",
  "network.unavailable",
  "unknown.unexpected",
] as const;

export type ReliabilityErrorCode = (typeof RELIABILITY_ERROR_CODES)[number];

export const RELIABILITY_LIMITS = {
  saveDisplayNameGraphemes: { minimum: 1, maximum: 40 },
  automaticRecoveryPoints: 20,
  providerTokenUtf8Bytes: { minimum: 1, maximum: 4_096 },
  promptCharacters: 12_000,
  referenceImages: {
    maximumCount: 4,
    maximumBytesEach: 32 * 1_024 * 1_024,
  },
  generatedImages: {
    "1k": {
      maximumResponseBytes: 24 * 1_024 * 1_024,
      maximumDecodedBytes: 16 * 1_024 * 1_024,
    },
    "2k": {
      maximumResponseBytes: 64 * 1_024 * 1_024,
      maximumDecodedBytes: 48 * 1_024 * 1_024,
    },
    "4k": {
      maximumResponseBytes: 128 * 1_024 * 1_024,
      maximumDecodedBytes: 96 * 1_024 * 1_024,
    },
  },
  archive: {
    maximumBytes: 2 * 1_024 * 1_024 * 1_024,
    maximumEntries: 10_000,
    maximumManifestBytes: 64 * 1_024 * 1_024,
  },
  provider: {
    defaultDailyRequestCeiling: 10,
    minimumDailyRequestCeiling: 0,
    maximumDailyRequestCeiling: 100,
    modelHealthCacheMs: 15 * 60 * 1_000,
  },
  importInspectionTtlMs: 15 * 60 * 1_000,
} as const;

export type ImageResolution = keyof typeof RELIABILITY_LIMITS.generatedImages;
export type AssetMimeType = "image/png" | "image/jpeg" | "image/webp";
export type VisualTargetKind = "master" | "focus";
export type FallbackChoice = "compatible-1k";

export interface AssetMetadata {
  assetId: AssetId;
  mimeType: AssetMimeType;
  byteLength: number;
  width: number;
  height: number;
  sha256: string;
  resolverUrl: `cloudinn-asset://${string}`;
}

export interface ProviderCredentialHealth {
  state: ProviderCredentialState;
}

export type ProviderReachability = "unknown" | "reachable" | "unreachable";

export interface ProviderHealth {
  credential: ProviderCredentialHealth;
  reachability: ProviderReachability;
  primaryModelAvailable: boolean | null;
  fallbackModelAvailable: boolean | null;
  checkedAtMs: number | null;
  errorCode?: ReliabilityErrorCode;
}

export interface WritableProviderPreferences {
  dailyRequestCeiling: number;
  requireSendConfirmation: boolean;
  allowAutomatic1kFallback: boolean;
}

export interface ProviderPreferencesProjection
  extends WritableProviderPreferences {
  preferencesRevision: number;
  lastQuotaDay: number;
  effectiveQuotaDay: number;
  usedAttempts: number;
  updatedAtMs: number;
}

export interface VisualJobRequest {
  targetKind: VisualTargetKind;
  prompt: string;
  resolution: ImageResolution;
  referenceAssetIds: readonly AssetId[];
}

export interface VisualJobProjection {
  jobId: GenerationJobId;
  saveId: SaveId;
  jobRevision: number;
  status: JobStatus;
  targetKind: VisualTargetKind;
  targetFingerprint: string;
  requestFingerprint: string;
  resolution: ImageResolution;
  selectedModel: string | null;
  attemptCount: number;
  nextAttemptAtMs: number | null;
  asset: AssetMetadata | null;
  errorCode: ReliabilityErrorCode | null;
  responseAmbiguous: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SaveSummary {
  saveId: SaveId;
  displayName: string;
  metadataRevision: number;
  gameRevision: Revision;
  currentDay: number;
  roomCount: number;
  schemaHealthy: boolean;
  recoveryAvailable: boolean;
  lastPlayedAtMs: number;
}

export type RecoveryPointKind = "automatic" | "pre-upgrade" | "pre-restore";

export interface RecoveryPointSummary {
  recoveryId: RecoveryId;
  kind: RecoveryPointKind;
  restoreRevision: Revision;
  reason: string;
  createdAtMs: number;
}

export interface RestoreRecoveryResult {
  saveId: SaveId;
  revision: Revision;
}

export interface ArchiveExportResult {
  archiveVersion: CloudInnArchiveVersion;
  suggestedFileName: string;
  byteLength: number;
  sha256: string;
}

export interface ImportInspection {
  token: ImportInspectionToken;
  archiveVersion: CloudInnArchiveVersion;
  sourceSaveId: SaveId;
  displayName: string;
  schemaVersion: number;
  rulesetVersion: string;
  assetCount: number;
  totalBytes: number;
  expiresAtMs: number;
}

export interface EnqueueVisualJobInput {
  saveId: SaveId;
  request: VisualJobRequest;
  expectedRevision: Revision;
  targetFingerprint: string;
}

export interface ChooseVisualFallbackInput {
  saveId: SaveId;
  jobId: GenerationJobId;
  expectedJobRevision: number;
  choice: FallbackChoice;
}

export interface RetryVisualJobInput {
  saveId: SaveId;
  jobId: GenerationJobId;
  expectedJobRevision: number;
}

export interface CancelVisualJobInput {
  saveId: SaveId;
  jobId: GenerationJobId;
  expectedJobRevision: number;
}

export interface ConfirmVisualSendInput {
  saveId: SaveId;
  jobId: GenerationJobId;
  expectedJobRevision: number;
}

export interface ConfirmVisualAdoptionInput {
  saveId: SaveId;
  jobId: GenerationJobId;
  expectedJobRevision: number;
  expectedRevision: Revision;
  targetFingerprint: string;
}

export interface VisualAdoptionResult {
  job: VisualJobProjection;
  gameRevision: Revision;
}

const TOKEN_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export function assertProviderTokenInput(token: string): string {
  const byteLength = new TextEncoder().encode(token).byteLength;
  const { minimum, maximum } = RELIABILITY_LIMITS.providerTokenUtf8Bytes;

  if (byteLength < minimum || byteLength > maximum) {
    throw new Error("provider token length is invalid");
  }
  if (TOKEN_CONTROL_PATTERN.test(token)) {
    throw new Error("provider token contains a forbidden control character");
  }
  if (token.trim() !== token) {
    throw new Error("provider token has forbidden surrounding whitespace");
  }

  return token;
}

export function isReliabilityErrorCode(
  value: unknown,
): value is ReliabilityErrorCode {
  return (
    typeof value === "string" &&
    (RELIABILITY_ERROR_CODES as readonly string[]).includes(value)
  );
}
