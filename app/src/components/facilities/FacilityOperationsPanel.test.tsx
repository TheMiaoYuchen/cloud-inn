import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FacilityState } from "../../domain/facilities/facilityTypes";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { FacilityOperationsPanel } from "./FacilityOperationsPanel";
import { assertStableId } from "../../domain/building/buildingTypes";

function facilityState(): FacilityState[] {
  const state = createPhase4AcceptanceState("facility-panel");
  const facilities = Object.values(state.phase4!.facilities);
  const dining = facilities.find(({ type }) => type === "all-day-dining")!;
  dining.dailyResults = [
    { day: 1, visits: 50, revenueCents: 1_000_000, operatingCostCents: 300_000, utilizationBps: 5_000, satisfactionDeltaBps: 20, appealDeltaBps: 10, reasonCodes: [assertStableId("facility-reason:capacity")] },
    { day: 2, visits: 80, revenueCents: 1_600_000, operatingCostCents: 400_000, utilizationBps: 8_000, satisfactionDeltaBps: 30, appealDeltaBps: 20, reasonCodes: [assertStableId("facility-reason:demand")] },
  ];
  return facilities;
}

describe("facility operations panel", () => {
  it("shows result, ordered reasons and actions, then persists a policy", async () => {
    const facilities = facilityState();
    const dining = facilities.find(({ type }) => type === "all-day-dining")!;
    const configure = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<FacilityOperationsPanel facilities={[dining]} pending={false} onConfigure={configure} onDevelop={async () => true} onSelectOffering={async () => true} onSetEnabled={async () => true} />);

    const region = screen.getByRole("region", { name: "设施经营" });
    expect(within(region).getByText(/昨日收入/)).toHaveTextContent("16,000");
    expect(within(region).getByText(/月累计收入/)).toHaveTextContent("26,000");
    expect(within(region).getByText(/容量利用/)).toHaveTextContent("80%");
    expect(within(region).getByText(/宾客影响/)).toBeInTheDocument();
    const headings = within(region).getAllByRole("heading", { level: 3 }).map(({ textContent }) => textContent);
    expect(headings).toEqual(["经营结果", "原因诊断", "经营行动"]);

    await user.selectOptions(within(region).getByLabelText("价格定位"), "premium");
    await user.click(within(region).getByRole("button", { name: "保存设施策略" }));
    expect(configure).toHaveBeenCalledWith(dining.id, expect.objectContaining({ priceBandId: "price-band:premium" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("已保存");
  });

  it("resets offer preview when selection changes and distinguishes boost facilities", async () => {
    const facilities = facilityState();
    const dining = facilities.find(({ type }) => type === "all-day-dining")!;
    const bar = facilities.find(({ type }) => type === "bar")!;
    const lobby = facilities.find(({ type }) => type === "sky-lobby")!;
    const user = userEvent.setup();
    render(<FacilityOperationsPanel facilities={[dining, bar, lobby]} pending={false} onConfigure={async () => true} onDevelop={async () => true} onSelectOffering={async () => true} onSetEnabled={async () => true} />);

    await user.selectOptions(screen.getByLabelText("经营设施"), dining.id);
    const offering = screen.getByLabelText("招牌产品");
    await user.selectOptions(offering, within(offering).getAllByRole("option")[1]);
    await user.selectOptions(screen.getByLabelText("经营设施"), bar.id);
    expect(screen.getByLabelText("招牌产品")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("经营设施"), lobby.id);
    expect(screen.getByText(/增益设施无需设置价格策略/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存设施策略" })).not.toBeInTheDocument();
  });

  it("handles no results and disables controls while pending", () => {
    const dining = facilityState().find(({ type }) => type === "all-day-dining")!;
    dining.dailyResults = [];
    render(<FacilityOperationsPanel facilities={[dining]} pending onConfigure={async () => true} onDevelop={async () => true} onSelectOffering={async () => true} onSetEnabled={async () => true} />);
    expect(screen.getByText("尚无设施经营结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存设施策略" })).toBeDisabled();
  });

  it("does not report a failed policy save and offers locked then developed signatures", async () => {
    const dining = facilityState().find(({ type }) => type === "all-day-dining")!;
    dining.developedOfferingIds = [];
    const configure = vi.fn(async () => false);
    const develop = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<FacilityOperationsPanel facilities={[dining]} pending={false} onConfigure={configure} onDevelop={develop} onSelectOffering={async () => true} onSetEnabled={async () => true} />);

    await user.click(screen.getByRole("button", { name: "保存设施策略" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const select = screen.getByLabelText("招牌产品");
    const locked = within(select).getAllByRole("option").find((option) => option.textContent?.includes("待开发"))!;
    await user.selectOptions(select, locked);
    await user.click(screen.getByRole("button", { name: "开发招牌产品" }));
    expect(develop).toHaveBeenCalledWith(dining.id, locked.getAttribute("value"));
    expect(await screen.findByRole("status")).toHaveTextContent("招牌产品已开发");
  });

  it("shows the selected spa service package after it is restored", () => {
    const spa = facilityState().find(({ type }) => type === "spa")!;
    spa.developedOfferingIds = [assertStableId("service:cloud-restoration")];
    spa.policy = {
      positioningId: assertStableId("positioning:restorative-wellness"),
      priceBandId: assertStableId("price-band:premium"),
      capacity: 12,
      openingPolicyId: assertStableId("opening-policy:appointment-daily"),
      serviceBudgetCents: 100_000,
      signatureOfferingId: assertStableId("service:cloud-restoration"),
    };

    render(<FacilityOperationsPanel facilities={[spa]} pending={false} onConfigure={async () => true} onDevelop={async () => true} onSelectOffering={async () => true} onSetEnabled={async () => true} />);

    expect(screen.getByText("已选服务套餐：Cloud restoration")).toBeInTheDocument();
  });
});
