import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";

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
});
