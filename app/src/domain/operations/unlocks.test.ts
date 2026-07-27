import { describe, expect, it } from "vitest";

import { REPUTATION_UNLOCKS, projectReputationUnlocks, validateReputationUnlockCatalog } from "./unlocks";
import { createOperationsState } from "./createOperationsState";

describe("reputation unlocks", () => {
  it("defines unique stable content keys in ascending reputation thresholds", () => {
    expect(REPUTATION_UNLOCKS).toEqual([
      { key: "operations:pricing-automation", reputationBps: 6_000 },
      { key: "operations:premium-segments", reputationBps: 7_500 },
      { key: "operations:signature-service", reputationBps: 9_000 },
    ]);
    expect(() => validateReputationUnlockCatalog(REPUTATION_UNLOCKS)).not.toThrow();
  });

  it.each([
    [{ key: "", reputationBps: 5_000 }],
    [{ key: "duplicate", reputationBps: 5_000 }, { key: "duplicate", reputationBps: 6_000 }],
    [{ key: "unsafe", reputationBps: 10_001 }],
    [{ key: "descending-a", reputationBps: 6_000 }, { key: "descending-b", reputationBps: 5_000 }],
  ])("rejects an invalid unlock catalog", (...catalog) => {
    expect(() => validateReputationUnlockCatalog(catalog)).toThrow();
  });

  it("unlocks threshold content as a stable union and updates the historical maximum", () => {
    const operations = createOperationsState();
    operations.unlockedContent = ["existing:content"];

    const projected = projectReputationUnlocks(operations, 7_500);

    expect(projected.maximumReputationBps).toBe(7_500);
    expect(projected.unlockedContent).toEqual([
      "existing:content",
      "operations:pricing-automation",
      "operations:premium-segments",
    ]);
    expect(operations.unlockedContent).toEqual(["existing:content"]);
  });

  it("preserves earned content and maximum reputation after reputation falls or state reloads", () => {
    const operations = createOperationsState();
    operations.reputationBps = 8_000;
    operations.maximumReputationBps = 8_000;
    const earned = projectReputationUnlocks(operations, 8_000);
    const reloaded = structuredClone({ ...operations, ...earned, reputationBps: 4_000 });

    const projected = projectReputationUnlocks(reloaded, 3_000);

    expect(projected.maximumReputationBps).toBe(8_000);
    expect(projected.unlockedContent).toEqual(earned.unlockedContent);
  });

  it.each([Number.NaN, -1, 10_001, 1.5])("rejects invalid new reputation %s", (reputationBps) => {
    expect(() => projectReputationUnlocks(createOperationsState(), reputationBps)).toThrow("声誉");
  });

  it("rejects invalid existing maximum and unlock arrays before projecting", () => {
    const invalidMaximum = createOperationsState();
    invalidMaximum.maximumReputationBps = Number.NaN;
    expect(() => projectReputationUnlocks(invalidMaximum, 5_000)).toThrow("最高声誉");

    const invalidUnlock = createOperationsState();
    invalidUnlock.unlockedContent = ["valid", ""];
    expect(() => projectReputationUnlocks(invalidUnlock, 5_000)).toThrow("解锁内容");
  });
});
