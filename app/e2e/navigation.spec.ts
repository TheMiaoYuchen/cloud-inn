import { expect, test } from "@playwright/test";
import { ensureBrowserSave } from "./reliabilitySetup";

test.beforeEach(async ({ page }) => ensureBrowserSave(page));

test("opens the Pixi floor canvas and returns home", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cloud Inn" })).toBeVisible();
  await page.getByRole("link", { name: "楼层画布" }).click();
  await expect(page.getByRole("heading", { name: "楼层画布" })).toBeVisible();
  await expect(page.getByTestId("pixi-canvas")).toBeVisible();
  await page.getByRole("link", { name: "酒店总览" }).click();
  await expect(page.getByRole("heading", { name: "Cloud Inn" })).toBeVisible();
});
