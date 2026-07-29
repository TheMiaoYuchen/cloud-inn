import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowProjectionSnapshot } from "../domain/flows/flowProjection";
import { HotelFlowCanvas } from "./HotelFlowCanvas";

const pixi = vi.hoisted(() => ({ applications: [] as any[], containers: [] as any[], fail: false, destroyFail: false, sprites: [] as any[] }));

vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: vi.fn() };
    renderer = { resize: vi.fn() };
    ticker = {
      callbacks: new Set<(ticker: { deltaMS: number }) => void>(),
      add: vi.fn((callback: (ticker: { deltaMS: number }) => void) => this.ticker.callbacks.add(callback)),
      remove: vi.fn((callback: (ticker: { deltaMS: number }) => void) => this.ticker.callbacks.delete(callback)),
      tick: (deltaMS: number) => this.ticker.callbacks.forEach((callback) => callback({ deltaMS })),
    };
    init = vi.fn(async () => { if (pixi.fail) throw new Error("no canvas"); });
    destroy = vi.fn(() => { if (pixi.destroyFail) throw new Error("partial init"); });
    constructor() { pixi.applications.push(this); }
  },
  Container: class {
    addChild = vi.fn();
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
    constructor() { pixi.containers.push(this); }
  },
  Sprite: class {
    anchor = { set: vi.fn() };
    x = 0;
    y = 0;
    position = { set: vi.fn((x: number, y: number) => { this.x = x; this.y = y; }) };
    visible = true;
    tint = 0;
    width = 0;
    height = 0;
    eventMode = "none";
    constructor(public texture: unknown) { pixi.sprites.push(this); }
  },
  Texture: { WHITE: { shared: true } },
}));

const resizeObservers: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = [];

class ResizeObserverStub {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
  constructor(public callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }
}

const snapshot: FlowProjectionSnapshot = {
  day: 1, floorId: "floor:28", width: 240, height: 600,
  events: [
    { id: "flow:a", kind: "guest", label: "宾客", count: 10, x: 20, y: 20, targetX: 100, targetY: 100 },
    { id: "flow:b", kind: "guest", label: "宾客", count: 8, x: 9_000, y: 9_000, targetX: 9_000, targetY: 9_000 },
    { id: "flow:c", kind: "staff", label: "员工", count: 3, x: 30, y: 30, targetX: 80, targetY: 80 },
  ],
};

describe("HotelFlowCanvas", () => {
  beforeEach(() => {
    pixi.applications.length = 0;
    pixi.containers.length = 0;
    pixi.sprites.length = 0;
    pixi.fail = false;
    pixi.destroyFail = false;
    resizeObservers.length = 0;
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates one application, pools sprites by kind, culls offscreen events, and cleans up", async () => {
    const view = render(<HotelFlowCanvas snapshot={snapshot} />);
    await screen.findByTestId("hotel-flow-canvas");

    expect(pixi.applications).toHaveLength(1);
    expect(pixi.sprites).toHaveLength(3);
    expect(pixi.sprites.filter(({ visible }) => visible)).toHaveLength(2);
    expect(new Set(pixi.sprites.map(({ texture }) => texture))).toHaveLength(1);

    fireEvent.wheel(screen.getByTestId("hotel-flow-host"), { deltaY: -100 });
    expect(pixi.applications).toHaveLength(1);
    view.rerender(<HotelFlowCanvas snapshot={{ ...snapshot, day: 2, events: snapshot.events.slice(0, 2) }} />);
    expect(pixi.sprites).toHaveLength(3);
    await waitFor(() => expect(pixi.sprites.filter(({ visible }) => visible)).toHaveLength(1));
    fireEvent.wheel(screen.getByTestId("hotel-flow-host"), { deltaY: 100 });
    expect(pixi.sprites.filter(({ visible }) => visible)).toHaveLength(1);
    view.unmount();
    expect(pixi.applications[0].destroy).toHaveBeenCalledWith(true, { children: true });
  });

  it("keeps a DOM world layer on the exact same initial, pan, zoom, and resize transform", async () => {
    const worldLayerRef = createRef<HTMLDivElement>();
    const view = render(<>
      <div ref={worldLayerRef} data-testid="dom-world">
        <button type="button">room</button>
        <span data-testid="dom-point" style={{ position: "absolute", left: 20, top: 20 }} />
      </div>
      <HotelFlowCanvas snapshot={snapshot} worldLayerRef={worldLayerRef} />
    </>);
    await screen.findByTestId("hotel-flow-canvas");
    const host = screen.getByTestId("hotel-flow-host");
    const layer = screen.getByTestId("dom-world");

    expect(layer.style.width).toBe("240px");
    expect(layer.style.height).toBe("600px");
    expect(layer.dataset.viewportTransform).toBe("0,0,1");
    expect(pixi.containers[0].position.set).toHaveBeenLastCalledWith(0, 0);
    expect(pixi.containers[0].scale.set).toHaveBeenLastCalledWith(1);
    expect(pixi.sprites[0].x).toBe(20);
    expect(screen.getByTestId("dom-point")).toHaveStyle({ left: "20px", top: "20px" });

    fireEvent.wheel(host, { deltaY: -100 });
    expect(layer.dataset.viewportTransform).toBe("0,0,1.12");
    expect(pixi.containers[0].position.set).toHaveBeenLastCalledWith(0, 0);
    expect(pixi.containers[0].scale.set).toHaveBeenLastCalledWith(1.12);

    view.rerender(<>
      <div ref={worldLayerRef} data-testid="dom-world">
        <button type="button">room</button>
        <span data-testid="dom-point" style={{ position: "absolute", left: 20, top: 20 }} />
      </div>
      <HotelFlowCanvas
        snapshot={{
          ...snapshot,
          floorId: "floor:29",
          height: 240,
          events: [{
            ...snapshot.events[0],
            id: "flow:floor-29",
            x: 20,
            y: 230,
            targetX: 100,
            targetY: 230,
          }],
        }}
        worldLayerRef={worldLayerRef}
      />
    </>);
    expect(layer.style.width).toBe("240px");
    expect(layer.style.height).toBe("240px");
    expect(layer.dataset.viewportTransform).toBe("0,180,1");
    expect(pixi.containers[0].position.set).toHaveBeenLastCalledWith(0, 180);
    expect(pixi.containers[0].scale.set).toHaveBeenLastCalledWith(1);
    expect(pixi.sprites[0].visible).toBe(true);

    Object.defineProperty(host, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 180 });
    resizeObservers[0].callback([], resizeObservers[0] as unknown as ResizeObserver);
    expect(layer.dataset.viewportTransform).toBe("0,0,1");
    expect(pixi.containers[0].position.set).toHaveBeenLastCalledWith(0, 0);
    expect(pixi.sprites[0].visible).toBe(false);
    expect(screen.getByRole("button", { name: "room" })).toBeEnabled();
  });

  it("shows an accessible static fallback when Pixi initialization fails", async () => {
    pixi.fail = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<HotelFlowCanvas snapshot={snapshot} />);

    expect(await screen.findByRole("status")).toHaveTextContent("流动图暂不可用");
    expect(screen.getByText("本层聚合流动 3 组")).toBeInTheDocument();
    expect(pixi.applications[0].destroy).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("animates active sprites deterministically along each path and removes its single ticker callback", async () => {
    const animatedSnapshot: FlowProjectionSnapshot = {
      ...snapshot,
      events: [snapshot.events[0], snapshot.events[2]],
    };
    const before = structuredClone(animatedSnapshot);
    const view = render(<HotelFlowCanvas snapshot={animatedSnapshot} />);
    await screen.findByTestId("hotel-flow-canvas");
    const app = pixi.applications[0];
    const host = screen.getByTestId("hotel-flow-host");

    expect(app.ticker.add).toHaveBeenCalledOnce();
    expect(host).toHaveAttribute("data-flow-animation-tick", "0");
    expect(host).toHaveAttribute("data-flow-animation-distance", "0.00");
    app.ticker.tick(500);
    expect(host).toHaveAttribute("data-flow-animation-tick", "1");
    expect(host).toHaveAttribute("data-flow-animation-sample", "60.00,60.00");
    expect(Number(host.dataset.flowAnimationDistance)).toBeGreaterThan(0);
    expect([pixi.sprites[0].x, pixi.sprites[0].y]).toEqual([60, 60]);
    expect([pixi.sprites[1].x, pixi.sprites[1].y]).toEqual([55, 55]);
    app.ticker.tick(500);
    expect([pixi.sprites[0].x, pixi.sprites[0].y]).toEqual([100, 100]);
    app.ticker.tick(500);
    expect([pixi.sprites[0].x, pixi.sprites[0].y]).toEqual([60, 60]);

    view.rerender(<HotelFlowCanvas snapshot={{ ...animatedSnapshot, events: [animatedSnapshot.events[0]] }} />);
    await waitFor(() => expect(pixi.sprites[1].visible).toBe(false));
    const inactivePosition = [pixi.sprites[1].x, pixi.sprites[1].y];
    app.ticker.tick(250);
    expect([pixi.sprites[1].x, pixi.sprites[1].y]).toEqual(inactivePosition);
    expect(pixi.sprites[1].visible).toBe(false);
    expect(animatedSnapshot).toEqual(before);

    view.unmount();
    expect(app.ticker.remove).toHaveBeenCalledOnce();
    expect(app.ticker.callbacks.size).toBe(0);
  });

  it("reclamps and reculls animated positions immediately after resize", async () => {
    render(<HotelFlowCanvas snapshot={{ ...snapshot, events: [snapshot.events[0]] }} />);
    await screen.findByTestId("hotel-flow-canvas");
    const app = pixi.applications[0];
    app.ticker.tick(500);
    expect([pixi.sprites[0].x, pixi.sprites[0].y]).toEqual([60, 60]);

    const host = screen.getByTestId("hotel-flow-host");
    fireEvent.pointerDown(host, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(host, { pointerId: 2, clientX: 100, clientY: 0 });
    expect(pixi.sprites[0].visible).toBe(true);
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 40 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 100 });
    resizeObservers[0].callback([], resizeObservers[0] as unknown as ResizeObserver);

    expect(app.renderer.resize).toHaveBeenLastCalledWith(40, 100);
    expect(pixi.containers[0].position.set).toHaveBeenLastCalledWith(0, 0);
    expect(pixi.sprites[0].visible).toBe(false);
  });

  it("resets a reused slot for a new event identity while preserving the same event phase", async () => {
    const view = render(<HotelFlowCanvas snapshot={{ ...snapshot, events: [snapshot.events[0]] }} />);
    await screen.findByTestId("hotel-flow-canvas");
    const app = pixi.applications[0];
    app.ticker.tick(500);
    expect([pixi.sprites[0].x, pixi.sprites[0].y]).toEqual([60, 60]);

    view.rerender(<HotelFlowCanvas snapshot={{
      ...snapshot,
      day: 2,
      events: [{ ...snapshot.events[0], label: "same identity" }],
    }} />);
    app.ticker.tick(250);
    expect([pixi.sprites[0].x, pixi.sprites[0].y]).toEqual([80, 80]);

    view.rerender(<HotelFlowCanvas snapshot={{
      ...snapshot,
      day: 3,
      events: [{ ...snapshot.events[0], id: "flow:replacement" }],
    }} />);
    app.ticker.tick(250);
    expect([pixi.sprites[0].x, pixi.sprites[0].y]).toEqual([40, 40]);
  });

  it("still shows the fallback when a partially initialized Pixi app cannot clean up", async () => {
    pixi.fail = true;
    pixi.destroyFail = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<HotelFlowCanvas snapshot={snapshot} />);

    expect(await screen.findByRole("status")).toHaveTextContent("流动图暂不可用");
    expect(pixi.applications[0].destroy).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("destroys delayed initialization after unmount without appending a canvas", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const view = render(<HotelFlowCanvas snapshot={snapshot} initializeForTest={() => pending} />);
    const app = pixi.applications[0];
    view.unmount();
    release();

    await waitFor(() => expect(app.destroy).toHaveBeenCalledOnce());
    expect(app.canvas).not.toBeInTheDocument();
  });
});
