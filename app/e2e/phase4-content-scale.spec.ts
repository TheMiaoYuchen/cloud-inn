import { expect, test } from "@playwright/test";
import { createOperationsState } from "../src/domain/operations/createOperationsState";
import { createNewGame } from "../src/domain/game/state";

function phase3LegacyHotel() {
  const state = createNewGame("save-1");
  const roomBlueprint = {
    id: "room-blueprint:legacy-standard",
    name: "云岫三期标准房",
    columns: 4,
    rows: 6,
    cells: Array.from({ length: 24 }, (_, index) => ({
      x: index % 4,
      y: Math.floor(index / 4),
      zone: index % 4 === 3 ? "bathroom" as const : "bedroom" as const,
    })),
    metrics: {
      areaSquareMeters: 24,
      buildCostCents: 2_400_000,
      suggestedRateCents: 88_800,
      businessFitBps: 6_000,
    },
    visual: { status: "idle" as const },
  };
  const operations = createOperationsState("casual");
  operations.reputationBps = 8_000;
  operations.maximumReputationBps = 8_000;
  operations.discoveredNeeds = [{
    id: "market-need:leisure:room-feature",
    segmentId: "leisure",
    kind: "room-feature",
    discoveredDay: 0,
    strengthBps: 8_000,
  }];
  return {
    ...state,
    revision: 1,
    phase: "open" as const,
    cashCents: 1_000_000_000,
    roomBlueprint,
    floor: {
      id: "prototype-floor" as const,
      rooms: Array.from({ length: 8 }, (_, index) => ({
        id: `legacy-room:${index + 1}`,
        slotId: `legacy-slot:${index + 1}`,
        roomBlueprintId: roomBlueprint.id,
        committedBuildCostCents: roomBlueprint.metrics.buildCostCents,
      })),
    },
    operations,
  };
}

test("completes and restores the visible Phase 4 content-scale loop", async ({ page }) => {
  test.setTimeout(120_000);
  const legacy = phase3LegacyHotel();
  await page.addInitScript(({ legacy }) => {
    if (!localStorage.getItem("cloud-inn:save:save-1")) {
      localStorage.setItem("cloud-inn:save:save-1", JSON.stringify({
        formatVersion: 1,
        writeToken: "phase3-legacy-acceptance",
        game: legacy,
      }));
    }
    localStorage.setItem("cloud-inn:e2e-day-ms", "500");
  }, { legacy });
  await page.goto("/#/");

  const cashBefore = await page.getByTestId("hotel-cash-cents").getAttribute("data-value");
  await page.getByRole("button", { name: "启用塔楼与公共空间" }).click();
  await expect(page.getByRole("heading", { name: "云端塔楼总览" })).toBeVisible();
  await expect(page.getByTestId("hotel-cash-cents")).toHaveAttribute("data-value", cashBefore!);

  await page.getByRole("button", { name: /^选择4层，客房，/ }).click();
  await expect(page.getByRole("heading", { name: "4层平面工作区" })).toBeVisible();
  await page.getByRole("button", { name: /^选择5层，设施，/ }).click();
  await expect(page.getByRole("heading", { name: "5层平面工作区" })).toBeVisible();

  await page.getByRole("button", { name: "复制4层至17层" }).click();
  while (Number(await page.getByTestId("hotel-room-count").getAttribute("data-value")) < 120) {
    const previous = await page.getByTestId("hotel-room-count").getAttribute("data-value");
    const next = page.getByRole("button", { name: /^复制4层至\d+层$/ }).first();
    await next.click();
    await expect(page.getByTestId("hotel-room-count")).not.toHaveAttribute("data-value", previous!);
  }
  await expect(page.getByTestId("hotel-room-count")).toHaveAttribute("data-value", /12\d|1[3-9]\d|2\d\d/);

  await page.getByRole("link", { name: "空间设计" }).click();
  const facilityTypes = ["All-Day Dining", "Chinese Restaurant", "Bar", "Spa", "Gym", "Ballroom"];
  for (const [index, type] of facilityTypes.entries()) {
    await page.getByRole("combobox", { name: "公共空间类型" }).selectOption({ label: type });
    await page.getByRole("button", { name: "应用推荐布局" }).click();
    await page.getByRole("combobox", { name: "放置楼层" }).selectOption({ label: `${index + 5}层 · facility` });
    await page.getByRole("button", { name: "保存并放置" }).click();
    await expect(page.getByRole("status")).toContainText("公共空间已保存并放置");
  }

  await page.getByRole("link", { name: "运营" }).click();
  const facilityPanel = page.getByRole("region", { name: "设施经营" });
  await facilityPanel.getByRole("combobox", { name: "经营设施" }).selectOption({ label: "All-Day Dining" });
  await facilityPanel.getByRole("combobox", { name: "招牌产品" }).selectOption({ index: 1 });
  await facilityPanel.getByRole("button", { name: "保存设施策略" }).click();
  await expect(facilityPanel.getByRole("status")).toHaveText("已保存");
  await facilityPanel.getByRole("combobox", { name: "招牌产品" }).selectOption({ index: 1 });
  await facilityPanel.getByRole("button", { name: "开发招牌产品" }).click();
  await expect(facilityPanel.getByRole("status")).toHaveText("招牌产品已开发");
  await facilityPanel.getByRole("combobox", { name: "招牌产品" }).selectOption({ index: 1 });
  await facilityPanel.getByRole("button", { name: "选用招牌产品" }).click();
  await facilityPanel.getByRole("combobox", { name: "经营设施" }).selectOption({ label: "Spa" });
  await facilityPanel.getByRole("button", { name: "保存设施策略" }).click();
  await expect(facilityPanel.getByRole("status")).toHaveText("已保存");
  await facilityPanel.getByRole("button", { name: "启用营业" }).click();
  await expect(facilityPanel).toContainText("Spa · 营业中");

  for (let day = 1; day <= 30; day += 1) {
    await page.getByRole("button", { name: "推进一天" }).click();
  }
  await expect(page.getByText("营业日 30 / 30")).toBeVisible();
  const timeline = page.getByRole("region", { name: "经营报告时间线" });
  for (const category of ["日报", "周报", "月结"]) {
    await expect(timeline.getByRole("heading", { name: category })).toBeVisible();
  }
  await expect(facilityPanel).toContainText("昨日收入");
  await expect(facilityPanel).toContainText("月累计收入");

  await page.getByRole("link", { name: "酒店百科" }).click();
  for (const tab of ["内容目录", "设计系列", "市场洞察"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }
  await page.getByRole("link", { name: "塔楼" }).click();
  await page.getByRole("button", { name: /^选择8层，设施，/ }).click();
  await expect(page.getByTestId("hotel-flow-host")).toHaveAttribute("data-flow-sprite-count", /[1-9]\d*/);

  const restored = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cloud-inn:save:save-1")!);
    return {
      revision: raw.game.revision,
      cashCents: raw.game.cashCents,
      rooms: raw.game.phase4.floors.flatMap((floor: { rooms: unknown[] }) => floor.rooms).length,
      facilities: Object.keys(raw.game.phase4.facilities).length,
      reports: raw.game.operations.dailyReports.length,
    };
  });
  await page.reload();
  await expect(page.getByTestId("hotel-room-count")).toHaveAttribute("data-value", String(restored.rooms));
  await expect(page.getByTestId("hotel-cash-cents")).toHaveAttribute("data-value", String(restored.cashCents));
  expect(restored.facilities).toBeGreaterThanOrEqual(6);
  expect(restored.reports).toBe(30);
});
