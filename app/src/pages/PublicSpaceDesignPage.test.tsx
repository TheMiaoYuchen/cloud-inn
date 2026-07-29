import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../app/App";
import { FACILITY_CATALOG } from "../domain/content/contentCatalog";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";

describe("public-space design page", () => {
  beforeEach(() => { window.location.hash = "#/public-spaces/design"; });

  async function renderScaleApp() {
    const state = createPhase4AcceptanceState("save-1");
    state.revision = 1;
    const port = new InMemorySavePort();
    await port.commit(0, state);
    render(<App savePort={port} />);
    return { port, state };
  }

  it("offers all catalog space types and blocks a restaurant without a kitchen", async () => {
    await renderScaleApp();
    const user = userEvent.setup();
    const type = await screen.findByLabelText("公共空间类型");
    expect(within(type).getAllByRole("option")).toHaveLength(FACILITY_CATALOG.length);

    await user.selectOptions(type, "all-day-dining");
    await user.click(screen.getByRole("button", { name: "验证空间" }));

    expect(screen.getByRole("alert")).toHaveTextContent("必须设置厨房或备餐区");
    expect(screen.getByRole("button", { name: "保存公共空间" })).toBeDisabled();
  });

  it("exposes one-square-metre tools, bounded cells, openings, items, metrics and history", async () => {
    await renderScaleApp();
    const user = userEvent.setup();
    expect(await screen.findByText("每格 1㎡")).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell").length).toBeLessThanOrEqual(576);
    expect(screen.getByLabelText("空间分区")).toBeInTheDocument();
    expect(screen.getByLabelText("空间物件")).toBeInTheDocument();
    expect(screen.getByLabelText("开口类型")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "空间指标" })).toHaveTextContent("建造成本");

    const undo = screen.getByRole("button", { name: "撤销" });
    const redo = screen.getByRole("button", { name: "重做" });
    expect(undo).toBeDisabled();
    await user.click(screen.getAllByRole("gridcell")[0]);
    expect(undo).toBeEnabled();
    await user.click(undo);
    expect(redo).toBeEnabled();
  });

  it("keeps blueprint save separate from floor placement", async () => {
    await renderScaleApp();
    expect(await screen.findByRole("button", { name: "保存公共空间" })).toBeInTheDocument();
    expect(screen.getByLabelText("放置楼层")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并放置" })).toBeInTheDocument();
  });

  it("persists a valid blueprint without placing it", async () => {
    const { port, state } = await renderScaleApp();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("公共空间类型"), "gym");
    const cells = screen.getAllByRole("gridcell");
    for (const cell of cells.slice(0, 4)) await user.click(cell);
    await user.click(screen.getByRole("button", { name: "放置物件" }));
    for (const cell of cells.slice(0, 4)) await user.click(cell);
    await user.clear(screen.getByLabelText("空间名称"));
    await user.type(screen.getByLabelText("空间名称"), "云端健身中心");
    await user.click(screen.getByRole("button", { name: "保存公共空间" }));
    expect(await screen.findByRole("status")).toHaveTextContent("公共空间蓝图已保存");
    const saved = await port.load(state.saveId);
    expect(saved?.phase4?.spaceBlueprints["space-blueprint:gym:custom"].name).toBe("云端健身中心");
    expect(saved?.phase4?.publicSpaces).toEqual(state.phase4!.publicSpaces);
  });
});
