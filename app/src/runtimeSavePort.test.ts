import { describe, expect, it } from "vitest";
import { LocalStorageSavePort } from "./infrastructure/browser/LocalStorageSavePort";
import { TauriSavePort } from "./infrastructure/tauri/TauriSavePort";
import { createRuntimeSavePort } from "./runtimeSavePort";

describe("createRuntimeSavePort", () => {
  it("uses reload-safe local persistence in a browser runtime", () => {
    expect(createRuntimeSavePort(false)).toBeInstanceOf(LocalStorageSavePort);
  });

  it("uses Tauri persistence in a desktop runtime", () => {
    expect(createRuntimeSavePort(true)).toBeInstanceOf(TauriSavePort);
  });
});
