import { expect, test } from "@playwright/test";
import { createPhase4AcceptanceState } from "../src/testing/phase4Fixtures";

const soakMinutes = Number(process.env.CLOUD_INN_SOAK_MINUTES ?? 0);

test("keeps the maximum hotel responsive for the configured soak window", async ({ page }) => {
  test.skip(!Number.isFinite(soakMinutes) || soakMinutes <= 0, "release soak only");
  test.setTimeout((soakMinutes + 2) * 60_000);
  const fixture = createPhase4AcceptanceState("save-1");
  const guestFloorId = fixture.phase4?.floors.find((floor) => floor.use === "guest")?.id;
  expect(guestFloorId).toBeTruthy();
  await page.addInitScript(({ fixture }) => {
    localStorage.setItem("cloud-inn:save:save-1", JSON.stringify({
      formatVersion: 1,
      writeToken: "phase5-soak",
      game: fixture,
    }));
  }, { fixture });
  await page.goto(`/#/building?floorId=${encodeURIComponent(guestFloorId!)}`);
  await expect(page.getByTestId("pixi-canvas")).toBeVisible();

  const deadline = Date.now() + soakMinutes * 60_000;
  let cycle = 0;
  while (Date.now() < deadline) {
    await expect(page.getByTestId("pixi-canvas")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    await page.waitForTimeout(10_000);
    cycle += 1;
    if (cycle % 30 === 0) {
      await page.reload();
      await expect(page.getByTestId("pixi-canvas")).toBeVisible();
    }
  }
});
