import type { SaveId } from "../../domain/primitives";
import type {
  ArchiveExportResult,
  CancelVisualJobInput,
  ChooseVisualFallbackInput,
  ConfirmVisualAdoptionInput,
  ConfirmVisualSendInput,
  EnqueueVisualJobInput,
  ImportInspection,
  ImportInspectionToken,
  ProviderCredentialHealth,
  ProviderHealth,
  ProviderPreferencesProjection,
  RecoveryId,
  RecoveryPointSummary,
  RetryVisualJobInput,
  RestoreRecoveryResult,
  SaveSummary,
  VisualAdoptionResult,
  VisualJobProjection,
  WritableProviderPreferences,
} from "../../domain/reliability/reliabilityTypes";

export interface ReliabilityPort {
  activateSaveAssets(saveId: SaveId): Promise<void>;
  listSaves(): Promise<readonly SaveSummary[]>;
  createSave(displayName: string): Promise<SaveSummary>;
  renameSave(
    saveId: SaveId,
    displayName: string,
    expectedMetadataRevision: number,
  ): Promise<SaveSummary>;

  listRecoveryPoints(saveId: SaveId): Promise<readonly RecoveryPointSummary[]>;
  restoreRecoveryPoint(
    saveId: SaveId,
    recoveryId: RecoveryId,
  ): Promise<RestoreRecoveryResult>;

  exportSave(saveId: SaveId): Promise<ArchiveExportResult>;
  inspectImport(): Promise<ImportInspection>;
  importSave(
    token: ImportInspectionToken,
    displayName?: string,
  ): Promise<SaveSummary>;

  providerTokenStatus(): Promise<ProviderCredentialHealth>;
  setProviderToken(token: string): Promise<ProviderCredentialHealth>;
  deleteProviderToken(): Promise<ProviderCredentialHealth>;
  checkProvider(): Promise<ProviderHealth>;

  getProviderPreferences(): Promise<ProviderPreferencesProjection>;
  updateProviderPreferences(
    expectedRevision: number,
    preferences: WritableProviderPreferences,
  ): Promise<ProviderPreferencesProjection>;

  enqueueVisualJob(input: EnqueueVisualJobInput): Promise<VisualJobProjection>;
  listVisualJobs(saveId: SaveId): Promise<readonly VisualJobProjection[]>;
  retryVisualJob(input: RetryVisualJobInput): Promise<VisualJobProjection>;
  chooseVisualFallback(
    input: ChooseVisualFallbackInput,
  ): Promise<VisualJobProjection>;
  cancelVisualJob(input: CancelVisualJobInput): Promise<VisualJobProjection>;
  confirmVisualSend(
    input: ConfirmVisualSendInput,
  ): Promise<VisualJobProjection>;
  confirmVisualAdoption(
    input: ConfirmVisualAdoptionInput,
  ): Promise<VisualAdoptionResult>;
}
