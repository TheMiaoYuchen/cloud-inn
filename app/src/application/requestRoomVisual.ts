import type { RoomBlueprint } from "../domain/game/state";
import type { VisualProvider } from "./ports/VisualProvider";

export async function requestRoomVisual(
  room: RoomBlueprint,
  provider: VisualProvider,
): Promise<RoomBlueprint> {
  try {
    const result = await provider.generate(room);
    return { ...room, visual: { status: "ready", assetPath: result.assetPath } };
  } catch (error) {
    return {
      ...room,
      visual: {
        status: "error",
        message: error instanceof Error ? error.message : "效果图生成失败",
      },
    };
  }
}
