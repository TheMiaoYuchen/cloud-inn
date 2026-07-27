import { expect, test } from '@playwright/test';

test('persists the phase two loop through selective sync, placement, and route reload', async ({page}) => {
  await page.goto('/#/design');
  await page.getByRole('button',{name:'选择'}).click();
  await page.getByRole('button',{name:'格子 1,1',exact:true}).click();
  await page.getByRole('button',{name:'格子 2,2',exact:true}).click();
  await expect(page.getByRole('button',{name:'格子 1,1',exact:true})).toHaveCSS('outline-style','solid');
  await page.getByRole('button',{name:'都市暖木行政'}).click();
  await page.getByRole('button',{name:'云岫商务房'}).click();
  await page.getByRole('button',{name:'保存客房系列'}).click();
  await expect(page.getByText('母版与 3 个房型变体已保存')).toBeVisible();
  for (const variant of ['特大床房','双床房','转角景观房']) await expect(page.getByRole('button',{name:variant})).toBeVisible();

  await page.getByRole('link',{name:'同步客房系列'}).click();
  await page.getByLabel('母版灯光').fill('E2E 精准灯光');
  await page.getByRole('checkbox',{name:'特大床房 · 整体风格'}).check();
  await page.getByRole('button',{name:'应用所选同步'}).click();
  await expect(page.getByTestId('room-master-1-king-lighting')).toContainText('E2E 精准灯光');
  await expect(page.getByTestId('room-master-1-twin-lighting')).not.toContainText('E2E 精准灯光');
  await page.getByRole('button',{name:'生成系列效果图'}).click();
  await expect(page.getByRole('img',{name:'客房系列主效果图'})).toBeVisible();
  await expect(page.getByRole('img',{name:/客房系列焦点效果图/})).toHaveCount(3);

  await page.getByRole('link',{name:'设计'}).click();
  await page.getByRole('button',{name:'保存并进入楼层'}).click();
  await expect(page.getByRole('heading',{name:'高层酒店楼层规划'})).toBeVisible();
  await expect(page.getByLabel('方形环廊楼层总览')).toBeVisible();
  await expect(page.locator('.core-tower')).toContainText('核心筒');
  await page.getByRole('button',{name:'南侧开口环廊'}).click();
  await expect(page.getByLabel(/房间槽位/)).toHaveCount(6);
  await page.getByLabel('替换房型').selectOption('room-master-1-king');
  await page.getByLabel('房间槽位 north-west').click();
  await expect(page.getByLabel('房间槽位 north-west')).toContainText('特大床房');
  const persistedEconomics = await page.getByText(/现金 .* 已建 1\/4/).textContent();

  await page.reload();
  await expect(page.getByRole('heading',{name:'高层酒店楼层规划'})).toBeVisible();
  await expect(page.getByLabel('房间槽位 north-west')).toContainText('特大床房');
  await expect(page.getByText(persistedEconomics!)).toBeVisible();
  await page.goto('/#/design/variants');
  await expect(page.getByRole('img',{name:'客房系列主效果图'})).toBeVisible();
  await expect(page.getByRole('img',{name:/客房系列焦点效果图/})).toHaveCount(3);
});
