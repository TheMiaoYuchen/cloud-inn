import { describe, expect, it } from "vitest";

import type { RoomBlueprint } from "../domain/game/state";
import { requestRoomVisual } from "./requestRoomVisual";
import type { VisualProvider } from "./ports/VisualProvider";

const economics = {
  areaSquareMeters: 24,
  buildCostCents: 11_600_000,
  suggestedRateCents: 80_000,
  businessFitBps: 8_500,
};

function blueprint(): RoomBlueprint {
  return {
    id: "room-type-1",
    name: "云岫商务房",
    columns: 8,
    rows: 12,
    cells: [],
    metrics: economics,
    visual: { status: "idle" },
  };
}

describe("requestRoomVisual", () => {
  it("changes only visual state on success", async () => {
    const provider: VisualProvider = {
      generate: async () => ({ assetPath: "/visuals/prototype-room.svg" }),
    };
    const source = blueprint();
    const sourceSnapshot = structuredClone(source);

    const next = await requestRoomVisual(source, provider);

    expect(next.visual).toEqual({
      status: "ready",
      assetPath: "/visuals/prototype-room.svg",
    });
    expect(next.metrics).toEqual(economics);
    expect(next.cells).toEqual(sourceSnapshot.cells);
    expect(source).toEqual(sourceSnapshot);
  });

  it("preserves economics and converts provider errors to visual state", async () => {
    const provider: VisualProvider = {
      generate: async () => {
        throw new Error("服务不可用");
      },
    };
    const source = blueprint();
    const sourceSnapshot = structuredClone(source);

    const next = await requestRoomVisual(source, provider);

    expect(next.visual).toEqual({ status: "error", message: "服务不可用" });
    expect(next.metrics).toEqual(economics);
    expect(next.cells).toEqual(sourceSnapshot.cells);
    expect(source).toEqual(sourceSnapshot);
  });

  it("uses a fallback message for non-Error failures", async () => {
    const provider: VisualProvider = {
      generate: async () => {
        throw "offline";
      },
    };

    const next = await requestRoomVisual(blueprint(), provider);

    expect(next.visual).toEqual({ status: "error", message: "效果图生成失败" });
  });
});
