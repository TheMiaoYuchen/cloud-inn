import type { RoomBlueprint } from "../../domain/game/state";
import type { DesignVisualRequest } from "../designVisualQueue";

export interface VisualProvider {
  generate(room: RoomBlueprint, request?: DesignVisualRequest): Promise<{ assetPath: string }>;
}
