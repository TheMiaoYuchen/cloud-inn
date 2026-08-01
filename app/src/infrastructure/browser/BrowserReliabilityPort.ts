import type { ReliabilityPort } from "../../application/ports/ReliabilityPort";
import { VisualJobService } from "../../application/VisualJobService";
import { createNewGame } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";
import {
  JOB_STATUSES,
  RELIABILITY_LIMITS,
  type CancelVisualJobInput,
  type ChooseVisualFallbackInput,
  type ConfirmVisualAdoptionInput,
  type ConfirmVisualSendInput,
  type EnqueueVisualJobInput,
  type GenerationJobId,
  type ImportInspectionToken,
  type RecoveryId,
  type ProviderPreferencesProjection,
  type RetryVisualJobInput,
  type SaveSummary,
  type VisualAdoptionResult,
  type VisualJobProjection,
  type WritableProviderPreferences,
} from "../../domain/reliability/reliabilityTypes";
import { assertVisualJobTransition } from "../../domain/visualJobs/visualJob";
import { LocalStorageSavePort } from "./LocalStorageSavePort";

const METADATA_PREFIX = "cloud-inn:save-metadata:";
const SAVE_PREFIX = "cloud-inn:save:";
const JOBS_PREFIX = "cloud-inn:visual-jobs:";
const PREFERENCES_KEY = "cloud-inn:provider-preferences";
const DAY_MS = 86_400_000;
const BROWSER_FALLBACK_MODEL = "browser-offline-compatible-1k";

type BrowserSaveMetadata = { displayName: string; metadataRevision: number; createdAtMs: number; renamedAtMs: number };
type BrowserPreferences = WritableProviderPreferences & {
  preferencesRevision: number;
  lastQuotaDay: number;
  updatedAtMs: number;
};

function normalizeName(value: string): string {
  const name = value.trim().normalize("NFC");
  const Segmenter = (Intl as unknown as {
    Segmenter?: new () => { segment(value: string): Iterable<unknown> };
  }).Segmenter;
  const graphemes = Segmenter
    ? [...new Segmenter().segment(name)].length
    : Array.from(name).length;
  if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name) || graphemes > 40) {
    throw new Error("存档名称无效");
  }
  return name;
}

function getMetadata(saveId: string): BrowserSaveMetadata | null {
  const value = window.localStorage.getItem(`${METADATA_PREFIX}${saveId}`);
  if (!value) return null;
  try {
    const metadata: unknown = JSON.parse(value);
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
    const candidate = metadata as Partial<BrowserSaveMetadata>;
    if (typeof candidate.displayName !== "string" || !Number.isSafeInteger(candidate.metadataRevision) ||
      !Number.isSafeInteger(candidate.createdAtMs) || !Number.isSafeInteger(candidate.renamedAtMs)) return null;
    return candidate as BrowserSaveMetadata;
  } catch { return null; }
}

function stableFingerprint(value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const word = (hash >>> 0).toString(16).padStart(8, "0");
  return word.repeat(8);
}

function jobStorageKey(saveId: SaveId): string {
  return `${JOBS_PREFIX}${saveId}`;
}

function isVisualJob(value: unknown, saveId: SaveId): value is VisualJobProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const job = value as Partial<VisualJobProjection>;
  return job.saveId === saveId
    && typeof job.jobId === "string"
    && Number.isSafeInteger(job.jobRevision)
    && JOB_STATUSES.some((status) => status === job.status)
    && (job.targetKind === "master" || job.targetKind === "focus")
    && (job.resolution === "1k" || job.resolution === "2k" || job.resolution === "4k")
    && Number.isSafeInteger(job.attemptCount)
    && Number.isSafeInteger(job.createdAtMs)
    && Number.isSafeInteger(job.updatedAtMs);
}

function readJobs(saveId: SaveId): VisualJobProjection[] {
  const raw = window.localStorage.getItem(jobStorageKey(saveId));
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((job) => isVisualJob(job, saveId))) {
      throw new Error("provider.control-invalid");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "provider.control-invalid") throw error;
    throw new Error("provider.control-invalid");
  }
}

function writeJobs(saveId: SaveId, jobs: readonly VisualJobProjection[]): void {
  window.localStorage.setItem(jobStorageKey(saveId), JSON.stringify(jobs));
}

function defaultPreferences(day: number, nowMs: number): BrowserPreferences {
  return {
    preferencesRevision: 0,
    dailyRequestCeiling: RELIABILITY_LIMITS.provider.defaultDailyRequestCeiling,
    requireSendConfirmation: true,
    allowAutomatic1kFallback: false,
    lastQuotaDay: day,
    updatedAtMs: nowMs,
  };
}

function readPreferences(day: number, nowMs: number): BrowserPreferences {
  const raw = window.localStorage.getItem(PREFERENCES_KEY);
  if (raw === null) {
    const initial = defaultPreferences(day, nowMs);
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(initial));
    return initial;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const candidate = value as Partial<BrowserPreferences>;
    if (!Number.isSafeInteger(candidate.preferencesRevision)
      || !Number.isSafeInteger(candidate.dailyRequestCeiling)
      || candidate.dailyRequestCeiling! < RELIABILITY_LIMITS.provider.minimumDailyRequestCeiling
      || candidate.dailyRequestCeiling! > RELIABILITY_LIMITS.provider.maximumDailyRequestCeiling
      || typeof candidate.requireSendConfirmation !== "boolean"
      || typeof candidate.allowAutomatic1kFallback !== "boolean"
      || !Number.isSafeInteger(candidate.lastQuotaDay)
      || !Number.isSafeInteger(candidate.updatedAtMs)) throw new Error();
    return candidate as BrowserPreferences;
  } catch {
    throw new Error("provider.control-invalid");
  }
}

/** Deterministic browser-only equivalent used by UI tests and the web fallback. */
export class BrowserReliabilityPort implements ReliabilityPort {
  private readonly jobs: VisualJobService;

  constructor(
    private readonly savePort = new LocalStorageSavePort(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.jobs = new VisualJobService({
      enqueueVisualJob: (input) => this.persistEnqueuedJob(input),
      listVisualJobs: (saveId) => this.readVisualJobs(saveId),
      retryVisualJob: (input) => this.persistJobTransition(input, "queued"),
      cancelVisualJob: (input) => this.persistJobTransition(input, "cancelled"),
    });
  }

  async listSaves(): Promise<readonly SaveSummary[]> {
    const summaries: SaveSummary[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(SAVE_PREFIX)) continue;
      const saveId = key.slice(SAVE_PREFIX.length);
      let metadata = getMetadata(saveId);
      try {
        const game = await this.savePort.load(saveId);
        if (!game) continue;
        if (!metadata) {
          const nowMs = this.now();
          metadata = {
            displayName: saveId === "save-1" ? "Cloud Inn" : saveId,
            metadataRevision: 0,
            createdAtMs: nowMs,
            renamedAtMs: nowMs,
          };
          window.localStorage.setItem(`${METADATA_PREFIX}${saveId}`, JSON.stringify(metadata));
        }
        summaries.push({ saveId, displayName: metadata.displayName, metadataRevision: metadata.metadataRevision,
          gameRevision: game.revision, currentDay: game.currentDay, roomCount: game.floor.rooms.length,
          schemaHealthy: true, recoveryAvailable: false, lastPlayedAtMs: Math.max(metadata.createdAtMs, metadata.renamedAtMs) });
      } catch { /* Invalid browser data is deliberately omitted from the chooser. */ }
    }
    return summaries.sort((left, right) => left.saveId.localeCompare(right.saveId));
  }

  async createSave(displayName: string): Promise<SaveSummary> {
    const name = normalizeName(displayName);
    let ordinal = 1;
    let saveId: SaveId;
    do { saveId = `browser-save-${ordinal.toString().padStart(4, "0")}`; ordinal += 1; }
    while (window.localStorage.getItem(`${SAVE_PREFIX}${saveId}`) !== null);
    const time = this.now();
    await this.savePort.commit(0, { ...createNewGame(saveId), revision: 1 });
    const metadata: BrowserSaveMetadata = { displayName: name, metadataRevision: 0, createdAtMs: time, renamedAtMs: time };
    window.localStorage.setItem(`${METADATA_PREFIX}${saveId}`, JSON.stringify(metadata));
    return { saveId, displayName: name, metadataRevision: 0, gameRevision: 1, currentDay: 0, roomCount: 0,
      schemaHealthy: true, recoveryAvailable: false, lastPlayedAtMs: time };
  }

  async renameSave(saveId: SaveId, displayName: string, expectedMetadataRevision: number): Promise<SaveSummary> {
    const name = normalizeName(displayName);
    const metadata = getMetadata(saveId);
    const game = await this.savePort.load(saveId);
    if (!metadata || !game) throw new Error("存档不存在");
    if (metadata.metadataRevision !== expectedMetadataRevision) throw new Error("存档已更新，请重新加载");
    const renamedAtMs = this.now();
    const next = { ...metadata, displayName: name, metadataRevision: metadata.metadataRevision + 1, renamedAtMs };
    window.localStorage.setItem(`${METADATA_PREFIX}${saveId}`, JSON.stringify(next));
    return { saveId, displayName: name, metadataRevision: next.metadataRevision, gameRevision: game.revision,
      currentDay: game.currentDay, roomCount: game.floor.rooms.length, schemaHealthy: true,
      recoveryAvailable: false, lastPlayedAtMs: Math.max(next.createdAtMs, renamedAtMs) };
  }

  async listRecoveryPoints(): Promise<readonly []> { return []; }

  async restoreRecoveryPoint(_saveId: SaveId, _recoveryId: RecoveryId): Promise<never> {
    throw new Error("recovery.not-found");
  }

  async exportSave(): Promise<never> { throw new Error("archive.export-failed"); }

  async inspectImport(): Promise<never> { throw new Error("archive.cancelled"); }

  async importSave(_token: ImportInspectionToken): Promise<never> { throw new Error("archive.import-failed"); }

  async providerTokenStatus() { return { state: "unavailable" as const }; }

  async setProviderToken(_token: string): Promise<never> { throw new Error("keychain.unavailable"); }

  async deleteProviderToken() { return { state: "unavailable" as const }; }

  async checkProvider() {
    return {
      credential: { state: "unavailable" as const },
      reachability: "unreachable" as const,
      primaryModelAvailable: null,
      fallbackModelAvailable: null,
      checkedAtMs: this.now(),
      errorCode: "network.offline" as const,
    };
  }

  async getProviderPreferences(): Promise<ProviderPreferencesProjection> {
    const nowMs = this.now();
    const day = Math.floor(nowMs / DAY_MS);
    const stored = readPreferences(day, nowMs);
    return {
      ...stored,
      effectiveQuotaDay: Math.max(day, stored.lastQuotaDay),
      usedAttempts: 0,
    };
  }

  async updateProviderPreferences(
    expectedRevision: number,
    preferences: WritableProviderPreferences,
  ): Promise<ProviderPreferencesProjection> {
    const nowMs = this.now();
    const day = Math.floor(nowMs / DAY_MS);
    const current = readPreferences(day, nowMs);
    const { minimumDailyRequestCeiling, maximumDailyRequestCeiling } = RELIABILITY_LIMITS.provider;
    if (current.preferencesRevision !== expectedRevision
      || !Number.isSafeInteger(preferences.dailyRequestCeiling)
      || preferences.dailyRequestCeiling < minimumDailyRequestCeiling
      || preferences.dailyRequestCeiling > maximumDailyRequestCeiling
      || typeof preferences.requireSendConfirmation !== "boolean"
      || typeof preferences.allowAutomatic1kFallback !== "boolean") {
      throw new Error("provider.control-invalid");
    }
    const next: BrowserPreferences = {
      ...preferences,
      preferencesRevision: current.preferencesRevision + 1,
      lastQuotaDay: Math.max(day, current.lastQuotaDay),
      updatedAtMs: nowMs,
    };
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
    return this.getProviderPreferences();
  }

  enqueueVisualJob(input: EnqueueVisualJobInput): Promise<VisualJobProjection> {
    return this.jobs.enqueue(input);
  }

  listVisualJobs(saveId: SaveId): Promise<readonly VisualJobProjection[]> {
    return this.jobs.list(saveId);
  }

  retryVisualJob(input: RetryVisualJobInput): Promise<VisualJobProjection> {
    return this.jobs.retry(input);
  }

  cancelVisualJob(input: CancelVisualJobInput): Promise<VisualJobProjection> {
    return this.jobs.cancel(input);
  }

  async chooseVisualFallback(input: ChooseVisualFallbackInput): Promise<VisualJobProjection> {
    if (input.choice !== "compatible-1k") throw new Error("provider.invalid-transition");
    const current = this.requireJob(input.saveId, input.jobId, input.expectedJobRevision);
    if (current.resolution !== "1k" || current.status !== "needs-player-confirmation") {
      throw new Error("provider.invalid-transition");
    }
    return this.replaceJob(current, {
      status: "waiting-network",
      selectedModel: BROWSER_FALLBACK_MODEL,
      errorCode: "network.offline",
    });
  }

  async confirmVisualSend(input: ConfirmVisualSendInput): Promise<VisualJobProjection> {
    const current = this.requireJob(input.saveId, input.jobId, input.expectedJobRevision);
    assertVisualJobTransition(current.status, "waiting-network");
    return this.replaceJob(current, {
      status: "waiting-network",
      errorCode: "network.offline",
    });
  }

  async confirmVisualAdoption(input: ConfirmVisualAdoptionInput): Promise<VisualAdoptionResult> {
    const current = this.requireJob(input.saveId, input.jobId, input.expectedJobRevision);
    if (current.status !== "ready-for-review" || current.asset === null
      || current.targetFingerprint !== input.targetFingerprint) {
      throw new Error("provider.invalid-transition");
    }
    const game = await this.savePort.load(input.saveId);
    if (!game) throw new Error("save.not-found");
    if (game.revision !== input.expectedRevision) throw new Error("save.conflict");
    await this.savePort.commit(game.revision, { ...game, revision: game.revision + 1 });
    const adopted = this.replaceJob(current, { status: "adopted", errorCode: null });
    return { job: adopted, gameRevision: game.revision + 1 };
  }

  private async readVisualJobs(saveId: SaveId): Promise<readonly VisualJobProjection[]> {
    return readJobs(saveId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs
        || left.jobId.localeCompare(right.jobId));
  }

  private async persistEnqueuedJob(input: EnqueueVisualJobInput): Promise<VisualJobProjection> {
    const game = await this.savePort.load(input.saveId);
    if (!game) throw new Error("save.not-found");
    if (game.revision !== input.expectedRevision) throw new Error("save.conflict");
    if (!input.request.prompt || input.request.prompt.length > RELIABILITY_LIMITS.promptCharacters
      || input.request.referenceAssetIds.length > RELIABILITY_LIMITS.referenceImages.maximumCount) {
      throw new Error("provider.invalid-request");
    }
    let ordinal = 1;
    let jobId: GenerationJobId;
    const allIds = new Set<string>();
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(JOBS_PREFIX)) continue;
      readJobs(key.slice(JOBS_PREFIX.length)).forEach((job) => allIds.add(job.jobId));
    }
    do {
      jobId = `browser-visual-job-${ordinal.toString().padStart(4, "0")}` as GenerationJobId;
      ordinal += 1;
    } while (allIds.has(jobId));
    const nowMs = this.now();
    const job: VisualJobProjection = {
      jobId,
      saveId: input.saveId,
      jobRevision: 0,
      status: "queued",
      targetKind: input.request.targetKind,
      targetFingerprint: input.targetFingerprint,
      requestFingerprint: stableFingerprint(input.request),
      resolution: input.request.resolution,
      selectedModel: null,
      attemptCount: 0,
      nextAttemptAtMs: null,
      asset: null,
      errorCode: null,
      responseAmbiguous: false,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    writeJobs(input.saveId, [...readJobs(input.saveId), job]);
    return job;
  }

  private persistJobTransition(
    input: RetryVisualJobInput | CancelVisualJobInput,
    status: "queued" | "cancelled",
  ): Promise<VisualJobProjection> {
    const current = this.requireJob(input.saveId, input.jobId, input.expectedJobRevision);
    return Promise.resolve(this.replaceJob(current, {
      status,
      errorCode: null,
      responseAmbiguous: false,
      nextAttemptAtMs: null,
    }));
  }

  private requireJob(
    saveId: SaveId,
    jobId: GenerationJobId,
    expectedJobRevision: number,
  ): VisualJobProjection {
    const current = readJobs(saveId).find((job) => job.jobId === jobId);
    if (!current) throw new Error("provider.job-not-found");
    if (current.jobRevision !== expectedJobRevision) throw new Error("provider.job-stale");
    return current;
  }

  private replaceJob(
    current: VisualJobProjection,
    patch: Partial<VisualJobProjection>,
  ): VisualJobProjection {
    assertVisualJobTransition(current.status, patch.status ?? current.status);
    const next: VisualJobProjection = {
      ...current,
      ...patch,
      jobId: current.jobId,
      saveId: current.saveId,
      jobRevision: current.jobRevision + 1,
      updatedAtMs: this.now(),
    };
    writeJobs(current.saveId, readJobs(current.saveId)
      .map((job) => job.jobId === current.jobId ? next : job));
    return next;
  }
}
