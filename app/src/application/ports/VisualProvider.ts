import type { RoomBlueprint } from "../../domain/game/state";

export interface VisualProvider {
  generate(room: RoomBlueprint): Promise<{ assetPath: string }>;
}
