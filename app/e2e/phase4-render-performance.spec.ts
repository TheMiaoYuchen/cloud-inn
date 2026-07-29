import { expect, test } from "@playwright/test";
import { projectHotelInventory } from "../src/domain/building/hotelInventory";
import { createApprovedOperations } from "../src/domain/operations/operationsFixtures";
import { settleHotelDay } from "../src/domain/operations/settleHotelDay";
import { createPhase4AcceptanceState } from "../src/testing/phase4Fixtures";

function maximumFixture() {
  const state = createPhase4AcceptanceState("save-1");
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
  state.operations = {
    ...settled.operations,
    timeSpeed: 0,
    lastOfflineCheckpointMs: Date.now(),
  };
  state.phase4 = settled.phase4;
  const guestFloorId = state.phase4.floors.find(({ rooms }) => rooms.length > 0)!.id;
  return { state, guestFloorId };
}

test("keeps the maximum selected-floor flow within frame and sprite budgets", async ({ page }) => {
  const fixture = maximumFixture();
  await page.addInitScript(({ state }) => {
    localStorage.setItem("cloud-inn:save:save-1", JSON.stringify({
      formatVersion: 1,
      writeToken: "phase4-performance-fixture",
      game: state,
    }));
  }, { state: fixture.state });
  await page.goto(`/#/building?floorId=${encodeURIComponent(fixture.guestFloorId)}`);

  await expect(page.getByTestId("floor-scene")).toHaveCount(1);
  await expect(page.getByTestId("hotel-flow-canvas")).toHaveCount(1);
  const host = page.getByTestId("hotel-flow-host");
  const spriteCount = Number(await host.getAttribute("data-flow-sprite-count"));
  expect(spriteCount).toBeGreaterThan(0);
  expect(spriteCount).toBeLessThanOrEqual(150);
  const animationBefore = await host.evaluate((element) => ({
    tick: Number(element.dataset.flowAnimationTick),
    sample: element.dataset.flowAnimationSample,
    distance: Number(element.dataset.flowAnimationDistance),
  }));

  const frame = await host.evaluate(async (element) => {
    const samples: number[] = [];
    let previous = performance.now();
    let frameCount = 0;
    const started = previous;
    const pointerId = 7;
    element.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId, clientX: 80, clientY: 80,
    }));
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const delta = now - previous;
        previous = now;
        frameCount += 1;
        if (frameCount > 60) samples.push(delta);
        element.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: frameCount % 2 === 0 ? -12 : 12,
        }));
        element.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          pointerId,
          clientX: 80 + frameCount % 20,
          clientY: 80 + frameCount % 15,
        }));
        if (now - started < 10_000) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId }));
    samples.sort((left, right) => left - right);
    return {
      p95Ms: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)],
      sampleCount: samples.length,
    };
  });
  const animationAfter = await host.evaluate((element) => ({
    tick: Number(element.dataset.flowAnimationTick),
    sample: element.dataset.flowAnimationSample,
    distance: Number(element.dataset.flowAnimationDistance),
  }));
  const animationEvidence = {
    tickDelta: animationAfter.tick - animationBefore.tick,
    sampleChanged: animationAfter.sample !== animationBefore.sample,
    distanceDelta: animationAfter.distance - animationBefore.distance,
    before: animationBefore.sample,
    after: animationAfter.sample,
  };

  test.info().annotations.push(
    { type: "phase4-sprites", description: String(spriteCount) },
    { type: "phase4-raf-p95-ms", description: frame.p95Ms.toFixed(2) },
    { type: "phase4-raf-samples", description: String(frame.sampleCount) },
    { type: "phase4-animation-ticks", description: String(animationEvidence.tickDelta) },
    { type: "phase4-animation-changed", description: String(animationEvidence.sampleChanged) },
    { type: "phase4-animation-distance", description: animationEvidence.distanceDelta.toFixed(2) },
    { type: "phase4-rss", description: "pending Task 13 native smoke" },
  );
  console.log(JSON.stringify({ spriteCount, ...frame, animationEvidence, rss: "pending Task 13 native smoke" }));
  expect(frame.sampleCount).toBeGreaterThan(100);
  expect(frame.p95Ms).toBeLessThanOrEqual(33);
  expect(animationEvidence.tickDelta).toBeGreaterThan(100);
  expect(animationEvidence.distanceDelta).toBeGreaterThan(0);
});
