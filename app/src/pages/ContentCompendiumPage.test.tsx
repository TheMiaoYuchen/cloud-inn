import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { SavePort } from "../application/ports/SavePort";
import type { GameState } from "../domain/game/state";
import { App } from "../app/App";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";

class ReadOnlyPort implements SavePort {
  commits = 0;
  constructor(private readonly state: GameState | null) {}
  async load() { return this.state ? structuredClone(this.state) : null; }
  async commit() { this.commits += 1; throw new Error("只读页面不得写入存档"); }
}

describe("content compendium page", () => {
  beforeEach(() => { window.location.hash = "#/compendium"; });

  it("renders exactly three accessible tabs and explains locked content without commands", async () => {
    const state = createPhase4AcceptanceState("compendium-page");
    state.phase4!.catalogProgress.unlockedIds = [];
    const port = new ReadOnlyPort(state);
    const user = userEvent.setup();
    render(<App savePort={port} />);

    expect(await screen.findByRole("heading", { name: "酒店百科" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map(({ textContent }) => textContent)).toEqual([
      "内容目录", "设计系列", "市场洞察",
    ]);
    expect(screen.getAllByText(/尚未解锁/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("tab", { name: "设计系列" }));
    expect(window.location.hash).toBe("#/compendium?tab=design");
    expect(await screen.findByRole("tabpanel", { name: "设计系列" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /查看.*层/ }).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("tab", { name: "市场洞察" }));
    expect(window.location.hash).toBe("#/compendium?tab=market");
    const market = screen.getByRole("tabpanel", { name: "市场洞察" });
    expect(within(market).getByRole("heading", { name: "商务差旅" })).toBeInTheDocument();
    expect(port.commits).toBe(0);
  });

  it("restores the selected tab from the URL and exposes the Phase 4 nav link", async () => {
    window.location.hash = "#/compendium?tab=market";
    render(<App savePort={new ReadOnlyPort(createPhase4AcceptanceState("url-tab"))} />);

    expect(await screen.findByRole("tab", { name: "市场洞察" })).toHaveAttribute(
      "aria-selected", "true",
    );
    expect(screen.getByRole("link", { name: "酒店百科" })).toHaveAttribute(
      "aria-current", "page",
    );
  });

  it("guards the compendium route for legacy saves", async () => {
    render(<App savePort={new ReadOnlyPort(null)} />);
    expect(await screen.findByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "酒店百科" })).not.toBeInTheDocument();
  });
});
