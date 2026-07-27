import {
  DEPARTMENT_CATALOG,
  validateDepartmentConfiguration,
  type LeaderSpecialtyId,
} from "./departmentCatalog";
import type { DepartmentId, DepartmentState } from "./operationsTypes";

export interface ServiceCapacityContext {
  occupiedRooms: number;
  availableRooms: number;
}

export interface DepartmentDailyCost {
  payrollCents: number;
  operatingBudgetCents: number;
  totalCents: number;
}

export interface DepartmentCapacity {
  id: DepartmentId;
  capacityRooms: number;
  capacityBps: number;
  dailyCostCents: number;
  moraleBps: number;
}

export interface ServiceBottleneck {
  departmentId: DepartmentId;
  capacityBps: number;
  reason: string;
}

export interface ServiceCapacityResult {
  departments: DepartmentCapacity[];
  overallBps: number;
  dailyCostCents: number;
  moraleBps: number;
  bottlenecks: ServiceBottleneck[];
}

const BOTTLENECK_REASONS: Readonly<Record<DepartmentId, string>> = Object.freeze({
  frontOffice: "前厅部接待能力不足，宾客可能遇到入住等待",
  housekeeping: "客房部清扫能力不足，退房后的客房可能无法及时整理",
  foodAndBeverage: "餐饮部接待能力不足，用餐高峰可能出现等待",
  engineering: "工程部维护能力不足，设施故障可能延迟修复",
  security: "安保部巡查能力不足，公共区域风险响应可能变慢",
  guestRelations: "宾客关系部服务能力不足，个性化需求可能延迟处理",
});

function boundedBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.trunc(value)));
}

function assertRoomCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负整数`);
  }
}

function catalogEntry(id: DepartmentId) {
  const item = DEPARTMENT_CATALOG.find((entry) => entry.id === id);
  if (!item) throw new Error("部门不存在");
  return item;
}

export function calculateDepartmentDailyCost(
  department: Readonly<DepartmentState>,
): DepartmentDailyCost {
  validateDepartmentConfiguration(department);
  const payrollCents = department.staffing * catalogEntry(department.id).payrollPerPersonCents;
  const operatingBudgetCents = department.dailyBudgetCents;
  return {
    payrollCents,
    operatingBudgetCents,
    totalCents: payrollCents + operatingBudgetCents,
  };
}

const QUALITY_SPECIALTIES = new Set<LeaderSpecialtyId>([
  "front-desk-care",
  "quality-control",
  "menu-quality",
  "preventive-maintenance",
  "risk-prevention",
  "personalized-care",
]);

function leaderCapacityBonusBps(
  specialty: LeaderSpecialtyId | undefined,
): number {
  if (specialty === undefined) return 0;
  return QUALITY_SPECIALTIES.has(specialty) ? 166 : 333;
}

function leaderMoraleBonusBps(
  specialty: LeaderSpecialtyId | undefined,
): number {
  if (specialty === undefined) return 0;
  return QUALITY_SPECIALTIES.has(specialty) ? 666 : 333;
}

function qualityBps(
  department: Readonly<DepartmentState>,
  recommendedBudgetPerPersonCents: number,
): number {
  const budgetTarget = department.staffing * recommendedBudgetPerPersonCents;
  const budgetSupportBps = budgetTarget === 0
    ? 0
    : Math.min(2_000, Math.trunc((department.dailyBudgetCents * 4_000) / budgetTarget));
  return boundedBps(
    3_000 +
      Math.trunc(department.trainingBps / 5) +
      Math.trunc(department.serviceStandardBps / 6) +
      budgetSupportBps +
      leaderCapacityBonusBps(department.leaderSpecialty),
  );
}

export function calculateServiceCapacity(
  departments: Readonly<Record<DepartmentId, DepartmentState>>,
  context: Readonly<ServiceCapacityContext>,
): ServiceCapacityResult {
  assertRoomCount(context.occupiedRooms, "已入住客房数");
  assertRoomCount(context.availableRooms, "可用客房数");
  if (context.occupiedRooms > context.availableRooms) {
    throw new Error("已入住客房数不能超过可用客房数");
  }

  const results = DEPARTMENT_CATALOG.map((item): DepartmentCapacity => {
    const department = departments[item.id];
    if (!department || department.id !== item.id) throw new Error("部门配置不完整");
    validateDepartmentConfiguration(department);
    const demandRooms = item.workloadBasis === "occupied"
      ? context.occupiedRooms
      : context.availableRooms;
    const capacityRooms = department.staffing * item.roomsPerStaff;
    const workloadBps = demandRooms === 0
      ? 10_000
      : boundedBps(Math.trunc((capacityRooms * 10_000) / demandRooms));
    const quality = qualityBps(
      department,
      item.recommendedBudgetPerPersonCents,
    );
    const capacityBps = demandRooms === 0
      ? 10_000
      : boundedBps(Math.trunc((quality * workloadBps) / 10_000));
    const overloadPenalty = Math.trunc(((10_000 - workloadBps) * 2 + 2) / 3);
    const capacityLeaderBonus = leaderCapacityBonusBps(
      department.leaderSpecialty,
    );
    const moraleLeaderBonus = leaderMoraleBonusBps(
      department.leaderSpecialty,
    );
    return {
      id: item.id,
      capacityRooms,
      capacityBps,
      dailyCostCents: calculateDepartmentDailyCost(department).totalCents,
      moraleBps: boundedBps(
        quality - capacityLeaderBonus + moraleLeaderBonus - overloadPenalty,
      ),
    };
  });

  const totalCapacityBps = results.reduce((sum, item) => sum + item.capacityBps, 0);
  const dailyCostCents = results.reduce((sum, item) => sum + item.dailyCostCents, 0);
  const totalMoraleBps = results.reduce((sum, item) => sum + item.moraleBps, 0);

  return {
    departments: results,
    overallBps: Math.trunc(totalCapacityBps / results.length),
    dailyCostCents,
    moraleBps: Math.trunc(totalMoraleBps / results.length),
    bottlenecks: results
      .filter((item) => item.capacityBps < 7_000)
      .map((item) => ({
        departmentId: item.id,
        capacityBps: item.capacityBps,
        reason: BOTTLENECK_REASONS[item.id],
      })),
  };
}
