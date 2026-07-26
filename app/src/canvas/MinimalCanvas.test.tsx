import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinimalCanvas } from "./MinimalCanvas";

interface ApplicationStub {
  canvas: HTMLCanvasElement;
  renderer: { resize: ReturnType<typeof vi.fn> };
  destroy: ReturnType<typeof vi.fn>;
}

interface ResizeObserverInstance {
  callback: ResizeObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
}

const pixiState = vi.hoisted(() => ({
  applications: [] as ApplicationStub[],
  init: vi.fn<() => Promise<void>>(),
}));

vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: vi.fn() };
    renderer = { resize: vi.fn() };
    init = vi.fn(() => pixiState.init());
    destroy = vi.fn();

    constructor() {
      pixiState.applications.push(this);
    }
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

const resizeObservers: ResizeObserverInstance[] = [];

class ResizeObserverStub {
  disconnect = vi.fn();

  constructor(public callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe() {}
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe("MinimalCanvas", () => {
  beforeEach(() => {
    pixiState.applications.length = 0;
    pixiState.init.mockReset().mockResolvedValue(undefined);
    resizeObservers.length = 0;
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  it("appends the Pixi canvas after initialization completes", async () => {
    render(<MinimalCanvas />);

    const canvas = await screen.findByTestId("pixi-canvas");

    expect(screen.getByTestId("pixi-host")).toContainElement(canvas);
  });

  it("resizes the renderer when its host changes size", async () => {
    render(<MinimalCanvas />);
    await screen.findByTestId("pixi-canvas");

    resizeObservers[0].callback(
      [],
      resizeObservers[0] as unknown as ResizeObserver,
    );

    expect(pixiState.applications[0].renderer.resize).toHaveBeenCalledWith(1, 1);
  });

  it("disconnects observation and destroys the app on unmount", async () => {
    const { unmount } = render(<MinimalCanvas />);
    await screen.findByTestId("pixi-canvas");

    unmount();

    expect(resizeObservers[0].disconnect).toHaveBeenCalledOnce();
    expect(pixiState.applications[0].destroy).toHaveBeenCalledOnce();
    expect(pixiState.applications[0].destroy).toHaveBeenCalledWith(true, {
      children: true,
    });
  });

  it("reports initialization failures and destroys the failed app", async () => {
    const error = new Error("Pixi initialization failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    pixiState.init.mockRejectedValue(error);

    render(<MinimalCanvas />);

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to initialize Pixi canvas",
        error,
      );
    });
    expect(pixiState.applications[0].destroy).toHaveBeenCalledOnce();
  });

  it("destroys a delayed app without appending it after unmount", async () => {
    const init = deferred();
    pixiState.init.mockReturnValue(init.promise);
    const { unmount } = render(<MinimalCanvas />);
    const app = pixiState.applications[0];

    unmount();
    init.resolve();

    await waitFor(() => expect(app.destroy).toHaveBeenCalledOnce());
    expect(app.canvas).not.toBeInTheDocument();
  });

  it("keeps the host available when resize observation is unsupported", () => {
    vi.stubGlobal("ResizeObserver", undefined);

    expect(() => render(<MinimalCanvas />)).not.toThrow();
  });
});
