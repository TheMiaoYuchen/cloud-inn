import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowProjectionSnapshot } from "../domain/flows/flowProjection";
import { HotelFlowCanvas } from "./HotelFlowCanvas";

const pixi = vi.hoisted(() => ({ applications: [] as any[], fail: false, destroyFail: false, sprites: [] as any[] }));

vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: vi.fn() };
    renderer = { resize: vi.fn() };
    init = vi.fn(async () => { if (pixi.fail) throw new Error("no canvas"); });
    destroy = vi.fn(() => { if (pixi.destroyFail) throw new Error("partial init"); });
    constructor() { pixi.applications.push(this); }
  },
  Container: class {
    addChild = vi.fn();
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
  },
  Sprite: class {
    anchor = { set: vi.fn() };
    position = { set: vi.fn() };
    visible = true;
    tint = 0;
    width = 0;
    height = 0;
    eventMode = "none";
    constructor(public texture: unknown) { pixi.sprites.push(this); }
  },
  Texture: { WHITE: { shared: true } },
}));

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
    pixi.sprites.length = 0;
    pixi.fail = false;
    pixi.destroyFail = false;
  });

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

  it("shows an accessible static fallback when Pixi initialization fails", async () => {
    pixi.fail = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<HotelFlowCanvas snapshot={snapshot} />);

    expect(await screen.findByRole("status")).toHaveTextContent("流动图暂不可用");
    expect(screen.getByText("本层聚合流动 3 组")).toBeInTheDocument();
    expect(pixi.applications[0].destroy).toHaveBeenCalledOnce();
    error.mockRestore();
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
