import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MinimalCanvas } from "./MinimalCanvas";

vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: vi.fn() };
    renderer = { resize: vi.fn() };
    init = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
  },
  Graphics: class {
    roundRect() {
      return this;
    }

    fill() {
      return this;
    }

    stroke() {
      return this;
    }
  },
}));

class ResizeObserverStub {
  observe() {}

  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

describe("MinimalCanvas", () => {
  it("provides one host for the Pixi canvas", () => {
    const { unmount } = render(<MinimalCanvas />);

    expect(screen.getAllByTestId("pixi-host")).toHaveLength(1);
    unmount();
    expect(screen.queryByTestId("pixi-host")).not.toBeInTheDocument();
  });

  it("keeps the host available when resize observation is unsupported", () => {
    vi.stubGlobal("ResizeObserver", undefined);

    expect(() => render(<MinimalCanvas />)).not.toThrow();

    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });
});
