import { expect, test } from "@playwright/test";

test("completes the prototype hotel loop from design through day two", async ({ page }) => {
  await page.goto("/#/design");

  await page.getByRole("button", { name: "云岫商务房" }).click();
  await expect(page.getByText("面积 24㎡")).toBeVisible();

  const name = page.getByRole("textbox", { name: "房型名称" });
  await name.fill("云岫商务房");
  await page.getByRole("button", { name: "保存并进入楼层" }).click();

  await expect(page.getByRole("heading", { name: "固定楼层槽位" })).toBeVisible();
  await page.getByRole("link", { name: "楼层", exact: true }).click();
  await expect(page).toHaveURL(/#\/floor-plan$/);
  for (const slot of ["西北槽位", "东北槽位", "西南槽位", "东南槽位"]) {
    const slotButton = page.getByRole("button", { name: new RegExp(slot) });
    await slotButton.click();
  }
  await expect(page.getByText("已建 4/4")).toBeVisible();

  await page.getByRole("button", { name: "进入运营" }).click();
  await expect(page.getByRole("heading", { name: "云岫酒店 · 运营" })).toBeVisible();

  const startButton = page.getByRole("button", { name: "开始营业" });
  if (await startButton.isVisible().catch(() => false)) {
    await startButton.click();
  }
  await page.getByRole("button", { name: "结算下一天" }).click();
  await expect(page.getByText(/第1天 · 可售4 · 售出3/)).toBeVisible();
  await expect(page.getByText(/收入 ¥2400 · 成本 ¥770 · 净收入 ¥1630/)).toBeVisible();

  await page.getByRole("button", { name: "请求视觉预览" }).click();
  await expect(page.getByRole("img", { name: "房间视觉预览" })).toBeVisible();

  await page.getByRole("spinbutton", { name: "房价" }).fill("1600");
  await page.getByRole("button", { name: "更新房价" }).click();
  await page.getByRole("button", { name: "结算下一天" }).click();
  await expect(page.getByText(/第2天 · 可售4 · 售出0/)).toBeVisible();
  await expect(page.getByText(/可售 4 · 售出 0 .*成本 ¥320/)).toBeVisible();
});
