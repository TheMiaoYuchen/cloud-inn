import { describe, expect, it } from "vitest";

import { fitViewport } from "./viewport";

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
