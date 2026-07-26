import { expect, test } from '@playwright/test';

test('creates a styled room series and previews the square ring floor', async ({page}) => {
  await page.goto('/#/design');
  await page.getByRole('button',{name:'都市暖木行政'}).click();
  await page.getByRole('button',{name:'云岫商务房'}).click();
  await page.getByRole('button',{name:'保存客房系列'}).click();
  await expect(page.getByText('母版与 3 个房型变体已保存')).toBeVisible();
  for (const variant of ['特大床房','双床房','转角景观房']) await expect(page.getByRole('button',{name:variant})).toBeVisible();
  await page.getByRole('button',{name:'保存并进入楼层'}).click();
  await expect(page.getByRole('heading',{name:'高层酒店楼层规划'})).toBeVisible();
  await expect(page.getByLabel('方形环廊楼层总览')).toBeVisible();
  await expect(page.locator('.core-tower')).toContainText('核心筒');
  await page.getByRole('button',{name:'南侧开口环廊'}).click();
  await expect(page.getByLabel(/房间槽位/)).toHaveCount(6);
});
