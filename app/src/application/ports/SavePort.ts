import type { GameState } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";

export interface SavePort {
  load(saveId: SaveId): Promise<GameState | null>;
  commit(expectedRevision: number, next: GameState): Promise<void>;
}
