import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { SavePort } from "../../application/ports/SavePort";
import type { GameState } from "../../domain/game/state";
import { validatePhase4State } from "../browser/validatePhase4State";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriSavePort implements SavePort {
  constructor(private readonly invoke: Invoke = tauriInvoke) {}

  load(saveId: string): Promise<GameState | null> {
    return this.invoke<GameState | null>("load_game", { saveId });
  }

  async commit(expectedRevision: number, game: GameState): Promise<void> {
    if (game.phase4 !== undefined) validatePhase4State(game.phase4, game);
    await this.invoke<void>("commit_game", { expectedRevision, game });
  }
}
