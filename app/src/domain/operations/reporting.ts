import type {
  GuestSegmentId,
  LostBookingReasonCode,
  MonthlyOperationsClose,
  OperationsDailyReport,
  OperationsState,
  WeeklyOperationsReport,
} from "./operationsTypes";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;

function safeInteger(value: number, label: string, allowNegative = false): number {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new Error(`${label}必须是${allowNegative ? "" : "非负"}安全整数`);
  }
  return value;
}

function safeSum(values: readonly number[], label: string, allowNegative = false): number {
  const total = values.reduce(
    (sum, value) => sum + BigInt(safeInteger(value, label, allowNegative)),
    0n,
  );
  if (total > MAX_SAFE_BIGINT || total < (allowNegative ? MIN_SAFE_BIGINT : 0n)) {
    throw new Error(`${label}超出安全整数范围`);
  }
  return Number(total);
}

function validateReports(
  reports: ReadonlyArray<Readonly<OperationsDailyReport>>,
  expectedLength: number,
  label: string,
): void {
  if (reports.length !== expectedLength) throw new Error(`${label}必须包含连续${expectedLength === 7 ? "七" : "三十"}天日报`);
  const seen = new Set<number>();
  reports.forEach((report, index) => {
    safeInteger(report.day, "日报日期");
    if (report.day <= 0) throw new Error("日报日期必须是正安全整数");
    if (seen.has(report.day)) throw new Error("日报日期必须唯一");
    seen.add(report.day);
    if (index > 0 && report.day !== reports[index - 1].day + 1) {
      throw new Error("日报日期必须连续且严格递增");
    }
  });
}

function highestCode(counts: ReadonlyMap<string, bigint>, fallback: string): string {
  return [...counts.entries()].sort(([leftCode, leftCount], [rightCode, rightCount]) =>
    leftCount === rightCount
      ? leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0
      : leftCount > rightCount ? -1 : 1,
  )[0]?.[0] ?? fallback;
}

function topCodes(reports: ReadonlyArray<Readonly<OperationsDailyReport>>) {
  const segmentCounts = new Map<GuestSegmentId, bigint>();
  const reasonCounts = new Map<LostBookingReasonCode, bigint>();
  for (const report of reports) {
    for (const segment of report.segments) {
      safeInteger(segment.soldRooms, "分群售出客房");
      segmentCounts.set(
        segment.segmentId,
        (segmentCounts.get(segment.segmentId) ?? 0n) + BigInt(segment.soldRooms),
      );
    }
    for (const reason of report.lostBookings ?? []) {
      safeInteger(reason.count, "流失预订数量");
      reasonCounts.set(reason.code, (reasonCounts.get(reason.code) ?? 0n) + BigInt(reason.count));
    }
  }
  const topResultCode = `segment:${highestCode(segmentCounts, "none")}`;
  const topReasonCode = highestCode(reasonCounts, "none") as LostBookingReasonCode | "none";
  const suggestedActionCode: Record<LostBookingReasonCode | "none", string> = {
    "hard-requirement": "improve-room-offer",
    price: "adjust-pricing",
    service: "improve-service-capacity",
    "no-inventory": "expand-inventory",
    none: "maintain-operations",
  };
  return { topResultCode, topReasonCode, suggestedActionCode: suggestedActionCode[topReasonCode] };
}

function commonTotals(reports: ReadonlyArray<Readonly<OperationsDailyReport>>) {
  const availableRooms = safeSum(reports.map((report) => report.availableRooms ?? 0), "可售客房总数");
  const soldRooms = safeSum(reports.map((report) => report.soldRooms ?? 0), "售出客房总数");
  return {
    revenueCents: safeSum(reports.map(({ revenueCents }) => revenueCents), "收入"),
    operatingCostCents: safeSum(reports.map(({ operatingCostCents }) => operatingCostCents), "经营成本"),
    financeCostCents: safeSum(reports.map(({ financeCostCents }) => financeCostCents), "财务成本"),
    netIncomeCents: safeSum(reports.map(({ netIncomeCents }) => netIncomeCents), "净利润", true),
    availableRooms,
    soldRooms,
    averageOccupancyBps: Math.trunc(safeSum(reports.map((report) => report.occupancyBps ?? 0), "入住率") / reports.length),
    reputationBps: Math.trunc(safeSum(reports.map(({ reputationBps }) => reputationBps), "声誉") / reports.length),
    ...topCodes(reports),
  };
}

export function aggregateWeeklyReport(
  reports: ReadonlyArray<Readonly<OperationsDailyReport>>,
): WeeklyOperationsReport {
  validateReports(reports, 7, "周报");
  const startDay = reports[0].day;
  const endDay = reports[reports.length - 1].day;
  if ((startDay - 1) % 7 !== 0) throw new Error("周报日期窗口必须按七天对齐");
  if (endDay > 30) throw new Error("周报不能超过第 30 日经营终点");
  return {
    week: Math.trunc((startDay - 1) / 7) + 1,
    startDay,
    endDay,
    ...commonTotals(reports),
  };
}

export function aggregateMonthlyClose(
  reports: ReadonlyArray<Readonly<OperationsDailyReport>>,
): MonthlyOperationsClose {
  validateReports(reports, 30, "月结");
  const startDay = reports[0].day;
  const endDay = reports[reports.length - 1].day;
  if ((startDay - 1) % 30 !== 0) throw new Error("月结日期窗口必须按三十天对齐");
  if (endDay > 30) throw new Error("月结不能超过第 30 日经营终点");
  const totals = commonTotals(reports);
  return {
    month: Math.trunc((startDay - 1) / 30) + 1,
    startDay,
    endDay,
    ...totals,
    debtPaymentCents: totals.financeCostCents,
    endingCashCents: safeInteger(reports[reports.length - 1].endingCashCents, "期末现金"),
  };
}

export function projectPeriodicReports(
  operations: Readonly<OperationsState>,
): Pick<OperationsState, "weeklyReports" | "monthlyCloses"> {
  const dailyReports = operations.dailyReports;
  if (dailyReports.length === 0) {
    return {
      weeklyReports: operations.weeklyReports.map((report) => structuredClone(report)),
      monthlyCloses: operations.monthlyCloses.map((report) => structuredClone(report)),
    };
  }
  const lastDay = dailyReports[dailyReports.length - 1].day;
  const weeklyReports = operations.weeklyReports.map((report) => structuredClone(report));
  const monthlyCloses = operations.monthlyCloses.map((report) => structuredClone(report));
  if ([7, 14, 21, 28].includes(lastDay) && !weeklyReports.some(({ endDay }) => endDay === lastDay)) {
    weeklyReports.push(aggregateWeeklyReport(dailyReports.slice(-7)));
  }
  if (lastDay === 30 && !monthlyCloses.some(({ endDay }) => endDay === lastDay)) {
    monthlyCloses.push(aggregateMonthlyClose(dailyReports.slice(-30)));
  }
  return { weeklyReports, monthlyCloses };
}
