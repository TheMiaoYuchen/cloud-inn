import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { SavePort } from "../../application/ports/SavePort";
import type { GameState } from "../../domain/game/state";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriSavePort implements SavePort {
  constructor(private readonly invoke: Invoke = tauriInvoke) {}

  load(saveId: string): Promise<GameState | null> {
    return this.invoke<GameState | null>("load_game", { saveId });
  }

  commit(expectedRevision: number, game: GameState): Promise<void> {
    return this.invoke<void>("commit_game", { expectedRevision, game });
  }
}
