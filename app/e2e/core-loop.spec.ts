import { expect, test } from "@playwright/test";
import { ensureBrowserSave } from "./reliabilitySetup";

test.beforeEach(async ({ page }) => ensureBrowserSave(page));

test("completes the prototype hotel loop from design through day two", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/#/design");

  await page.getByRole("button", { name: "云岫商务房" }).click();
  await expect(page.getByText("24㎡", { exact: true })).toBeVisible();

  const name = page.getByRole("textbox", { name: "房型名称" });
  await name.fill("云岫商务房");
  await page.getByRole("button", { name: "保存并进入楼层" }).click();

  await expect(page.getByRole("heading", { name: "高层酒店楼层规划" })).toBeVisible();
  await page.getByRole("link", { name: "楼层", exact: true }).click();
  await expect(page).toHaveURL(/#\/floor-plan$/);
  for (const slot of ["西北槽位", "东北槽位", "西南槽位", "东南槽位"]) {
    const slotButton = page.getByRole("button", { name: new RegExp(slot) });
    await slotButton.click();
  }
  await expect(page.getByText("已建 4/4")).toBeVisible();

  await page.getByRole("button", { name: "进入运营" }).click();
  await expect(page.getByRole("heading", { name: "完整经营中心" })).toBeVisible();
  await page.getByRole("button", { name: "启用完整经营" }).click();
  await expect(page.getByRole("heading", { name: "云岫经营中心" })).toBeVisible();

  await page.getByRole("button", { name: "推进一天" }).click();
  await expect(page.getByText("营业日 1 / 30")).toBeVisible();
  await expect(page.getByRole("region", { name: "经营报告时间线" })).toContainText("第 1 日");

  await page.getByRole("spinbutton", { name: "基础价（元）" }).fill("1600");
  await page.getByRole("button", { name: "保存房价策略" }).click();
  await expect(page.getByRole("region", { name: "房价策略" })).toContainText("当前价");
  await page.getByRole("button", { name: "推进一天" }).click();
  await expect(page.getByText("营业日 2 / 30")).toBeVisible();
  await expect(page.getByRole("region", { name: "经营报告时间线" })).toContainText("第 2 日");
  await expect(page.getByRole("main")).toContainText("现金");

  await page.reload();
  await expect(page.getByText("营业日 2 / 30")).toBeVisible();
  await expect(page.getByRole("region", { name: "经营报告时间线" })).toContainText("第 2 日");
});
