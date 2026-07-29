import { describe, expect, it } from "vitest";
import type { SaveId } from "../primitives";
import {
  CLOUD_INN_ARCHIVE_VERSION,
  JOB_STATUSES,
  PROVIDER_CREDENTIAL_STATES,
  RELIABILITY_ERROR_CODES,
  RELIABILITY_LIMITS,
  assertProviderTokenInput,
  isReliabilityErrorCode,
  type AssetId,
  type AssetMetadata,
  type GenerationJobId,
  type ProviderPreferencesProjection,
  type SaveSummary,
  type VisualJobProjection,
} from "./reliabilityTypes";

const MIB = 1_024 * 1_024;

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;

  Object.entries(value).forEach(([key, child]) => {
    keys.add(key);
    collectKeys(child, keys);
  });
  return keys;
}

describe("Phase 5 reliability contracts", () => {
  it("freezes the single durable job status vocabulary", () => {
    expect(JOB_STATUSES).toEqual([
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
    ]);
    expect(new Set(JOB_STATUSES).size).toBe(JOB_STATUSES.length);
  });

  it("freezes the five-state credential projection", () => {
    expect(PROVIDER_CREDENTIAL_STATES).toEqual([
      "missing",
      "available",
      "locked",
      "denied",
      "unavailable",
    ]);
  });

  it("freezes archive, recovery, credential, image and provider limits", () => {
    expect(CLOUD_INN_ARCHIVE_VERSION).toBe(1);
    expect(RELIABILITY_LIMITS).toMatchObject({
      saveDisplayNameGraphemes: { minimum: 1, maximum: 40 },
      automaticRecoveryPoints: 20,
      providerTokenUtf8Bytes: { minimum: 1, maximum: 4_096 },
      promptCharacters: 12_000,
      referenceImages: {
        maximumCount: 4,
        maximumBytesEach: 32 * MIB,
      },
      generatedImages: {
        "1k": {
          maximumResponseBytes: 24 * MIB,
          maximumDecodedBytes: 16 * MIB,
        },
        "2k": {
          maximumResponseBytes: 64 * MIB,
          maximumDecodedBytes: 48 * MIB,
        },
        "4k": {
          maximumResponseBytes: 128 * MIB,
          maximumDecodedBytes: 96 * MIB,
        },
      },
      archive: {
        maximumBytes: 2 * 1_024 * MIB,
        maximumEntries: 10_000,
        maximumManifestBytes: 64 * MIB,
      },
      provider: {
        defaultDailyRequestCeiling: 10,
        minimumDailyRequestCeiling: 0,
        maximumDailyRequestCeiling: 100,
      },
    });
  });

  it("validates provider token bytes without trimming or normalizing", () => {
    const composed = "é-api-key";
    const decomposed = "e\u0301-api-key";

    expect(assertProviderTokenInput(composed)).toBe(composed);
    expect(assertProviderTokenInput(decomposed)).toBe(decomposed);
    expect(composed).not.toBe(decomposed);
    expect(assertProviderTokenInput("x".repeat(4_096))).toHaveLength(4_096);
    expect(() => assertProviderTokenInput("你".repeat(1_366))).toThrow(
      "provider token length is invalid",
    );
  });

  it.each([
    "",
    " cloud-inn-secret-sentinel",
    "cloud-inn-secret-sentinel ",
    "cloud-inn-secret-sentinel\n",
    "cloud\u0000inn-secret-sentinel",
  ])(
    "rejects an unsafe credential without echoing it: %j",
    (unsafeToken) => {
      let message = "";
      try {
        assertProviderTokenInput(unsafeToken);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toBe("");
      if (unsafeToken.length > 0) {
        expect(message).not.toContain("cloud-inn-secret-sentinel");
      }
    },
  );

  it("reuses SaveId while keeping native-issued identifiers distinct", () => {
    const saveId: SaveId = "save-1";
    const assetId = "asset-1" as AssetId;
    const jobId = "job-1" as GenerationJobId;
    const summary: SaveSummary = {
      saveId,
      displayName: "云岫酒店",
      metadataRevision: 0,
      gameRevision: 1,
      currentDay: 3,
      roomCount: 8,
      schemaHealthy: true,
      recoveryAvailable: true,
      lastPlayedAtMs: 1_000,
    };

    expect(summary.saveId).toBe("save-1");
    expect(assetId).toBe("asset-1");
    expect(jobId).toBe("job-1");
  });

  it("keeps durable job and preferences projections free of forbidden payload fields", () => {
    const resolverUrl: AssetMetadata["resolverUrl"] =
      "cloudinn-asset://asset-1";
    const preferences: ProviderPreferencesProjection = {
      preferencesRevision: 2,
      dailyRequestCeiling: 10,
      requireSendConfirmation: true,
      allowAutomatic1kFallback: false,
      lastQuotaDay: 20_302,
      effectiveQuotaDay: 20_302,
      usedAttempts: 2,
      updatedAtMs: 1_000,
    };
    const job: VisualJobProjection = {
      jobId: "job-1" as GenerationJobId,
      saveId: "save-1",
      jobRevision: 3,
      status: "ready-for-review",
      targetKind: "master",
      targetFingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      resolution: "1k",
      selectedModel: "image-model",
      attemptCount: 1,
      nextAttemptAtMs: null,
      asset: {
        assetId: "asset-1" as AssetId,
        mimeType: "image/png",
        byteLength: 128,
        width: 16,
        height: 16,
        sha256: "c".repeat(64),
        resolverUrl,
      },
      errorCode: null,
      responseAmbiguous: false,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    };

    const keys = collectKeys({ preferences, job });
    [
      "token",
      "authorization",
      "rawResponse",
      "responseBody",
      "base64",
      "dataUri",
      "prompt",
      "requestJson",
      "absolutePath",
      "relativePath",
      "lastQuotaDayInput",
    ].forEach((forbidden) => expect(keys).not.toContain(forbidden));
    expect(job.asset?.resolverUrl).toMatch(/^cloudinn-asset:\/\/[^/]+$/u);
    expect(job.asset?.resolverUrl).not.toContain("..");
    expect(job.asset?.resolverUrl).not.toContain("file://");
    expect(job.asset?.resolverUrl).not.toContain("/Users/");
    expect(job.targetKind).toBe("master");
  });

  it("recognizes only the frozen stable error codes", () => {
    expect(new Set(RELIABILITY_ERROR_CODES).size).toBe(
      RELIABILITY_ERROR_CODES.length,
    );
    RELIABILITY_ERROR_CODES.forEach((code) => {
      expect(isReliabilityErrorCode(code)).toBe(true);
    });
    expect(isReliabilityErrorCode("provider.raw-response")).toBe(false);
    expect(isReliabilityErrorCode({ code: "save.not-found" })).toBe(false);
  });
});
