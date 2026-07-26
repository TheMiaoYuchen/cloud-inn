import type { RoomBlueprint } from "../domain/game/state";
import type { VisualProvider } from "./ports/VisualProvider";

export async function requestRoomVisual(
  room: RoomBlueprint,
  provider: VisualProvider,
): Promise<RoomBlueprint> {
  const isolatedRoom = structuredClone(room);
  try {
    const result = await provider.generate(structuredClone(isolatedRoom));
    if (
      typeof result.assetPath !== "string" ||
      result.assetPath.length === 0 ||
      !result.assetPath.startsWith("/visuals/") ||
      result.assetPath.includes("..")
    ) {
      return {
        ...isolatedRoom,
        visual: { status: "error", message: "效果图路径无效" },
      };
    }
    return {
      ...isolatedRoom,
      visual: { status: "ready", assetPath: result.assetPath },
    };
  } catch (error) {
    return {
      ...isolatedRoom,
      visual: {
        status: "error",
        message: error instanceof Error ? error.message : "效果图生成失败",
      },
    };
  }
}
