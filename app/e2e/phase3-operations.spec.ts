import { expect, test } from "@playwright/test";

test.describe("Phase 3 operations acceptance", () => {
  test.setTimeout(120_000);
  test("runs the browser closed loop through the 30-day close and restores it", async ({ page: initialPage }) => {
    let page = initialPage;
    await page.addInitScript(() => localStorage.setItem("cloud-inn:e2e-day-ms", "500"));
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
    await page.getByRole("spinbutton", { name: "最高价（元）" }).fill("2000");
    const automaticPricing = page.getByRole("checkbox", { name: "自动定价" });
    await automaticPricing.click();
    await expect(automaticPricing).not.toBeChecked();
    await page.getByRole("button", { name: "保存房价策略" }).click();
    await expect(page.getByRole("region", { name: "房价策略" })).toContainText("当前价 ¥1,800");

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
    await expect(renovation).toContainText(/改造前：办公 \d+(?:\.\d+)?%/);
    await expect(renovation).toContainText(/改造后：办公 \d+(?:\.\d+)?%/);
    const renovationText = await renovation.innerText();
    const beforeWorkspace = Number(renovationText.match(/改造前：办公 (\d+(?:\.\d+)?)%/)?.[1]);
    const afterWorkspace = Number(renovationText.match(/改造后：办公 (\d+(?:\.\d+)?)%/)?.[1]);
    expect(afterWorkspace).toBeGreaterThan(beforeWorkspace);
    await expect(renovation).toContainText(/商务差旅：\+\d+(?:\.\d+)?% workspace-fit/);
    await renovation.getByRole("button", { name: "确认改造" }).click();
    await expect(renovation).toContainText("办公空间改造 1 级已安排 · 剩余停业 2 天");

    await page.getByRole("button", { name: "4 倍速" }).click();
    await expect(page.getByText(/营业日 1 \/ 30/)).toBeVisible({ timeout: 4_000 });
    await page.getByRole("button", { name: "暂停" }).click();

    // Rewind only the persisted checkpoint; the application performs real bounded catch-up on reload.
    await page.evaluate(() => {
      const key = "cloud-inn:save:save-1";
      const saved = JSON.parse(localStorage.getItem(key)!);
      saved.game.operations.lastOfflineCheckpointMs = Date.now() - 20 * 500;
      localStorage.setItem(key, JSON.stringify(saved));
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const key = "cloud-inn:save:save-1";
      const saved = JSON.parse(localStorage.getItem(key)!);
      saved.game.operations.lastOfflineCheckpointMs = Date.now() - 20 * 500;
      localStorage.setItem(key, JSON.stringify(saved));
    });
    const offlinePage = await page.context().newPage();
    await page.close();
    await offlinePage.goto("/#/operations");
    page = offlinePage;
    await expect(page.getByRole("heading", { name: "云岫经营中心" })).toBeVisible();
    await expect(page.getByText("本次离线补算 7 天")).toBeVisible();
    await expect(page.getByText("营业日 8 / 30")).toBeVisible();
    await expect(page.getByText(/第 1 周/)).toBeVisible();
    await expect(page.getByText(/检查点：已记录/)).toBeVisible();

    await page.reload();
    await expect(page.getByText("营业日 8 / 30")).toBeVisible();

    for (let day = 9; day <= 30; day += 1) {
      await page.getByRole("button", { name: "推进一天" }).click();
      await expect(page.getByText(new RegExp(`营业日 ${day} / 30`))).toBeVisible();
    }
    await expect(page.getByText("30 日经营周期已完成")).toBeVisible();
    await expect(page.getByRole("heading", { name: "经营报告时间线" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("周报");
    await expect(page.getByRole("main")).toContainText("月结");

    const visibleState = async () => ({
      summary: await page.getByRole("region", { name: "经营结果" }).innerText(),
      reports: await page.getByRole("region", { name: "经营报告时间线" }).locator(".timeline-heading").innerText(),
      rate: await page.getByRole("region", { name: "房价策略" }).locator(".context-strip").innerText(),
      unlocks: await page.getByText(/已解锁内容：/).innerText(),
      renovation: await page.getByText(/办公空间改造 1 级/).innerText(),
    });
    const beforeReload = await visibleState();
    await page.reload();
    await expect(page.getByText("营业日 30 / 30")).toBeVisible();
    await expect(page.getByText("30 日经营周期已完成")).toBeVisible();
    await expect(page.getByRole("main")).toContainText("第 1 月");
    await expect(page.getByRole("main")).toContainText("离线结算最多 7 天");
    expect(await visibleState()).toEqual(beforeReload);
    await expect(page.getByRole("region", { name: "房价策略" })).toContainText("当前价 ¥1,800");
    await page.getByRole("region", { name: "部门管理" }).getByRole("tab", { name: "客房部" }).click();
    await expect(page.getByRole("combobox", { name: "负责人专长" })).toHaveValue("room-turnover");
    await expect(page.getByRole("spinbutton", { name: "员工人数" })).toHaveValue("4");
  });
});
