import { describe, expect, it } from "vitest";

import { createRectangle } from "./grid";
import { evaluateRoom } from "./evaluateRoom";

describe("evaluateRoom", () => {
  const bedroom = createRectangle(0, 0, 8, 8, "bedroom");
  const bathroom = createRectangle(0, 8, 8, 4, "bathroom");
  const fixture = [...bedroom, ...bathroom];

  it("returns deterministic metrics for the prototype fixture", () => {
    expect(evaluateRoom(fixture, 8, 12)).toEqual({
      areaSquareMeters: 24,
      buildCostCents: 11_600_000,
      suggestedRateCents: 80_000,
      businessFitBps: 8_500,
    });
  });

  it("scores a smaller continuous room with both zones lower", () => {
    const smallerRoom = [
      ...createRectangle(0, 0, 4, 4, "bedroom"),
      ...createRectangle(0, 4, 4, 1, "bathroom"),
    ];

    const metrics = evaluateRoom(smallerRoom, 8, 12);

    expect(metrics.buildCostCents).toBeLessThan(11_600_000);
    expect(metrics.businessFitBps).toBeLessThan(8_500);
  });

  it.each([
    {
      cells: createRectangle(0, 0, 2, 2, "bedroom"),
      reason: "原型房型需要卧室和卫浴",
    },
    {
      cells: [
        { x: 0, y: 0, zone: "bedroom" as const },
        { x: 1, y: 0, zone: "bathroom" as const },
        { x: 7, y: 11, zone: "bedroom" as const },
      ],
      reason: "房间轮廓必须连续",
    },
  ])("throws the Chinese validation reason for invalid rooms", ({ cells, reason }) => {
    expect(() => evaluateRoom(cells, 8, 12)).toThrow(reason);
  });

  it("does not mutate the input cells", () => {
    const input = [...fixture];
    const snapshot = structuredClone(input);

    evaluateRoom(input, 8, 12);

    expect(input).toEqual(snapshot);
  });
});
