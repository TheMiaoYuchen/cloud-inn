import { expect, test } from "@playwright/test";

test.describe("Phase 3 operations acceptance", () => {
  test.setTimeout(120_000);
  test("runs the browser closed loop through the 30-day close and restores it", async ({ page }) => {
    await page.goto("/#/design");

    // Build a Phase 2 hotel using the same accessible controls a desktop user sees.
    await page.getByRole("button", { name: "云岫商务房" }).click();
    await page.getByRole("button", { name: "保存并进入楼层" }).click();
    await expect(page.getByRole("heading", { name: "高层酒店楼层规划" })).toBeVisible();
    for (const slot of ["西北槽位", "东北槽位", "西南槽位", "东南槽位"]) {
      await page.getByRole("button", { name: new RegExp(slot) }).click();
    }
    await page.getByRole("button", { name: "进入运营" }).click();
    await expect(page.getByRole("heading", { name: "完整经营中心" })).toBeVisible();
    await page.getByRole("button", { name: "启用完整经营" }).click();

    await expect(page.getByRole("heading", { name: "云岫经营中心" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "六类客群表现" })).toBeVisible();
    await expect(page.getByRole("region", { name: "客群经营表现" })).toContainText("商务差旅");
    await expect(page.getByRole("region", { name: "客群经营表现" })).toContainText("家庭出游");

    const baseRate = page.getByRole("spinbutton", { name: "基础价（元）" });
    await baseRate.fill("1800");
    await page.getByRole("button", { name: "保存房价策略" }).click();
    await expect(page.getByRole("region", { name: "房价策略" })).toContainText("建议价");

    const departments = page.getByRole("region", { name: "部门管理" });
    await departments.getByRole("tab", { name: "客房部" }).click();
    await departments.getByRole("combobox", { name: "负责人专长" }).selectOption({ label: "高效清扫" });
    await departments.getByRole("spinbutton", { name: "员工人数" }).fill("4");
    await departments.getByRole("button", { name: "保存部门配置" }).click();
    await expect(departments).toContainText("配置已保存");

    const renovation = page.getByRole("region", { name: "客房改造" });
    await renovation.getByRole("combobox", { name: "改造项目" }).selectOption("workspace");
    await renovation.getByRole("button", { name: "预览改造" }).click();
    await expect(renovation).toContainText("客群匹配变化");
    await renovation.getByRole("button", { name: "确认改造" }).click();
    await expect(renovation).toContainText("改造已安排");

    await page.getByRole("button", { name: "4 倍速" }).click();
    await page.getByRole("button", { name: "推进一天" }).click();
    await page.getByRole("button", { name: "暂停" }).click();
    await expect(page.getByText(/营业日 1 \/ 30/)).toBeVisible();

    // A reload exercises the persisted checkpoint and bounded offline catch-up.
    await page.reload();
    await expect(page.getByRole("heading", { name: "云岫经营中心" })).toBeVisible();
    await expect(page.getByText(/检查点：已记录/)).toBeVisible();

    for (let day = 2; day <= 30; day += 1) {
      await page.getByRole("button", { name: "推进一天" }).click();
      await expect(page.getByText(new RegExp(`营业日 ${day} / 30`))).toBeVisible();
    }
    await expect(page.getByText("30 日经营周期已完成")).toBeVisible();
    await expect(page.getByRole("heading", { name: "经营报告时间线" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("周报");
    await expect(page.getByRole("main")).toContainText("月结");

    const snapshot = await page.getByRole("main").innerText();
    await page.reload();
    await expect(page.getByText("营业日 30 / 30")).toBeVisible();
    await expect(page.getByText("30 日经营周期已完成")).toBeVisible();
    await expect(page.getByRole("main")).toContainText("第 1 月");
    await expect(page.getByRole("main")).toContainText("离线结算最多 7 天");
    expect(snapshot).toContain("第 1 月");
  });
});
