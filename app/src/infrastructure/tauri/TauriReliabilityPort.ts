import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ReliabilityPort } from "../../application/ports/ReliabilityPort";
import type { SaveId } from "../../domain/primitives";
import type { SaveSummary } from "../../domain/reliability/reliabilityTypes";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Native implementation for the save-management subset of ReliabilityPort. */
export class TauriReliabilityPort implements Pick<
  ReliabilityPort,
  "listSaves" | "createSave" | "renameSave"
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
}
