import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SavePort } from "../application/ports/SavePort";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { GameProvider } from "../state/GameProvider";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";
import { BuildingOverviewPage } from "./BuildingOverviewPage";
import { createOperationsState } from "../domain/operations/createOperationsState";
import { projectHotelInventory } from "../domain/building/hotelInventory";
import { App } from "../app/App";

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
  it("follows valid floor URL changes and browser history while remaining mounted", async () => {
    const state = towerState();
    state.saveId = "save-1";
    const firstFloor = state.phase4!.floors.find(({ floorNumber }) => floorNumber === 28)!;
    const secondFloor = state.phase4!.floors.find(({ floorNumber }) => floorNumber === 29)!;
    const port = new InMemorySavePort();
    await port.commit(0, state);
    window.location.hash = `#/building?floorId=${encodeURIComponent(firstFloor.id)}`;
    render(<App savePort={port} />);

    expect(await screen.findByRole("region", { name: "28层平面工作区" }))
      .toBeInTheDocument();
    act(() => { window.location.hash = `#/building?floorId=${encodeURIComponent(secondFloor.id)}`; });
    expect(await screen.findByRole("region", { name: "29层平面工作区" }))
      .toBeInTheDocument();

    act(() => { window.history.back(); });
    expect(await screen.findByRole("region", { name: "28层平面工作区" }))
      .toBeInTheDocument();
    act(() => { window.history.forward(); });
    expect(await screen.findByRole("region", { name: "29层平面工作区" }))
      .toBeInTheDocument();
  });

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

  it("uses authoritative post-rotation room geometry and public-space slots", async () => {
    const state = towerState();
    const guestFloor = state.phase4!.floors.find(({ floorNumber }) => floorNumber === 28)!;
    const guestTemplate = state.phase4!.floorTemplates[guestFloor.templateId];
    guestTemplate.roomPlacements[0] = {
      ...guestTemplate.roomPlacements[0],
      width: 4,
      height: 6,
      rotation: 90,
    };
    const facilityFloor = state.phase4!.floors.find(({ floorNumber }) => floorNumber === 21)!;
    const facilityTemplate = state.phase4!.floorTemplates[facilityFloor.templateId];
    Object.assign(facilityTemplate.publicSpaceSlots[0], {
      anchorX: 2,
      anchorY: 3,
      width: 8,
      height: 9,
    });
    facilityTemplate.publicSpaceSlots.reverse();
    const { user } = await renderTower(state);
    const tower = screen.getByRole("region", { name: "酒店垂直楼层" });

    await user.click(within(tower).getByRole("button", { name: /^选择28层，客房，/ }));
    expect(screen.getByLabelText("28层真实比例平面")).toHaveStyle({
      aspectRatio: "24 / 60",
    });
    const room = screen.getAllByTestId("room-footprint")[0];
    expect(room).toHaveStyle({ width: `${(4 / 24) * 100}%`, height: "10%" });
    expect(screen.getByText("中央核心筒").parentElement).toHaveStyle({
      width: "25%",
      height: "10%",
    });

    await user.click(within(tower).getByRole("button", { name: /^选择21层，设施，/ }));
    const facilities = screen.getAllByTestId("space-footprint");
    expect(facilities).toHaveLength(4);
    expect(facilities[0]).toHaveStyle({
      left: `${(2 / 24) * 100}%`,
      top: "12.5%",
      width: `${(8 / 24) * 100}%`,
      height: "37.5%",
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

  it("projects occupied, renovating, and available room overlays with renovation priority", async () => {
    const state = towerState();
    const offers = projectHotelInventory(state).rooms.filter(
      ({ floorNumber }) => floorNumber === 28,
    );
    const occupied = offers[0];
    const renovating = offers[1];
    state.operations = createOperationsState();
    state.operations.lastOfflineCheckpointMs = 1_000;
    state.operations.offerUpgrades[`${renovating.id}:workspace`] = {
      roomOfferId: renovating.id,
      upgradeId: "upgrade:workspace:1",
      kind: "workspace",
      level: 1,
      remainingClosureDays: 2,
      committedDay: 0,
      costCents: 100,
    };
    state.operations.dailyReports = [{
      day: 1,
      segments: [],
      revenueCents: 0,
      operatingCostCents: 0,
      financeCostCents: 0,
      netIncomeCents: 0,
      endingCashCents: state.cashCents,
      reputationBps: 5_000,
      bookings: [occupied, renovating].map((room) => ({
        segmentId: "business" as const,
        roomId: room.sourceRoomId,
        offerId: room.id,
        rateCents: room.nightlyRateCents,
      })),
    }];
    const unchanged = structuredClone(state);
    const port = new InMemorySavePort();
    await port.commit(0, state);
    const user = userEvent.setup();
    render(
      <GameProvider savePort={port} saveId={state.saveId} nowMs={() => 1_000}>
        <BuildingOverviewPage />
      </GameProvider>,
    );
    await screen.findByRole("heading", { name: "云端塔楼总览" });
    const tower = screen.getByRole("region", { name: "酒店垂直楼层" });

    await user.click(within(tower).getByRole("button", { name: /^选择28层，客房，/ }));

    expect(screen.getByRole("button", { name: new RegExp(`客房 ${occupied.localPlacementId}，.*入住`) }))
      .toHaveClass("is-occupied");
    expect(screen.getByRole("button", { name: new RegExp(`客房 ${renovating.localPlacementId}，.*停业改造`) }))
      .toHaveClass("is-renovating");
    expect(screen.getAllByRole("button", { name: /平方米，可售$/ })).toHaveLength(8);
    expect(screen.getByText("入住 1 间")).toBeInTheDocument();
    expect(screen.getByText("停业改造 1 间")).toBeInTheDocument();
    expect(screen.getByText("可售 8 间")).toBeInTheDocument();
    expect(await port.load("tower")).toEqual(unchanged);
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

  it("resets selected floor and expansion evidence when switching saves", async () => {
    const stateA = towerState();
    stateA.saveId = "tower-a";
    const stateB = towerState();
    stateB.saveId = "tower-b";
    stateB.phase4!.floors.forEach((floor, index) => { floor.floorNumber = 39 + index; });
    stateB.phase4!.building.availableExpansionFloorNumbers = [55];
    const port = new InMemorySavePort();
    await port.commit(0, stateA);
    await port.commit(0, stateB);
    const user = userEvent.setup();
    const view = render(
      <GameProvider savePort={port} saveId={stateA.saveId}>
        <BuildingOverviewPage />
      </GameProvider>,
    );
    await screen.findByRole("heading", { name: "云端塔楼总览" });
    const towerA = screen.getByRole("region", { name: "酒店垂直楼层" });
    await user.click(within(towerA).getByRole("button", { name: /^选择28层，客房，/ }));
    await user.click(screen.getByRole("button", { name: "查看35层扩建" }));
    expect(screen.getByRole("region", { name: "35层扩建预览" })).toBeInTheDocument();

    view.rerender(
      <GameProvider savePort={port} saveId={stateB.saveId}>
        <BuildingOverviewPage />
      </GameProvider>,
    );

    expect(await screen.findByRole("region", { name: "54层平面工作区" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "35层扩建预览" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "28层平面工作区" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看55层扩建" })).toBeInTheDocument();
    expect((await port.load(stateB.saveId))?.revision).toBe(1);
  });

  it("does not leak an in-flight purchase notice across save switches", async () => {
    const stateA = towerState();
    stateA.saveId = "tower-a";
    const stateB = towerState();
    stateB.saveId = "tower-b";
    stateB.phase4!.floors.forEach((floor, index) => { floor.floorNumber = 39 + index; });
    stateB.phase4!.building.availableExpansionFloorNumbers = [55];
    const backing = new InMemorySavePort();
    await backing.commit(0, stateA);
    await backing.commit(0, stateB);
    let release!: () => void;
    const port: SavePort = {
      load: (saveId) => backing.load(saveId),
      commit: async (revision, next) => {
        if (next.saveId === stateA.saveId && next.revision === 2) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        await backing.commit(revision, next);
      },
    };
    const user = userEvent.setup();
    const view = render(
      <GameProvider savePort={port} saveId={stateA.saveId}>
        <BuildingOverviewPage />
      </GameProvider>,
    );
    await screen.findByRole("heading", { name: "云端塔楼总览" });
    await user.click(screen.getByRole("button", { name: "查看35层扩建" }));
    await user.click(screen.getByRole("button", { name: "确认购买35层" }));

    view.rerender(
      <GameProvider savePort={port} saveId={stateB.saveId}>
        <BuildingOverviewPage />
      </GameProvider>,
    );
    expect(await screen.findByRole("region", { name: "54层平面工作区" })).toBeInTheDocument();
    await act(async () => release());
    await act(async () => {});

    expect(screen.queryByText("35层已纳入酒店")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "35层扩建预览" })).not.toBeInTheDocument();
    expect((await backing.load(stateB.saveId))?.revision).toBe(1);
  });

  it("guards same-tick expansion confirmation with one commit", async () => {
    const state = towerState();
    const backing = new InMemorySavePort();
    let purchaseCommits = 0;
    const port: SavePort = {
      load: (saveId) => backing.load(saveId),
      commit: async (revision, next) => {
        if (next.revision === 2) purchaseCommits += 1;
        await backing.commit(revision, next);
      },
    };
    await renderTower(state, port);
    await userEvent.setup().click(screen.getByRole("button", { name: "查看35层扩建" }));
    const confirm = screen.getByRole("button", { name: "确认购买35层" });

    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    expect(await screen.findByText("35层已纳入酒店")).toBeInTheDocument();
    await act(async () => {});
    expect(purchaseCommits).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
