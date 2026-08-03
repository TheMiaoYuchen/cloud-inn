import { expect, test } from "@playwright/test";
import { projectHotelInventory } from "../src/domain/building/hotelInventory";
import { createApprovedOperations } from "../src/domain/operations/operationsFixtures";
import { settleHotelDay } from "../src/domain/operations/settleHotelDay";
import { createPhase4AcceptanceState } from "../src/testing/phase4Fixtures";
import { ensureBrowserSave } from "./reliabilitySetup";

const soakMinutes = Number(process.env.CLOUD_INN_SOAK_MINUTES ?? 0);
const soakIntervalMs = Number(process.env.CLOUD_INN_SOAK_INTERVAL_MS ?? 10_000);
const acceleratedCycles = Number(process.env.CLOUD_INN_SOAK_CYCLES ?? 0);

function maximumFixture(saveId: string) {
  const state = createPhase4AcceptanceState(saveId);
  state.revision = 1;
  state.phase = "open";
  state.operations = createApprovedOperations();
  const settled = settleHotelDay({
    day: 1,
    seed: state.saveId,
    cashCents: state.cashCents,
    operations: state.operations,
    offers: projectHotelInventory(state).rooms,
    phase4: state.phase4!,
  });
  state.currentDay = 1;
  state.cashCents = settled.cashCents;
  state.operations = { ...settled.operations, timeSpeed: 0, lastOfflineCheckpointMs: Date.now() };
  state.phase4 = settled.phase4;
  return {
    state,
    guestFloorId: state.phase4.floors.find(({ rooms }) => rooms.length > 0)!.id,
  };
}

test("keeps the maximum hotel responsive for the configured soak window", async ({ page }) => {
  test.skip(!Number.isFinite(soakMinutes) || soakMinutes <= 0, "release soak only");
  const cycleCount = acceleratedCycles > 0 ? acceleratedCycles : Number.POSITIVE_INFINITY;
  test.setTimeout(acceleratedCycles > 0 ? Math.max(60_000, acceleratedCycles * soakIntervalMs + 30_000) : (soakMinutes + 2) * 60_000);
  await ensureBrowserSave(page);
  const saveId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("cloud-inn:save:"));
    if (!key) throw new Error("browser save catalog was not created");
    return key.slice("cloud-inn:save:".length);
  });
  const fixture = maximumFixture(saveId);
  await page.evaluate(({ fixture, saveId }) => {
    localStorage.setItem(`cloud-inn:save:${saveId}`, JSON.stringify({
      formatVersion: 1,
      writeToken: "phase5-soak",
      game: fixture.state,
    }));
  }, { fixture, saveId });
  await page.reload();
  await page.goto(`/#/building?floorId=${encodeURIComponent(fixture.guestFloorId)}`);
  await expect(page.getByTestId("floor-scene")).toHaveCount(1);
  await expect(page.getByTestId("hotel-flow-canvas")).toHaveCount(1);
  const host = page.getByTestId("hotel-flow-host");
  await expect(host).toBeVisible();
  expect(Number(await host.getAttribute("data-flow-sprite-count"))).toBeGreaterThan(0);

  const deadline = acceleratedCycles > 0 ? Number.POSITIVE_INFINITY : Date.now() + soakMinutes * 60_000;
  let cycle = 0;
  while (Date.now() < deadline && cycle < cycleCount) {
    await expect(host).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    const tickBefore = Number(await host.getAttribute("data-flow-animation-tick"));
    await page.waitForTimeout(soakIntervalMs);
    const tickAfter = Number(await host.getAttribute("data-flow-animation-tick"));
    // A remount or bounded counter rollover resets the tick; either way a
    // changed value proves the animation loop remained active for this sample.
    expect(tickAfter).not.toBe(tickBefore);
    cycle += 1;
    if (cycle % 30 === 0 && (acceleratedCycles > 0 || Date.now() + 15_000 < deadline)) {
      await page.reload();
      await expect(page.getByTestId("hotel-flow-host")).toBeVisible();
    }
  }
});
