import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";

vi.mock("../canvas/MinimalCanvas", () => ({
  MinimalCanvas: () => <div data-testid="pixi-host" />,
}));

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "#/";
  });

  it("opens on the hotel overview", () => {
    render(<App savePort={new InMemorySavePort()} />);
    expect(screen.getByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
  });

  it("navigates to and from the canvas", async () => {
    const user = userEvent.setup();
    render(<App savePort={new InMemorySavePort()} />);
    await user.click(screen.getByRole("link", { name: "楼层画布" }));
    expect(screen.getByRole("heading", { name: "楼层画布" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "酒店总览" }));
    expect(screen.getByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
  });

  it("disables later progress links until the saved game reaches those phases", async () => {
    render(<App savePort={new InMemorySavePort()} />);

    expect(screen.getByRole("link", { name: "设计" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "楼层" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "运营" })).toHaveAttribute("aria-disabled", "true");

    await userEvent.setup().click(screen.getByRole("link", { name: "楼层" }));
    expect(screen.getByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
  });

  it("routes Phase 4 saves and legacy tower paths to one building overview", async () => {
    const port = new InMemorySavePort();
    const state = createPhase4AcceptanceState("save-1");
    state.revision = 1;
    await port.commit(0, state);
    window.location.hash = "#/";
    const view = render(<App savePort={port} />);

    expect(await screen.findByRole("heading", { name: "云端塔楼总览" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "塔楼" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "设计" })).not.toBeInTheDocument();

    view.unmount();
    window.location.hash = "#/tower";
    render(<App savePort={port} />);
    expect(await screen.findByRole("heading", { name: "云端塔楼总览" })).toBeInTheDocument();
  });

  it("guards direct legacy building routes and converts old floor links for Phase 4", async () => {
    window.location.hash = "#/building";
    const legacyView = render(<App savePort={new InMemorySavePort()} />);
    expect(await screen.findByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();

    legacyView.unmount();
    const port = new InMemorySavePort();
    const state = createPhase4AcceptanceState("save-1");
    state.revision = 1;
    await port.commit(0, state);
    window.location.hash = "#/floor-plan";
    render(<App savePort={port} />);
    expect(await screen.findByRole("heading", { name: "云端塔楼总览" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/building");
    expect(screen.getByRole("link", { name: "塔楼" })).toHaveAttribute("aria-current", "page");
  });
});
