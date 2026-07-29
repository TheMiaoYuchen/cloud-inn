import { describe, expect, it } from "vitest";

import { clampViewportTransform, fitViewport, initialViewportTransform, pointInViewport } from "./viewport";

describe("fitViewport", () => {
  it("clamps dimensions and device pixel ratio", () => {
    expect(fitViewport(0, 400, 4)).toEqual({
      width: 1,
      height: 400,
      resolution: 2,
    });
  });

  it("uses valid dimensions unchanged", () => {
    expect(fitViewport(1280, 720, 1)).toEqual({
      width: 1280,
      height: 720,
      resolution: 1,
    });
  });
});

describe("flow viewport bounds", () => {
  it("clamps a large scaled world within the viewport instead of allowing it offscreen", () => {
    expect(clampViewportTransform(
      { x: 5_000, y: -5_000, scale: 9 },
      { width: 800, height: 600 },
      { width: 240, height: 600 },
    )).toEqual({ x: 40, y: -1200, scale: 3 });
  });

  it("centers a small world and computes a bounded initial fit after resize", () => {
    expect(clampViewportTransform(
      { x: 9_000, y: -9_000, scale: 1 },
      { width: 800, height: 600 },
      { width: 240, height: 200 },
    )).toEqual({ x: 280, y: 200, scale: 1 });
    expect(initialViewportTransform(
      { width: 800, height: 600 },
      { width: 240, height: 600 },
    )).toEqual({ x: 280, y: 0, scale: 1 });
    expect(initialViewportTransform(
      { width: 120, height: 180 },
      { width: 240, height: 600 },
    )).toEqual({ x: 0, y: -60, scale: 0.5 });
  });

  it("culls points outside the visible world", () => {
    expect(pointInViewport(
      { x: 20, y: 20 },
      { x: 0, y: 0, scale: 1 },
      { width: 100, height: 100 },
    )).toBe(true);
    expect(pointInViewport(
      { x: 120, y: 20 },
      { x: 0, y: 0, scale: 1 },
      { width: 100, height: 100 },
    )).toBe(false);
  });
});
