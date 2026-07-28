import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SavePort } from "../application/ports/SavePort";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { GameProvider } from "../state/GameProvider";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";
import { BuildingOverviewPage } from "./BuildingOverviewPage";

function towerState() {
  const state = createPhase4AcceptanceState("tower");
  state.revision = 1;
  state.phase = "open";
  state.cashCents = 100_000_000;
  state.phase4!.floors.forEach((floor, index) => {
    floor.floorNumber = 19 + index;
  });
  state.phase4!.building.availableExpansionFloorNumbers = [35];
  return state;
}

async function renderTower(
  state = towerState(),
  port: SavePort = new InMemorySavePort(),
) {
  await port.commit(0, state);
  const user = userEvent.setup();
  render(
    <GameProvider savePort={port} saveId={state.saveId}>
      <BuildingOverviewPage />
    </GameProvider>,
  );
  await screen.findByRole("heading", { name: "云端塔楼总览" });
  return { user, port };
}

describe("Phase 4 building overview", () => {
  it("shows sixteen physical floors highest first and mounts only the selected scene", async () => {
    const { user } = await renderTower();
    const tower = screen.getByRole("region", { name: "酒店垂直楼层" });
    const floorButtons = within(tower).getAllByRole("button", {
      name: /^选择\d+层，/,
    });

    expect(floorButtons).toHaveLength(16);
    expect(floorButtons[0]).toHaveAccessibleName(/^选择34层，客房，/);
    expect(floorButtons[15]).toHaveAccessibleName(/^选择19层，酒店入口，/);

    await user.click(
      within(tower).getByRole("button", { name: /^选择28层，客房，/ }),
    );

    expect(
      screen.getByRole("region", { name: "28层平面工作区" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "29层平面工作区" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("中央核心筒")).toBeInTheDocument();
    expect(screen.getByText("环形走廊")).toBeInTheDocument();
    expect(screen.getAllByTestId("room-footprint")).toHaveLength(10);
    expect(screen.getByText("本层 10 间客房")).toBeInTheDocument();
  });

  it("uses the authoritative post-rotation room geometry and true-size facility blueprints", async () => {
    const state = towerState();
    const guestFloor = state.phase4!.floors.find(({ floorNumber }) => floorNumber === 28)!;
    const guestTemplate = state.phase4!.floorTemplates[guestFloor.templateId];
    guestTemplate.roomPlacements[0] = {
      ...guestTemplate.roomPlacements[0],
      width: 4,
      height: 6,
      rotation: 90,
    };
    const { user } = await renderTower(state);
    const tower = screen.getByRole("region", { name: "酒店垂直楼层" });

    await user.click(within(tower).getByRole("button", { name: /^选择28层，客房，/ }));
    const room = screen.getAllByTestId("room-footprint")[0];
    expect(room).toHaveStyle({ width: `${(4 / 24) * 100}%`, height: "10%" });

    await user.click(within(tower).getByRole("button", { name: /^选择21层，设施，/ }));
    const facilities = screen.getAllByTestId("space-footprint");
    expect(facilities).toHaveLength(4);
    expect(facilities[0]).toHaveStyle({
      width: `${(8 / 24) * 100}%`,
      height: `${(8 / 24) * 100}%`,
    });
  });

  it("previews the authoritative cost before one atomic floor purchase", async () => {
    const { user, port } = await renderTower();

    await user.click(screen.getByRole("button", { name: "查看35层扩建" }));
    const preview = screen.getByRole("region", { name: "35层扩建预览" });
    expect(within(preview).getByText("扩建成本 ¥250,000")).toBeInTheDocument();

    await user.click(
      within(preview).getByRole("button", { name: "确认购买35层" }),
    );

    expect(await screen.findByText("35层已纳入酒店")).toBeInTheDocument();
    const saved = await port.load("tower");
    expect(saved?.revision).toBe(2);
    expect(saved?.cashCents).toBe(75_000_000);
    expect(saved?.phase4?.floors.some(({ floorNumber }) => floorNumber === 35))
      .toBe(true);
  });

  it("reports insufficient cash without offering a false confirmation", async () => {
    const state = towerState();
    state.cashCents = 1_000;
    const { user } = await renderTower(state);

    await user.click(screen.getByRole("button", { name: "查看35层扩建" }));

    expect(screen.getByText("现金不足，还差 ¥249,990")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "确认购买35层" }),
    ).toBeDisabled();
    expect(screen.queryByText("35层已纳入酒店")).not.toBeInTheDocument();
  });

  it("keeps the preview open and exposes command failures", async () => {
    const state = towerState();
    const backing = new InMemorySavePort();
    let commits = 0;
    const failingPort: SavePort = {
      load: (saveId) => backing.load(saveId),
      commit: async (revision, next) => {
        commits += 1;
        if (commits === 1) {
          await backing.commit(revision, next);
          return;
        }
        throw new Error("桌面写入失败");
      },
    };
    const { user } = await renderTower(state, failingPort);

    await user.click(screen.getByRole("button", { name: "查看35层扩建" }));
    await user.click(screen.getByRole("button", { name: "确认购买35层" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("桌面写入失败");
    expect(screen.getByRole("region", { name: "35层扩建预览" }))
      .toBeInTheDocument();
    expect(screen.queryByText("35层已纳入酒店")).not.toBeInTheDocument();
  });

  it("shows an empty Phase 4 state without mounting a floor scene", async () => {
    const state = towerState();
    state.phase4!.floors = [];
    state.phase4!.building.purchasedFloorIds = [];
    state.phase4!.building.skyLobbyFloorIds = [];
    state.phase4!.building.availableExpansionFloorNumbers = [];
    state.phase4!.publicSpaces = {};
    state.phase4!.spaceBlueprints = {};
    state.phase4!.facilities = {};

    await renderTower(state);

    expect(screen.getByText("酒店还没有可查看的楼层")).toBeInTheDocument();
    expect(screen.queryByTestId("floor-scene")).not.toBeInTheDocument();
  });
});
