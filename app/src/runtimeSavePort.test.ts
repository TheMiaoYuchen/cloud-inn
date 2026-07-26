import { describe, expect, it } from "vitest";
import { InMemorySavePort } from "./infrastructure/memory/InMemorySavePort";
import { TauriSavePort } from "./infrastructure/tauri/TauriSavePort";
import { createRuntimeSavePort } from "./runtimeSavePort";

describe("createRuntimeSavePort", () => {
  it("uses memory persistence in a browser runtime", () => {
    expect(createRuntimeSavePort(false)).toBeInstanceOf(InMemorySavePort);
  });

  it("uses Tauri persistence in a desktop runtime", () => {
    expect(createRuntimeSavePort(true)).toBeInstanceOf(TauriSavePort);
  });
});
