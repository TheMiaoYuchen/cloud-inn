import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ReliabilityPort } from "../../application/ports/ReliabilityPort";
import type { SaveId } from "../../domain/primitives";
import type {
  CancelVisualJobInput,
  ChooseVisualFallbackInput,
  ConfirmVisualAdoptionInput,
  ConfirmVisualSendInput,
  EnqueueVisualJobInput,
  ArchiveExportResult,
  ImportInspection,
  ImportInspectionToken,
  ProviderCredentialHealth,
  ProviderHealth,
  ProviderPreferencesProjection,
  RecoveryId,
  RecoveryPointSummary,
  RestoreRecoveryResult,
  RetryVisualJobInput,
  SaveSummary,
  VisualAdoptionResult,
  VisualJobProjection,
  WritableProviderPreferences,
} from "../../domain/reliability/reliabilityTypes";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Typed native boundary. Provider work remains wholly inside Rust. */
export class TauriReliabilityPort implements ReliabilityPort {
  constructor(private readonly invoke: Invoke = tauriInvoke) {}

  listSaves(): Promise<readonly SaveSummary[]> {
    return this.invoke<SaveSummary[]>("list_saves");
  }

  createSave(displayName: string): Promise<SaveSummary> {
    return this.invoke<SaveSummary>("create_save", { displayName });
  }

  renameSave(
    saveId: SaveId,
    displayName: string,
    expectedMetadataRevision: number,
  ): Promise<SaveSummary> {
    return this.invoke<SaveSummary>("rename_save", {
      saveId,
      displayName,
      expectedMetadataRevision,
    });
  }

  listRecoveryPoints(saveId: SaveId): Promise<readonly RecoveryPointSummary[]> {
    return this.invoke<RecoveryPointSummary[]>("list_recovery_points", { saveId });
  }

  restoreRecoveryPoint(saveId: SaveId, recoveryId: RecoveryId): Promise<RestoreRecoveryResult> {
    return this.invoke<RestoreRecoveryResult>("restore_recovery_point", { saveId, recoveryId });
  }

  exportSave(saveId: SaveId): Promise<ArchiveExportResult> {
    return this.invoke<ArchiveExportResult>("export_save", { saveId });
  }

  inspectImport(): Promise<ImportInspection> {
    return this.invoke<ImportInspection>("inspect_import");
  }

  importSave(token: ImportInspectionToken, displayName?: string): Promise<SaveSummary> {
    return this.invoke<SaveSummary>("import_save", { token, displayName });
  }

  providerTokenStatus(): Promise<ProviderCredentialHealth> {
    return this.invoke<ProviderCredentialHealth>("provider_token_status");
  }

  setProviderToken(token: string): Promise<ProviderCredentialHealth> {
    return this.invoke<ProviderCredentialHealth>("set_provider_token", { token });
  }

  deleteProviderToken(): Promise<ProviderCredentialHealth> {
    return this.invoke<ProviderCredentialHealth>("delete_provider_token");
  }

  checkProvider(): Promise<ProviderHealth> {
    return this.invoke<ProviderHealth>("check_provider");
  }

  getProviderPreferences(): Promise<ProviderPreferencesProjection> {
    return this.invoke<ProviderPreferencesProjection>("get_provider_preferences");
  }

  updateProviderPreferences(
    expectedRevision: number,
    preferences: WritableProviderPreferences,
  ): Promise<ProviderPreferencesProjection> {
    return this.invoke<ProviderPreferencesProjection>(
      "update_provider_preferences",
      { expectedRevision, preferences },
    );
  }

  enqueueVisualJob(input: EnqueueVisualJobInput): Promise<VisualJobProjection> {
    return this.invoke<VisualJobProjection>("enqueue_visual_job", { ...input });
  }

  listVisualJobs(saveId: SaveId): Promise<readonly VisualJobProjection[]> {
    return this.invoke<VisualJobProjection[]>("list_visual_jobs", { saveId });
  }

  retryVisualJob(input: RetryVisualJobInput): Promise<VisualJobProjection> {
    return this.invoke<VisualJobProjection>("retry_visual_job", { ...input });
  }

  chooseVisualFallback(
    input: ChooseVisualFallbackInput,
  ): Promise<VisualJobProjection> {
    return this.invoke<VisualJobProjection>("choose_visual_fallback", { ...input });
  }

  cancelVisualJob(input: CancelVisualJobInput): Promise<VisualJobProjection> {
    return this.invoke<VisualJobProjection>("cancel_visual_job", { ...input });
  }

  confirmVisualSend(
    input: ConfirmVisualSendInput,
  ): Promise<VisualJobProjection> {
    return this.invoke<VisualJobProjection>("confirm_visual_send", { ...input });
  }

  confirmVisualAdoption(
    input: ConfirmVisualAdoptionInput,
  ): Promise<VisualAdoptionResult> {
    return this.invoke<VisualAdoptionResult>("confirm_visual_adoption", { ...input });
  }
}
