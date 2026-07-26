import type { SavePort } from "../../application/ports/SavePort";
import type { GameState } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";

export class InMemorySavePort implements SavePort {
  private readonly saves = new Map<SaveId, GameState>();

  async load(saveId: SaveId): Promise<GameState | null> {
    return structuredClone(this.saves.get(saveId) ?? null);
  }

  async commit(expectedRevision: number, next: GameState): Promise<void> {
    const current = this.saves.get(next.saveId);
    const currentRevision = current?.revision ?? 0;
    if (
      expectedRevision !== currentRevision ||
      next.revision !== expectedRevision + 1
    ) {
      throw new Error("存档已更新，请重新加载");
    }

    this.saves.set(next.saveId, structuredClone(next));
  }
}
