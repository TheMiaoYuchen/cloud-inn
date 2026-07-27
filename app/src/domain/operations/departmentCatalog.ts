import { DEPARTMENT_IDS, type DepartmentId } from "./operationsTypes";

export type LeaderSpecialtyId =
  | "arrival-flow"
  | "front-desk-care"
  | "room-turnover"
  | "quality-control"
  | "dining-throughput"
  | "menu-quality"
  | "preventive-maintenance"
  | "rapid-repair"
  | "risk-prevention"
  | "emergency-response"
  | "personalized-care"
  | "service-recovery";

export interface DepartmentConfiguration {
  id: DepartmentId;
  staffing: number;
  dailyBudgetCents: number;
  trainingBps: number;
  serviceStandardBps: number;
  leaderSpecialty?: LeaderSpecialtyId;
}

export interface DepartmentCatalogEntry {
  id: DepartmentId;
  name: string;
  payrollPerPersonCents: number;
  recommendedBudgetPerPersonCents: number;
  roomsPerStaff: number;
  workloadBasis: "occupied" | "available";
  leaderSpecialties: ReadonlyArray<Readonly<{
    id: LeaderSpecialtyId;
    name: string;
  }>>;
}

export const DEPARTMENT_LIMITS = Object.freeze({
  staffing: Object.freeze({ min: 0, max: 500 }),
  dailyBudgetCents: Object.freeze({ min: 0, max: 100_000_000 }),
  trainingBps: Object.freeze({ min: 0, max: 10_000 }),
  serviceStandardBps: Object.freeze({ min: 0, max: 10_000 }),
});

export const TRAINING_COST_PER_BPS_CENTS = 200;

export function calculateTrainingCostCents(
  previousTrainingBps: number,
  nextTrainingBps: number,
): number {
  assertBoundedInteger(
    previousTrainingBps,
    DEPARTMENT_LIMITS.trainingBps,
    "培训水平",
  );
  assertBoundedInteger(
    nextTrainingBps,
    DEPARTMENT_LIMITS.trainingBps,
    "培训水平",
  );
  return Math.max(0, nextTrainingBps - previousTrainingBps) * TRAINING_COST_PER_BPS_CENTS;
}

function entry(
  id: DepartmentId,
  name: string,
  payrollPerPersonCents: number,
  recommendedBudgetPerPersonCents: number,
  roomsPerStaff: number,
  workloadBasis: "occupied" | "available",
  specialties: Array<{ id: LeaderSpecialtyId; name: string }>,
): Readonly<DepartmentCatalogEntry> {
  return Object.freeze({
    id,
    name,
    payrollPerPersonCents,
    recommendedBudgetPerPersonCents,
    roomsPerStaff,
    workloadBasis,
    leaderSpecialties: Object.freeze(
      specialties.map((specialty) => Object.freeze(specialty)),
    ),
  });
}

export const DEPARTMENT_CATALOG: ReadonlyArray<Readonly<DepartmentCatalogEntry>> =
  Object.freeze([
    entry("frontOffice", "前厅部", 28_000, 20_000, 10, "occupied", [
      { id: "arrival-flow", name: "高效入住" },
      { id: "front-desk-care", name: "前台关怀" },
    ]),
    entry("housekeeping", "客房部", 24_000, 12_000, 8, "occupied", [
      { id: "room-turnover", name: "高效清扫" },
      { id: "quality-control", name: "品质督导" },
    ]),
    entry("foodAndBeverage", "餐饮部", 27_000, 20_000, 16, "occupied", [
      { id: "dining-throughput", name: "餐饮协同" },
      { id: "menu-quality", name: "出品品质" },
    ]),
    entry("engineering", "工程部", 32_000, 18_000, 25, "available", [
      { id: "preventive-maintenance", name: "预防维护" },
      { id: "rapid-repair", name: "快速抢修" },
    ]),
    entry("security", "安保部", 26_000, 16_000, 25, "available", [
      { id: "risk-prevention", name: "风险预防" },
      { id: "emergency-response", name: "应急响应" },
    ]),
    entry("guestRelations", "宾客关系部", 29_000, 13_000, 20, "occupied", [
      { id: "personalized-care", name: "个性关怀" },
      { id: "service-recovery", name: "服务补救" },
    ]),
  ]);

const CATALOG_BY_ID = new Map(DEPARTMENT_CATALOG.map((item) => [item.id, item]));

export function isDepartmentId(value: unknown): value is DepartmentId {
  return typeof value === "string" && DEPARTMENT_IDS.includes(value as DepartmentId);
}

function assertBoundedInteger(
  value: number,
  bounds: Readonly<{ min: number; max: number }>,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${label}必须是 ${bounds.min} 到 ${bounds.max} 的整数`);
  }
}

export function validateDepartmentConfiguration(
  input: Readonly<DepartmentConfiguration>,
): void {
  if (!isDepartmentId(input.id)) throw new Error("部门不存在");
  assertBoundedInteger(input.staffing, DEPARTMENT_LIMITS.staffing, "部门人数");
  assertBoundedInteger(
    input.dailyBudgetCents,
    DEPARTMENT_LIMITS.dailyBudgetCents,
    "每日预算",
  );
  assertBoundedInteger(input.trainingBps, DEPARTMENT_LIMITS.trainingBps, "培训水平");
  assertBoundedInteger(
    input.serviceStandardBps,
    DEPARTMENT_LIMITS.serviceStandardBps,
    "服务标准",
  );
  if (
    input.leaderSpecialty !== undefined &&
    !CATALOG_BY_ID.get(input.id)?.leaderSpecialties.some(
      ({ id }) => id === input.leaderSpecialty,
    )
  ) {
    throw new Error(`负责人专长不适用于${CATALOG_BY_ID.get(input.id)?.name}`);
  }
}
