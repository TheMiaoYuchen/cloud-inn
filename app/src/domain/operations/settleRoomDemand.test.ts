import { describe, expect, it } from "vitest";

import { createApprovedSettlementInput } from "./operationsFixtures";
import { settleRoomDemand } from "./settleRoomDemand";

describe("settleRoomDemand", () => {
  it("settles room demand without finalizing finance, cash, reputation, unlocks, or reports", () => {
    const input = createApprovedSettlementInput();
    const snapshot = structuredClone(input);

    const result = settleRoomDemand({
      day: input.day,
      operations: input.operations,
      offers: input.offers,
    });

    expect(result.roomRevenueCents).toBeGreaterThan(0);
    expect(result.departmentCostCents).toBeGreaterThan(0);
    expect(result.bookings).toHaveLength(result.soldRooms);
    expect(result.renovationProgress).toEqual(input.operations.offerUpgrades);
    expect(result).not.toHaveProperty("loanInterestCents");
    expect(result).not.toHaveProperty("cashCents");
    expect(result).not.toHaveProperty("reputationBps");
    expect(result).not.toHaveProperty("unlockedContent");
    expect(result).not.toHaveProperty("report");
    expect(input).toEqual(snapshot);
  });
});
