import { describe, expect, it } from "vitest";

import { DEPARTMENT_IDS } from "./operationsTypes";
import {
  DEPARTMENT_CATALOG,
  validateDepartmentConfiguration,
} from "./departmentCatalog";
import { createOperationsState } from "./createOperationsState";
import {
  calculateDepartmentDailyCost,
  calculateServiceCapacity,
} from "./serviceCapacity";

describe("department catalog", () => {
  it("publishes all approved departments in stable order as immutable runtime data", () => {
    expect(DEPARTMENT_CATALOG.map(({ id }) => id)).toEqual(DEPARTMENT_IDS);
    expect(DEPARTMENT_CATALOG.map(({ name }) => name)).toEqual([
      "前厅部",
      "客房部",
      "餐饮部",
      "工程部",
      "安保部",
      "宾客关系部",
    ]);
    expect(Object.isFrozen(DEPARTMENT_CATALOG)).toBe(true);
    expect(DEPARTMENT_CATALOG.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(
      DEPARTMENT_CATALOG.every((entry) => Object.isFrozen(entry.leaderSpecialties)),
    ).toBe(true);
  });

  it("limits readable leader specialties to the approved set for each department", () => {
    const housekeeping = DEPARTMENT_CATALOG.find(
      ({ id }) => id === "housekeeping",
    );

    expect(housekeeping?.leaderSpecialties).toEqual([
      { id: "room-turnover", name: "高效清扫" },
      { id: "quality-control", name: "品质督导" },
    ]);
    expect(() =>
      validateDepartmentConfiguration({
        id: "housekeeping",
        staffing: 8,
        dailyBudgetCents: 240_000,
        trainingBps: 6_000,
        serviceStandardBps: 7_000,
        leaderSpecialty: "arrival-flow",
      }),
    ).toThrow("负责人专长不适用于客房部");
  });

  it.each([
    ["staffing", -1, "部门人数"],
    ["staffing", 501, "部门人数"],
    ["trainingBps", 10_001, "培训水平"],
    ["dailyBudgetCents", 1.5, "每日预算"],
    ["serviceStandardBps", Number.NaN, "服务标准"],
  ] as const)("rejects an invalid %s value", (field, value, message) => {
    expect(() =>
      validateDepartmentConfiguration({
        id: "frontOffice",
        staffing: 8,
        dailyBudgetCents: 160_000,
        trainingBps: 5_000,
        serviceStandardBps: 6_000,
        leaderSpecialty: "arrival-flow",
        [field]: value,
      }),
    ).toThrow(message);
  });
});

function configuredDepartments() {
  const departments = createOperationsState().departments;
  const staffing = {
    frontOffice: 8,
    housekeeping: 9,
    foodAndBeverage: 5,
    engineering: 4,
    security: 4,
    guestRelations: 4,
  } as const;

  for (const item of DEPARTMENT_CATALOG) {
    departments[item.id] = {
      id: item.id,
      staffing: staffing[item.id],
      dailyBudgetCents:
        Math.trunc((staffing[item.id] * item.recommendedBudgetPerPersonCents) / 2),
      trainingBps: 5_000,
      serviceStandardBps: 6_000,
      leaderSpecialty: item.leaderSpecialties[0].id,
    };
  }
  return departments;
}

describe("service capacity", () => {
  it("calculates deterministic integer payroll and department daily cost", () => {
    const department = configuredDepartments().housekeeping;

    expect(calculateDepartmentDailyCost(department)).toEqual({
      payrollCents: 216_000,
      operatingBudgetCents: 54_000,
      totalCents: 270_000,
    });
  });

  it("produces the exact golden aggregate and a readable housekeeping bottleneck", () => {
    const departments = configuredDepartments();
    const snapshot = structuredClone(departments);

    const result = calculateServiceCapacity(departments, {
      occupiedRooms: 80,
      availableRooms: 100,
    });

    expect(result).toMatchObject({
      overallBps: 7_127,
      dailyCostCents: 1_201_000,
      moraleBps: 7_388,
    });
    expect(result.departments.map(({ id, capacityBps }) => ({ id, capacityBps }))).toEqual([
      { id: "frontOffice", capacityBps: 7_333 },
      { id: "housekeeping", capacityBps: 6_599 },
      { id: "foodAndBeverage", capacityBps: 7_333 },
      { id: "engineering", capacityBps: 7_166 },
      { id: "security", capacityBps: 7_166 },
      { id: "guestRelations", capacityBps: 7_166 },
    ]);
    expect(result.bottlenecks).toEqual([
      {
        departmentId: "housekeeping",
        capacityBps: 6_599,
        reason: "客房部清扫能力不足，退房后的客房可能无法及时整理",
      },
    ]);
    expect(departments).toEqual(snapshot);
    expect(calculateServiceCapacity(departments, {
      occupiedRooms: 80,
      availableRooms: 100,
    })).toEqual(result);
  });

  it("applies department-matched leader specialties without simulating schedules", () => {
    const throughputDepartments = configuredDepartments();
    const qualityDepartments = structuredClone(throughputDepartments);
    qualityDepartments.housekeeping.leaderSpecialty = "quality-control";

    const throughput = calculateServiceCapacity(throughputDepartments, {
      occupiedRooms: 80,
      availableRooms: 100,
    }).departments.find(({ id }) => id === "housekeeping")!;
    const quality = calculateServiceCapacity(qualityDepartments, {
      occupiedRooms: 80,
      availableRooms: 100,
    }).departments.find(({ id }) => id === "housekeeping")!;

    expect(throughput.capacityBps).toBeGreaterThan(quality.capacityBps);
    expect(quality.moraleBps).toBeGreaterThan(throughput.moraleBps);
  });

  it("keeps zero-room and high-load results finite, integer, and stably ordered", () => {
    const departments = configuredDepartments();
    const empty = calculateServiceCapacity(departments, {
      occupiedRooms: 0,
      availableRooms: 0,
    });
    const loaded = calculateServiceCapacity(departments, {
      occupiedRooms: 500,
      availableRooms: 500,
    });

    expect(empty.overallBps).toBe(10_000);
    expect(empty.bottlenecks).toEqual([]);
    expect(loaded.bottlenecks.map(({ departmentId }) => departmentId)).toEqual([
      "frontOffice",
      "housekeeping",
      "foodAndBeverage",
      "engineering",
      "security",
      "guestRelations",
    ]);
    expect(loaded.bottlenecks[0].reason).toContain("入住等待");
    for (const value of [
      loaded.overallBps,
      loaded.dailyCostCents,
      loaded.moraleBps,
      ...loaded.departments.flatMap((department) => [
        department.capacityRooms,
        department.capacityBps,
        department.dailyCostCents,
        department.moraleBps,
      ]),
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it.each([
    [{ occupiedRooms: -1, availableRooms: 10 }, "已入住客房数"],
    [{ occupiedRooms: 1, availableRooms: Number.NaN }, "可用客房数"],
    [{ occupiedRooms: 11, availableRooms: 10 }, "不能超过"],
  ] as const)("rejects invalid room context %o", (context, message) => {
    expect(() => calculateServiceCapacity(configuredDepartments(), context)).toThrow(
      message,
    );
  });
});
