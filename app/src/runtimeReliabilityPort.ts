import type { ReliabilityPort } from "./application/ports/ReliabilityPort";
import { BrowserReliabilityPort } from "./infrastructure/browser/BrowserReliabilityPort";
import { TauriReliabilityPort } from "./infrastructure/tauri/TauriReliabilityPort";

export function createRuntimeReliabilityPort(hasTauri: boolean): ReliabilityPort {
  return hasTauri ? new TauriReliabilityPort() : new BrowserReliabilityPort();
}
