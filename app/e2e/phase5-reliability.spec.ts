import { expect, test } from "@playwright/test";
import { ensureBrowserSave } from "./reliabilitySetup";

test("first run keeps AI optional and exposes only bounded diagnostics", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "创建你的 Cloud Inn" })).toBeVisible();
  await page.getByRole("textbox", { name: "存档名称" }).fill("云端旅店一号");
  await page.getByRole("textbox", { name: "提供方令牌" }).fill("never-render-this-token");
  await page.getByRole("button", { name: "跳过 AI，开始经营" }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByText("never-render-this-token")).toHaveCount(0);

  await page.getByRole("link", { name: "诊断" }).click();
  await expect(page.getByRole("heading", { name: "诊断与 AI 设置" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("never-render-this-token");
  await expect(page.getByRole("region", { name: "AI 服务" })).toContainText("暂不可用");
  await expect(page.getByRole("region", { name: "AI 服务" })).toContainText("network.offline");
});

test("offline visual jobs survive reload and remain cancellable", async ({ page }) => {
  await ensureBrowserSave(page);
  await page.getByRole("link", { name: "效果图" }).click();
  await page.getByRole("textbox", { name: "描述想要的氛围与材质" }).fill("雨夜中的温暖木质大堂");
  await page.getByLabel("分辨率").selectOption("1k");
  await page.getByRole("button", { name: "加入生成队列" }).click();
  await expect(page.getByText("效果图任务已加入持久队列")).toBeVisible();
  await expect(page.getByText("已排队")).toBeVisible();

  await page.reload();
  await expect(page.getByText("已排队")).toBeVisible();
  await page.getByRole("button", { name: "取消任务" }).click();
  await expect(page.getByText("已取消")).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("雨夜中的温暖木质大堂");
});

test("save manager creates and renames without offering deletion", async ({ page }) => {
  await ensureBrowserSave(page);
  await page.getByRole("link", { name: "存档" }).click();
  await expect(page.getByRole("heading", { name: "存档管理" })).toBeVisible();
  await expect(page.getByRole("button", { name: /删除/u })).toHaveCount(0);

  await page.getByRole("textbox", { name: "新存档名称" }).fill("第二家旅店");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("button", { name: /第二家旅店/u })).toBeVisible();
  await page.getByRole("textbox", { name: "新名称" }).fill("第二家云端旅店");
  await page.getByRole("button", { name: "改名" }).click();
  await expect(page.getByRole("button", { name: /第二家云端旅店/u })).toBeVisible();

  await page.getByRole("button", { name: "导出 .cloudinn" }).click();
  await expect(page.getByRole("status")).toContainText("归档已导出");
  await page.getByRole("button", { name: "检查导入文件" }).click();
  await expect(page.getByRole("complementary", { name: "导入检查结果" })).toContainText("可以导入");
  await page.getByRole("button", { name: "确认导入为新存档" }).click();
  await expect(page.getByRole("status")).toContainText("归档已作为新存档导入");
});
