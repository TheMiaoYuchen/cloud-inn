import type { Page } from "@playwright/test";

export async function ensureBrowserSave(page: Page): Promise<void> {
  await page.goto("/");
  const firstRunName = page.getByRole("textbox", { name: "存档名称" });
  if (await firstRunName.isVisible()) {
    await firstRunName.fill("端到端测试旅店");
    await page.getByRole("button", { name: "跳过 AI，开始经营" }).click();
    await page.getByRole("navigation", { name: "主导航" }).waitFor();
  }
}
