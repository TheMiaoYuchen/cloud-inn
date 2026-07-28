import type { GameState } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";
import { validatePhase4State } from "./validatePhase4State";

type JsonObject = Record<string, unknown>;

const DEPARTMENTS = ["frontOffice", "housekeeping", "foodAndBeverage", "engineering", "security", "guestRelations"] as const;
const SEGMENTS = ["business", "couple", "family", "leisure", "high-net-worth", "cultural-experience"] as const;
const UNLOCKS = ["operations:pricing-automation", "operations:premium-segments", "operations:signature-service"] as const;
const UPGRADE_RULES = {
  workspace: [{ cost: 120_000, days: 2 }, { cost: 200_000, days: 3 }],
  view: [{ cost: 180_000, days: 2 }, { cost: 280_000, days: 3 }],
  familyCapacity: [{ cost: 160_000, days: 2 }, { cost: 240_000, days: 3 }],
  privacy: [{ cost: 150_000, days: 2 }, { cost: 240_000, days: 3 }],
} as const;
const LEADER_SPECIALTIES: Readonly<Record<(typeof DEPARTMENTS)[number], readonly string[]>> = {
  frontOffice: ["arrival-flow", "front-desk-care"],
  housekeeping: ["room-turnover", "quality-control"],
  foodAndBeverage: ["dining-throughput", "menu-quality"],
  engineering: ["preventive-maintenance", "rapid-repair"],
  security: ["risk-prevention", "emergency-response"],
  guestRelations: ["personalized-care", "service-recovery"],
};

export const OPERATIONS_PERSISTENCE_IDS = Object.freeze({
  departments: [...DEPARTMENTS],
  segments: [...SEGMENTS],
  unlocks: [...UNLOCKS],
});

function operationsError(detail: string): never {
  throw new Error(`浏览器存档已损坏：经营存档${detail}`);
}

function operationsObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) operationsError(`${label}结构无效`);
  return value as JsonObject;
}

function operationsArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) operationsError(`${label}结构无效`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) operationsError(`${label}无效`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    operationsError(`${label}必须是安全整数`);
  }
  return value as number;
}

function signedInteger(value: unknown, label: string): number {
  return integer(value, label, -Number.MAX_SAFE_INTEGER);
}

function bps(value: unknown, label: string): number {
  return integer(value, label, 0, 10_000);
}

function optionalInteger(record: JsonObject, key: string, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return key in record ? integer(record[key], label, minimum, maximum) : undefined;
}

function safeSum(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total < -BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER)) operationsError(`${label}超出安全整数范围`);
  return Number(total);
}

function oneOf(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) operationsError(`${label}无效`);
  return value;
}

function validateDepartments(value: unknown): void {
  const departments = operationsObject(value, "部门");
  const keys = Object.keys(departments);
  if (keys.length !== DEPARTMENTS.length || DEPARTMENTS.some((id) => !(id in departments))) operationsError("部门编号必须完整且唯一");
  for (const id of DEPARTMENTS) {
    const department = operationsObject(departments[id], "部门");
    if (department.id !== id) operationsError("部门键与编号不一致");
    integer(department.staffing, "部门人数", 0, 500);
    integer(department.dailyBudgetCents, "部门预算", 0, 100_000_000);
    bps(department.trainingBps, "培训水平");
    bps(department.serviceStandardBps, "服务标准");
    if (department.leaderSpecialty !== undefined && !LEADER_SPECIALTIES[id].includes(String(department.leaderSpecialty))) {
      operationsError("负责人专长与部门不一致");
    }
  }
}

function validatePricePolicies(value: unknown): void {
  for (const [key, raw] of Object.entries(operationsObject(value, "房价策略"))) {
    stringValue(key, "房价策略键");
    const policy = operationsObject(raw, "房价策略");
    if (stringValue(policy.roomOfferId, "客房产品编号") !== key) operationsError("房价策略键与编号不一致");
    const nightly = integer(policy.nightlyRateCents, "当前房价");
    const hasExplicit = ["baseRateCents", "minRateCents", "maxRateCents", "automaticPricing"].some((field) => field in policy);
    if (hasExplicit) {
      const base = integer(policy.baseRateCents, "基础房价", 1);
      const minimum = integer(policy.minRateCents, "最低房价", 1);
      const maximum = integer(policy.maxRateCents, "最高房价", 1);
      if (typeof policy.automaticPricing !== "boolean" || minimum > base || base > maximum || nightly < minimum || nightly > maximum) {
        operationsError("房价策略范围无效");
      }
    }
  }
}

function validateUpgrades(value: unknown, currentDay: number): void {
  for (const [key, raw] of Object.entries(operationsObject(value, "客房改造"))) {
    const upgrade = operationsObject(raw, "客房改造");
    stringValue(upgrade.roomOfferId, "改造客房产品编号");
    stringValue(upgrade.upgradeId, "改造编号");
    integer(upgrade.level, "改造等级", 1);
    if (upgrade.kind === undefined) continue;
    const kind = oneOf(upgrade.kind, Object.keys(UPGRADE_RULES), "改造类型") as keyof typeof UPGRADE_RULES;
    const level = integer(upgrade.level, "改造等级", 1, UPGRADE_RULES[kind].length);
    const rule = UPGRADE_RULES[kind][level - 1];
    if (upgrade.upgradeId !== kind || key !== `${upgrade.roomOfferId}:${kind}`) operationsError("改造键、编号与类型不一致");
    const committedDay = integer(upgrade.committedDay, "改造日期", 0, currentDay);
    const closure = integer(upgrade.remainingClosureDays, "剩余施工天数", 0);
    if (upgrade.costCents !== rule.cost || closure !== Math.max(0, rule.days - (currentDay - committedDay))) {
      operationsError("改造成本或施工天数不一致");
    }
  }
}

function validateLoans(value: unknown): void {
  const ids = new Set<string>();
  const reserved = new Set(["safety-loan:daily-settlement", "safety-loan:department-training", "safety-loan:room-renovation"]);
  for (const raw of operationsArray(value, "贷款")) {
    const loan = operationsObject(raw, "贷款");
    const id = stringValue(loan.id, "贷款编号");
    if (ids.has(id)) operationsError("贷款编号重复");
    ids.add(id);
    const principal = integer(loan.principalCents, "贷款本金", 1);
    const outstanding = integer(loan.outstandingCents, "贷款余额", 1, principal);
    const interest = bps(loan.dailyInterestBps, "贷款利率");
    integer(loan.minimumPaymentCents, "最低还款", 1, outstanding);
    if (reserved.has(id) && interest !== 10) operationsError("系统保留贷款合同无效");
  }
}

function validateNeed(raw: unknown, currentDay: number): void {
  const need = operationsObject(raw, "市场需求");
  stringValue(need.id, "市场需求编号");
  oneOf(need.segmentId, SEGMENTS, "市场需求客群");
  oneOf(need.kind, ["room-feature", "service", "price"], "市场需求类型");
  integer(need.discoveredDay, "需求发现日", 0, currentDay);
  bps(need.strengthBps, "需求强度");
}

type DailyTotals = {
  day: number; revenue: number; operating: number; finance: number; net: number;
  cash: number; reputation: number; available: number; sold: number; occupancy: number;
  categoryVersion: ReportCategoryVersion;
  roomRevenue: number; publicSpaceRevenue: number;
  departmentCost: number; facilityOperatingCost: number;
};

type ReportCategoryVersion = "legacy-none" | "legacy-classic" | "v2";

function reportCategoryVersion(report: JsonObject, label: string): ReportCategoryVersion {
  const hasRoom = "roomRevenueCents" in report;
  const hasPublicSpace = "publicSpaceRevenueCents" in report;
  const hasDepartment = "departmentCostCents" in report;
  const hasFacility = "facilityOperatingCostCents" in report;
  if (!hasRoom && !hasPublicSpace && !hasDepartment && !hasFacility) return "legacy-none";
  if (hasRoom && !hasPublicSpace && hasDepartment && !hasFacility) return "legacy-classic";
  if (hasRoom && hasPublicSpace && hasDepartment && hasFacility) return "v2";
  operationsError(`${label}必须完整包含四项收入与成本分类`);
}

function validateDailyReport(raw: unknown, currentDay: number): DailyTotals {
  const report = operationsObject(raw, "经营日报");
  const day = integer(report.day, "经营日报日期", 1, 30);
  const segments = operationsArray(report.segments, "客群日报");
  if (segments.length !== SEGMENTS.length) operationsError("日报客群目录不完整");
  const segmentIds = new Set<string>();
  const segmentRevenue: number[] = [];
  const segmentSoldValues: number[] = [];
  for (const [index, rawSegment] of segments.entries()) {
    const segment = operationsObject(rawSegment, "客群日报");
    const id = oneOf(segment.segmentId, SEGMENTS, "客群编号");
    if (id !== SEGMENTS[index]) operationsError("日报客群顺序无效");
    if (segmentIds.has(id)) operationsError("日报客群重复");
    segmentIds.add(id);
    integer(segment.demand, "客群需求");
    const sold = integer(segment.soldRooms, "客群售出客房");
    integer(segment.averageRateCents, "客群平均房价");
    segmentRevenue.push(integer(segment.revenueCents, "客群收入"));
    bps(segment.satisfactionBps, "客群满意度");
    segmentSoldValues.push(sold);
  }
  const revenue = integer(report.revenueCents, "日报收入");
  const operating = integer(report.operatingCostCents, "日报经营成本");
  const finance = integer(report.financeCostCents, "日报财务成本");
  const net = signedInteger(report.netIncomeCents, "日报净收益");
  const cash = integer(report.endingCashCents, "日报期末现金");
  const reputation = bps(report.reputationBps, "日报声誉");
  const categoryVersion = reportCategoryVersion(report, "新版日报");
  const roomRevenue = categoryVersion !== "legacy-none"
    ? integer(report.roomRevenueCents, "客房收入")
    : revenue;
  const publicSpaceRevenue = categoryVersion === "v2"
    ? integer(report.publicSpaceRevenueCents, "公共空间收入")
    : 0;
  const departmentCost = categoryVersion !== "legacy-none"
    ? integer(report.departmentCostCents, "部门成本")
    : operating;
  const facilityOperatingCost = categoryVersion === "v2"
    ? integer(report.facilityOperatingCostCents, "设施经营成本")
    : 0;
  if (
    safeSum(segmentRevenue, "客群收入") !== roomRevenue
    || safeSum([roomRevenue, publicSpaceRevenue], "日报收入分类") !== revenue
    || safeSum([departmentCost, facilityOperatingCost], "日报成本分类") !== operating
    || safeSum([revenue, -operating, -finance], "日报净收益") !== net
  ) {
    operationsError("日报汇总与客群明细不一致");
  }
  if (report.loanInterestCents !== undefined && integer(report.loanInterestCents, "贷款利息") !== finance) operationsError("贷款利息不一致");
  optionalInteger(report, "cashShortfallCents", "现金缺口");
  const available = optionalInteger(report, "availableRooms", "可售客房") ?? 0;
  const segmentSold = safeSum(segmentSoldValues, "客群售出客房");
  const sold = optionalInteger(report, "soldRooms", "售出客房") ?? segmentSold;
  const occupancy = optionalInteger(report, "occupancyBps", "入住率", 0, 10_000) ?? 0;
  if (report.soldRooms !== undefined && sold !== segmentSold) operationsError("售出客房与客群明细不一致");
  if (sold > available || (report.occupancyBps !== undefined && occupancy !== (available === 0 ? 0 : Math.trunc(sold * 10_000 / available)))) {
    operationsError("日报入住率不一致");
  }
  if (report.reputationDeltaBps !== undefined) integer(report.reputationDeltaBps, "声誉变化", -10_000, 10_000);
  for (const item of operationsArray(report.lostBookings ?? [], "流失预订")) {
    const lost = operationsObject(item, "流失预订");
    oneOf(lost.segmentId, SEGMENTS, "流失预订客群");
    oneOf(lost.code, ["hard-requirement", "price", "service", "no-inventory"], "流失原因");
    integer(lost.count, "流失预订数");
    stringValue(lost.explanation, "流失说明");
  }
  for (const item of operationsArray(report.reviews ?? [], "宾客评价")) {
    const review = operationsObject(item, "宾客评价");
    oneOf(review.segmentId, SEGMENTS, "评价客群");
    bps(review.ratingBps, "评价分数");
    stringValue(review.text, "评价文本");
  }
  for (const item of operationsArray(report.bookings ?? [], "预订")) {
    const booking = operationsObject(item, "预订");
    oneOf(booking.segmentId, SEGMENTS, "预订客群");
    stringValue(booking.roomId, "预订客房编号");
    stringValue(booking.offerId, "预订产品编号");
    integer(booking.rateCents, "预订房价");
  }
  for (const item of operationsArray(report.discoveredNeeds ?? [], "日报市场需求")) validateNeed(item, currentDay);
  return {
    day, revenue, operating, finance, net, cash, reputation, available, sold, occupancy,
    categoryVersion, roomRevenue, publicSpaceRevenue, departmentCost, facilityOperatingCost,
  };
}

function expectedTotals(reports: readonly DailyTotals[]) {
  return {
    revenue: safeSum(reports.map((r) => r.revenue), "报告收入"),
    operating: safeSum(reports.map((r) => r.operating), "报告经营成本"),
    finance: safeSum(reports.map((r) => r.finance), "报告财务成本"),
    net: safeSum(reports.map((r) => r.net), "报告净收益"),
    available: safeSum(reports.map((r) => r.available), "报告可售客房"),
    sold: safeSum(reports.map((r) => r.sold), "报告售出客房"),
    occupancy: Math.trunc(safeSum(reports.map((r) => r.occupancy), "报告入住率") / reports.length),
    reputation: Math.trunc(safeSum(reports.map((r) => r.reputation), "报告声誉") / reports.length),
    roomRevenue: safeSum(reports.map((r) => r.roomRevenue), "报告客房收入"),
    publicSpaceRevenue: safeSum(reports.map((r) => r.publicSpaceRevenue), "报告公共空间收入"),
    departmentCost: safeSum(reports.map((r) => r.departmentCost), "报告部门成本"),
    facilityOperatingCost: safeSum(reports.map((r) => r.facilityOperatingCost), "报告设施经营成本"),
  };
}

function validateAggregate(raw: unknown, reports: readonly DailyTotals[], kind: "weekly" | "monthly", number: number): void {
  const aggregate = operationsObject(raw, kind === "weekly" ? "周报" : "月结");
  const start = reports[0].day;
  const end = reports[reports.length - 1].day;
  const numberKey = kind === "weekly" ? "week" : "month";
  if (aggregate[numberKey] !== number || aggregate.startDay !== start || aggregate.endDay !== end) operationsError("周期报告窗口无效");
  const totals = expectedTotals(reports);
  const versions = new Set(reports.map(({ categoryVersion }) => categoryVersion));
  if (versions.size !== 1) operationsError("周期报告不能混合日报版本");
  const categoryVersion = reports[0].categoryVersion;
  const expectedAggregateVersion = categoryVersion === "v2" ? "v2" : "legacy-none";
  if (reportCategoryVersion(aggregate, "新版周期报告") !== expectedAggregateVersion) {
    operationsError("周期报告与日报版本不一致");
  }
  if (aggregate.revenueCents !== totals.revenue || aggregate.netIncomeCents !== totals.net) operationsError("周期报告汇总不一致");
  if (aggregate.operatingCostCents !== undefined && aggregate.operatingCostCents !== totals.operating) operationsError("周期经营成本不一致");
  if (aggregate.financeCostCents !== undefined && aggregate.financeCostCents !== totals.finance) operationsError("周期财务成本不一致");
  if (categoryVersion === "v2" && (
    aggregate.roomRevenueCents !== totals.roomRevenue
    || aggregate.publicSpaceRevenueCents !== totals.publicSpaceRevenue
    || aggregate.departmentCostCents !== totals.departmentCost
    || aggregate.facilityOperatingCostCents !== totals.facilityOperatingCost
  )) operationsError("周期收入与成本分类不一致");
  if (aggregate.availableRooms !== undefined && aggregate.availableRooms !== totals.available) operationsError("周期可售客房不一致");
  if (aggregate.soldRooms !== undefined && aggregate.soldRooms !== totals.sold) operationsError("周期售出客房不一致");
  const occupancy = kind === "weekly" ? aggregate.averageOccupancyBps : aggregate.averageOccupancyBps;
  if (kind === "weekly" && occupancy !== totals.occupancy) operationsError("周报入住率不一致");
  if (occupancy !== undefined && occupancy !== totals.occupancy) operationsError("周期入住率不一致");
  const reputation = aggregate.reputationBps;
  if (kind === "weekly" && reputation !== totals.reputation) operationsError("周报声誉不一致");
  if (reputation !== undefined && reputation !== totals.reputation) operationsError("周期声誉不一致");
  if (kind === "monthly") {
    if (aggregate.debtPaymentCents !== totals.finance || aggregate.endingCashCents !== reports[reports.length - 1].cash) operationsError("月结财务字段不一致");
  }
  if (aggregate.topResultCode !== undefined) stringValue(aggregate.topResultCode, "周期结果编号");
  if (aggregate.topReasonCode !== undefined) oneOf(aggregate.topReasonCode, ["hard-requirement", "price", "service", "no-inventory", "none"], "周期原因编号");
  if (aggregate.suggestedActionCode !== undefined) stringValue(aggregate.suggestedActionCode, "周期建议编号");
}

function validateOperations(value: unknown, game: JsonObject): void {
  const operations = operationsObject(value, "经营状态");
  if (operations.rulesetVersion !== "operations-v1") operationsError("规则版本无效");
  oneOf(operations.difficulty, ["casual", "management"], "难度");
  const reputation = bps(operations.reputationBps, "当前声誉");
  const maximumReputation = bps(operations.maximumReputationBps, "最高声誉");
  if (maximumReputation < reputation) operationsError("最高声誉低于当前声誉");
  const currentDay = integer(game.currentDay, "当前经营日", 0, 30);
  validateDepartments(operations.departments);
  validatePricePolicies(operations.pricePolicies);
  validateUpgrades(operations.offerUpgrades, currentDay);
  validateLoans(operations.loans);
  const needs = operationsArray(operations.discoveredNeeds, "市场需求");
  const needIds = new Set<string>();
  for (const need of needs) {
    validateNeed(need, currentDay);
    const id = (need as JsonObject).id as string;
    if (needIds.has(id)) operationsError("市场需求编号重复");
    needIds.add(id);
  }
  if (operations.segmentMix !== undefined) {
    let total = 0;
    for (const [segment, value] of Object.entries(operationsObject(operations.segmentMix, "客群占比"))) {
      oneOf(segment, SEGMENTS, "客群占比编号");
      total += bps(value, "客群占比");
    }
    if (total !== 0 && total !== 10_000) operationsError("客群占比合计无效");
  }
  const daily = operationsArray(operations.dailyReports, "经营日报");
  if (daily.length > 30) operationsError("经营日报最多保留30天");
  const totals = daily.map((report) => validateDailyReport(report, currentDay));
  for (let index = 0; index < totals.length; index += 1) {
    if (index > 0 && totals[index].day <= totals[index - 1].day) operationsError("经营日报日期必须唯一且严格递增");
  }
  if (totals.length > 0) {
    const last = totals[totals.length - 1];
    if (last.day !== currentDay || last.cash !== game.cashCents || last.reputation !== reputation) operationsError("经营日报与游戏状态不一致");
  }
  const byDay = new Map(totals.map((report) => [report.day, report]));
  const expectedWeeks = [1, 2, 3, 4].flatMap((week) => {
    const reports = Array.from({ length: 7 }, (_, offset) => byDay.get((week - 1) * 7 + offset + 1));
    return reports.every(Boolean) ? [{ week, reports: reports as DailyTotals[] }] : [];
  });
  const weeks = operationsArray(operations.weeklyReports, "周报");
  if (weeks.length !== expectedWeeks.length) operationsError("周报边界不完整");
  expectedWeeks.forEach(({ week, reports }, index) => validateAggregate(weeks[index], reports, "weekly", week));
  const monthReports = Array.from({ length: 30 }, (_, offset) => byDay.get(offset + 1));
  const closes = operationsArray(operations.monthlyCloses, "月结");
  const hasMonth = monthReports.every(Boolean);
  if (closes.length !== (hasMonth ? 1 : 0)) operationsError("月结边界无效");
  if (hasMonth) validateAggregate(closes[0], monthReports as DailyTotals[], "monthly", 1);
  const unlocks = operationsArray(operations.unlockedContent, "解锁内容");
  const unlockSet = new Set<string>();
  for (const unlock of unlocks) {
    const key = oneOf(unlock, UNLOCKS, "解锁内容编号");
    if (unlockSet.has(key)) operationsError("解锁内容编号重复");
    unlockSet.add(key);
  }
  const speed = integer(operations.timeSpeed, "时间速度");
  if (![0, 1, 2, 4].includes(speed)) operationsError("时间速度无效");
  if (operations.lastOfflineCheckpointMs !== null) integer(operations.lastOfflineCheckpointMs, "离线检查点");
  const hasOperationsHistory = daily.length > 0 || weeks.length > 0 || closes.length > 0;
  if (currentDay === 30 && (speed !== 0 || (hasOperationsHistory && operations.lastOfflineCheckpointMs === null))) {
    operationsError("第30日必须暂停，有经营历史时还必须保存检查点");
  }
}

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  return value as JsonObject;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validateVisualTree(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(validateVisualTree);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const candidate = value as JsonObject;
  if ("assetPath" in candidate) {
    const path = candidate.assetPath;
    if (typeof path !== "string" || !path.startsWith("/visuals/") || path.includes("..")) {
      throw new Error("浏览器存档已损坏，无法加载");
    }
  }
  Object.values(candidate).forEach(validateVisualTree);
}

function validatePhase2(value: unknown): void {
  const phase2 = object(value);
  if (
    !("hotelGene" in phase2) ||
    !("roomMaster" in phase2) ||
    !Array.isArray(phase2.roomVariants) ||
    !("corridorTemplate" in phase2)
  ) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  const serialized = JSON.stringify(phase2).toLowerCase();
  if (["base64", "api_key", "api-key", "token", "secret"].some((term) => serialized.includes(term))) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  validateVisualTree(phase2);
}

export function validateBrowserGameState(
  value: unknown,
  expectedSaveId: SaveId,
): GameState {
  const game = object(value);
  if (
    game.schemaVersion !== 1 ||
    typeof game.rulesetVersion !== "string" ||
    game.saveId !== expectedSaveId ||
    !safeInteger(game.revision) ||
    !["design", "floor", "ready", "open"].includes(String(game.phase)) ||
    !safeInteger(game.currentDay) ||
    !safeInteger(game.cashCents) ||
    !safeInteger(game.rateCents) ||
    !(game.roomBlueprint === null || typeof game.roomBlueprint === "object") ||
    !Array.isArray(object(game.floor).rooms) ||
    !Array.isArray(game.reports) ||
    !(game.latestReport === null || typeof game.latestReport === "object")
  ) {
    throw new Error("浏览器存档已损坏，无法加载");
  }
  if (game.phase2 !== undefined) validatePhase2(game.phase2);
  if (game.operations !== undefined) validateOperations(game.operations, game);
  if (game.phase4 !== undefined) validatePhase4State(game.phase4);
  return structuredClone(game) as unknown as GameState;
}
