import { describe, expect, it } from "vitest";

import { assertStableId } from "../building/buildingTypes";
import { createOperationsState } from "../operations/createOperationsState";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { FACILITY_CATALOG } from "./contentCatalog";
import {
  projectContentUnlocks,
  reconcileCatalogProgress,
} from "./contentUnlocks";

function eligibleState() {
  const state = createPhase4AcceptanceState("content-unlocks");
  const operations = createOperationsState();
  operations.reputationBps = 7_500;
  operations.maximumReputationBps = 7_500;
  operations.discoveredNeeds = [{
    id: "need:wellness",
    segmentId: "leisure",
    kind: "service",
    discoveredDay: 1,
    strengthBps: 8_000,
  }];
  return { ...state, operations };
}

describe("content unlocks", () => {
  it("projects permanent content unlocks from authoritative progress", () => {
    const eligible = eligibleState();
    eligible.phase4!.catalogProgress.unlockedIds = [];

    const projected = projectContentUnlocks(eligible);
    const unlocked = reconcileCatalogProgress(eligible.phase4!, projected);
    const later = reconcileCatalogProgress(unlocked, []);

    expect(projected).toContain("facility:spa");
    expect(unlocked.catalogProgress.unlockedIds).toContain("facility:spa");
    expect(later.catalogProgress.unlockedIds).toContain("facility:spa");
  });

  it("projects only known unlock IDs in catalog order without mutating its source", () => {
    const state = eligibleState();
    const snapshot = structuredClone(state);

    const projected = projectContentUnlocks(state);
    const catalogOrder = FACILITY_CATALOG.map(({ id }) => id);

    expect(projected.every((id) => catalogOrder.includes(id))).toBe(true);
    expect(projected).toEqual(
      catalogOrder.filter((id) => projected.includes(id)),
    );
    expect(state).toEqual(snapshot);
  });

  it("deduplicates reconciliation input and preserves catalog order", () => {
    const phase4 = eligibleState().phase4!;
    phase4.catalogProgress.unlockedIds = [assertStableId("facility:gym")];
    const snapshot = structuredClone(phase4);

    const next = reconcileCatalogProgress(phase4, [
      assertStableId("facility:spa"),
      assertStableId("facility:gym"),
      assertStableId("facility:spa"),
    ]);

    expect(next.catalogProgress.unlockedIds).toEqual([
      "facility:spa",
      "facility:gym",
    ]);
    expect(phase4).toEqual(snapshot);
    expect(reconcileCatalogProgress(next, next.catalogProgress.unlockedIds)).toEqual(next);
  });

  it("rejects unknown IDs at the reconciliation boundary", () => {
    const phase4 = eligibleState().phase4!;

    expect(() => reconcileCatalogProgress(phase4, [
      assertStableId("facility:unknown"),
    ])).toThrow("未知内容解锁");
  });
});
