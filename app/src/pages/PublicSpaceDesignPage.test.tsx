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

  async function renderSnapshotSlotApp() {
    const state = createPhase4AcceptanceState("save-1");
    state.revision = 1;
    const floor = state.phase4!.floors.find(({ id }) => id === "floor:03")!;
    const canonical = state.phase4!.floorTemplates[floor.templateId];
    canonical.publicSpaceSlots.push({
      id: "space:99" as never,
      permittedTypes: ["all-day-dining"],
      anchorX: 1, anchorY: 2, width: 16, height: 12,
    });
    const snapshotId = `template-snapshot:${floor.id}`;
    state.phase4!.floorTemplates[snapshotId] = {
      ...structuredClone(canonical), id: snapshotId as never,
      publicSpaceSlots: canonical.publicSpaceSlots.map((slot) => slot.id === "space:99"
        ? { ...slot, anchorX: 7, anchorY: 8, width: 9, height: 9 }
        : slot),
    };
    const port = new InMemorySavePort();
    await port.commit(0, state);
    render(<App savePort={port} />);
    return { state, port, floor };
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

  it("uses the command-selected snapshot slot geometry for the placement draft", async () => {
    const { floor } = await renderSnapshotSlotApp();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("公共空间类型"), "all-day-dining");
    await user.selectOptions(screen.getByLabelText("放置楼层"), floor.id);

    expect(screen.getAllByRole("gridcell")).toHaveLength(81);
    expect(screen.getByLabelText("放置槽位")).toHaveValue("space:99");
    expect(screen.getByText(/锚点 7,8/)).toBeInTheDocument();
  });

  it("edits and deletes selected items and openings through the inspector", async () => {
    await renderScaleApp();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("公共空间类型"), "gym");
    await user.click(screen.getAllByRole("gridcell")[0]);
    await user.click(screen.getByRole("button", { name: "放置物件" }));
    await user.click(screen.getAllByRole("gridcell")[0]);

    expect(screen.getByRole("button", { name: /选择物件/ })).toBeInTheDocument();
    expect(screen.getByLabelText("物件目录")).toHaveValue("item:fitness-station");
    expect(screen.getByLabelText("物件位置")).toHaveValue("0,0");
    await user.clear(screen.getByLabelText("物件宽度"));
    await user.type(screen.getByLabelText("物件宽度"), "2");
    await user.selectOptions(screen.getByLabelText("物件旋转"), "90");
    expect(screen.getByLabelText("物件高度")).toHaveValue(2);
    await user.click(screen.getByRole("button", { name: "删除所选物件" }));
    expect(screen.queryByRole("button", { name: /选择物件/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "设置开口" }));
    await user.click(screen.getAllByRole("gridcell")[0]);
    expect(screen.getByRole("button", { name: /选择开口/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除所选开口" }));
    expect(screen.queryByRole("button", { name: /选择开口/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
  });
});
