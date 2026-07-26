import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("../canvas/MinimalCanvas", () => ({
  MinimalCanvas: () => <div data-testid="pixi-host" />,
}));

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "#/";
  });

  it("opens on the hotel overview", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
  });

  it("navigates to and from the canvas", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "楼层画布" }));
    expect(screen.getByRole("heading", { name: "楼层画布" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "酒店总览" }));
    expect(screen.getByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
  });
});
