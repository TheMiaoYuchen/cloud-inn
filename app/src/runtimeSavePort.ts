import type { SavePort } from "./application/ports/SavePort";
import { InMemorySavePort } from "./infrastructure/memory/InMemorySavePort";
import { TauriSavePort } from "./infrastructure/tauri/TauriSavePort";

export function createRuntimeSavePort(hasTauri: boolean): SavePort {
  return hasTauri ? new TauriSavePort() : new InMemorySavePort();
}
