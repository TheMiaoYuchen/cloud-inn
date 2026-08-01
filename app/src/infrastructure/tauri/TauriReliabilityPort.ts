import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ReliabilityPort } from "../../application/ports/ReliabilityPort";
import type { SaveId } from "../../domain/primitives";
import type {
  ProviderCredentialHealth,
  RecoveryPointSummary,
  SaveSummary,
} from "../../domain/reliability/reliabilityTypes";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Native implementation for the save-management subset of ReliabilityPort. */
export class TauriReliabilityPort implements Pick<
  ReliabilityPort,
  | "listSaves"
  | "createSave"
  | "renameSave"
  | "listRecoveryPoints"
  | "providerTokenStatus"
  | "setProviderToken"
  | "deleteProviderToken"
> {
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

  providerTokenStatus(): Promise<ProviderCredentialHealth> {
    return this.invoke<ProviderCredentialHealth>("provider_token_status");
  }

  setProviderToken(token: string): Promise<ProviderCredentialHealth> {
    return this.invoke<ProviderCredentialHealth>("set_provider_token", { token });
  }

  deleteProviderToken(): Promise<ProviderCredentialHealth> {
    return this.invoke<ProviderCredentialHealth>("delete_provider_token");
  }
}
