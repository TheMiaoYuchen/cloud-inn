import type { SavePort } from "./application/ports/SavePort";
import { LocalStorageSavePort } from "./infrastructure/browser/LocalStorageSavePort";
import { TauriSavePort } from "./infrastructure/tauri/TauriSavePort";

export function createRuntimeSavePort(hasTauri: boolean): SavePort {
  return hasTauri ? new TauriSavePort() : new LocalStorageSavePort();
}
