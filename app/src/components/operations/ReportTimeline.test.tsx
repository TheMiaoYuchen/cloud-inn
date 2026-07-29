import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  MonthlyOperationsClose,
  OperationsDailyReport,
  WeeklyOperationsReport,
} from "../../domain/operations/operationsTypes";
import { ReportTimeline } from "./ReportTimeline";

const categories = {
  roomRevenueCents: 120_000,
  publicSpaceRevenueCents: 30_000,
  departmentCostCents: 40_000,
  facilityOperatingCostCents: 10_000,
};

describe("operations report timeline", () => {
  it("shows room and facility categories for daily, weekly, and monthly reports", () => {
    const daily = [{
      day: 30,
      segments: [],
      revenueCents: 150_000,
      operatingCostCents: 50_000,
      financeCostCents: 0,
      netIncomeCents: 100_000,
      endingCashCents: 1_000_000,
      reputationBps: 5_000,
      ...categories,
    }] as OperationsDailyReport[];
    const weekly = [{
      week: 4,
      startDay: 22,
      endDay: 28,
      revenueCents: 150_000,
      operatingCostCents: 50_000,
      financeCostCents: 0,
      netIncomeCents: 100_000,
      availableRooms: 120,
      soldRooms: 60,
      averageOccupancyBps: 5_000,
      reputationBps: 5_000,
      ...categories,
    }] as WeeklyOperationsReport[];
    const monthly = [{
      month: 1,
      startDay: 1,
      endDay: 30,
      revenueCents: 150_000,
      operatingCostCents: 50_000,
      financeCostCents: 0,
      netIncomeCents: 100_000,
      debtPaymentCents: 0,
      endingCashCents: 1_000_000,
      ...categories,
    }] as MonthlyOperationsClose[];

    render(<ReportTimeline daily={daily} weekly={weekly} monthly={monthly} checkpointMs={1} />);

    for (const name of ["日报", "周报", "月结"]) {
      const group = screen.getByRole("article", { name });
      expect(within(group).getByText(/客房收入/)).toBeInTheDocument();
      expect(within(group).getByText(/公共空间收入/)).toBeInTheDocument();
      expect(within(group).getByText(/部门成本/)).toBeInTheDocument();
      expect(within(group).getByText(/设施成本/)).toBeInTheDocument();
    }
  });
});
