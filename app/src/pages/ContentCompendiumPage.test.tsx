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
    expect(screen.getAllByText("用于公共空间布置，并参与容量或体验评估").length)
      .toBeGreaterThan(0);
    expect(screen.getAllByText("为适用餐饮设施提供菜单结构").length)
      .toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "特色产品" })).not.toBeInTheDocument();

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

  it("preserves unrelated URL parameters while changing only the selected tab", async () => {
    window.location.hash = "#/compendium?source=report&tab=market";
    const user = userEvent.setup();
    render(<App savePort={new ReadOnlyPort(createPhase4AcceptanceState("url-preservation"))} />);
    await screen.findByRole("heading", { name: "酒店百科" });

    await user.click(screen.getByRole("tab", { name: "设计系列" }));
    expect(window.location.hash).toBe("#/compendium?source=report&tab=design");

    await user.click(screen.getByRole("tab", { name: "内容目录" }));
    expect(window.location.hash).toBe("#/compendium?source=report");
  });

  it("supports roving focus and standard keyboard navigation across all tabs", async () => {
    window.location.hash = "#/compendium?source=report";
    const user = userEvent.setup();
    render(<App savePort={new ReadOnlyPort(createPhase4AcceptanceState("keyboard-tabs"))} />);
    await screen.findByRole("heading", { name: "酒店百科" });
    const content = screen.getByRole("tab", { name: "内容目录" });
    const design = screen.getByRole("tab", { name: "设计系列" });
    const market = screen.getByRole("tab", { name: "市场洞察" });

    expect([content.tabIndex, design.tabIndex, market.tabIndex]).toEqual([0, -1, -1]);
    content.focus();
    await user.keyboard("{ArrowRight}");
    expect(design).toHaveFocus();
    expect([content.tabIndex, design.tabIndex, market.tabIndex]).toEqual([-1, 0, -1]);
    expect(window.location.hash).toBe("#/compendium?source=report&tab=design");

    await user.keyboard("{End}");
    expect(market).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "市场洞察" })).toBeInTheDocument();
    expect(document.getElementById("compendium-panel-content")).toHaveAttribute("hidden");

    await user.keyboard("{ArrowRight}");
    expect(content).toHaveFocus();
    expect(window.location.hash).toBe("#/compendium?source=report");
    await user.keyboard("{Home}");
    expect(content).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(market).toHaveFocus();
  });

  it("opens the exact production floor linked from a saved design", async () => {
    const state = createPhase4AcceptanceState("usage-floor-link");
    const targetFloor = state.phase4!.floors.find(({ rooms }) => rooms.length > 0)!;
    window.location.hash = "#/compendium?tab=design";
    const user = userEvent.setup();
    render(<App savePort={new ReadOnlyPort(state)} />);

    await user.click(await screen.findByRole("link", {
      name: `查看${targetFloor.floorNumber}层`,
    }));

    expect(await screen.findByRole("region", {
      name: `${targetFloor.floorNumber}层平面工作区`,
    })).toBeInTheDocument();
  });

  it("guards the compendium route for legacy saves", async () => {
    render(<App savePort={new ReadOnlyPort(null)} />);
    expect(await screen.findByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "酒店百科" })).not.toBeInTheDocument();
  });
});
