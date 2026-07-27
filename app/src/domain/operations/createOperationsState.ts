import type {
  DepartmentId,
  DepartmentState,
  Difficulty,
  OperationsState,
} from "./operationsTypes";

const DEPARTMENT_IDS: readonly DepartmentId[] = [
  "frontOffice",
  "housekeeping",
  "foodAndBeverage",
  "engineering",
  "security",
  "guestRelations",
];

function createDepartment(id: DepartmentId): DepartmentState {
  return {
    id,
    staffing: 0,
    dailyBudgetCents: 0,
    trainingBps: 0,
    serviceStandardBps: 5_000,
  };
}

export function createOperationsState(
  difficulty: Difficulty = "casual",
): OperationsState {
  const departments = Object.fromEntries(
    DEPARTMENT_IDS.map((id) => [id, createDepartment(id)]),
  ) as Record<DepartmentId, DepartmentState>;

  return {
    rulesetVersion: "operations-v1",
    difficulty,
    reputationBps: 5_000,
    departments,
    pricePolicies: {},
    offerUpgrades: {},
    loans: [],
    discoveredNeeds: [],
    dailyReports: [],
    weeklyReports: [],
    monthlyCloses: [],
    maximumReputationBps: 5_000,
    unlockedContent: [],
    timeSpeed: 0,
    lastOfflineCheckpointMs: null,
  };
}
