import type { GameState } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  return value as JsonObject;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validateVisualTree(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(validateVisualTree);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const candidate = value as JsonObject;
  if ("assetPath" in candidate) {
    const path = candidate.assetPath;
    if (typeof path !== "string" || !path.startsWith("/visuals/") || path.includes("..")) {
      throw new Error("浏览器存档已损坏，无法加载");
    }
  }
  Object.values(candidate).forEach(validateVisualTree);
}

function validatePhase2(value: unknown): void {
  const phase2 = object(value);
  if (
    !("hotelGene" in phase2) ||
    !("roomMaster" in phase2) ||
    !Array.isArray(phase2.roomVariants) ||
    !("corridorTemplate" in phase2)
  ) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  const serialized = JSON.stringify(phase2).toLowerCase();
  if (["base64", "api_key", "api-key", "token", "secret"].some((term) => serialized.includes(term))) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  validateVisualTree(phase2);
}

export function validateBrowserGameState(
  value: unknown,
  expectedSaveId: SaveId,
): GameState {
  const game = object(value);
  if (
    game.schemaVersion !== 1 ||
    typeof game.rulesetVersion !== "string" ||
    game.saveId !== expectedSaveId ||
    !safeInteger(game.revision) ||
    !["design", "floor", "ready", "open"].includes(String(game.phase)) ||
    !safeInteger(game.currentDay) ||
    !safeInteger(game.cashCents) ||
    !safeInteger(game.rateCents) ||
    !(game.roomBlueprint === null || typeof game.roomBlueprint === "object") ||
    !Array.isArray(object(game.floor).rooms) ||
    !Array.isArray(game.reports) ||
    !(game.latestReport === null || typeof game.latestReport === "object")
  ) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  if (game.phase2 !== undefined) validatePhase2(game.phase2);
  return structuredClone(game) as unknown as GameState;
}
