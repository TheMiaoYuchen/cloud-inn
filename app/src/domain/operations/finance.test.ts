import { describe, expect, it } from "vitest";

import {
  DAILY_SETTLEMENT_SAFETY_LOAN_ID,
  DEPARTMENT_TRAINING_SAFETY_LOAN_ID,
  ROOM_RENOVATION_SAFETY_LOAN_ID,
  applyLoanRepayment,
  coverCasualShortfall,
  createLoan,
  projectLoanSettlement,
  projectOperationsFinance,
  validateLoan,
  validateLoanRequest,
  validateLoans,
  type LoanRequest,
} from "./finance";

const request: LoanRequest = {
  id: "loan:bank:001",
  amountCents: 100_000,
  dailyInterestBps: 25,
  termDays: 30,
};

describe("operations finance", () => {
  it("creates a loan with a deterministic minimum payment from explicit terms", () => {
    expect(createLoan(request, [])).toEqual({
      id: "loan:bank:001",
      principalCents: 100_000,
      outstandingCents: 100_000,
      dailyInterestBps: 25,
      minimumPaymentCents: 3_334,
    });
  });

  it.each([
    ["id", ""],
    ["id", " loan:spaced"],
    ["amountCents", 0],
    ["amountCents", Number.MAX_SAFE_INTEGER + 1],
    ["dailyInterestBps", -1],
    ["dailyInterestBps", 10_001],
    ["termDays", 0],
    ["termDays", 1.5],
  ] as const)("rejects an invalid loan request %s=%s", (field, value) => {
    expect(() => validateLoanRequest({ ...request, [field]: value }, [])).toThrow();
  });

  it("rejects a request whose explicit ID collides with an existing loan", () => {
    const loan = createLoan(request, []);

    expect(() => validateLoanRequest(request, [loan])).toThrow("贷款编号必须唯一");
  });

  it.each([
    DAILY_SETTLEMENT_SAFETY_LOAN_ID,
    DEPARTMENT_TRAINING_SAFETY_LOAN_ID,
    ROOM_RENOVATION_SAFETY_LOAN_ID,
  ])("reserves internal safety loan ID %s from voluntary requests", (id) => {
    expect(() => createLoan({ ...request, id }, [])).toThrow("安全贷款编号为系统保留");
  });

  it("rejects invalid persisted loans and duplicate IDs", () => {
    const loan = createLoan(request, []);

    expect(() => validateLoan({ ...loan, outstandingCents: loan.principalCents + 1 })).toThrow(
      "贷款余额不能超过本金",
    );
    expect(() => validateLoans([loan, { ...loan }])).toThrow("贷款编号必须唯一");
    expect(() => validateLoan({ ...loan, principalCents: Number.NaN })).toThrow("安全整数");
  });

  it("rejects inactive persisted records and minimum payments above outstanding balance", () => {
    const loan = createLoan(request, []);

    expect(() => validateLoan({ ...loan, outstandingCents: 0 })).toThrow("贷款余额");
    expect(() => validateLoan({ ...loan, outstandingCents: 1, minimumPaymentCents: 2 })).toThrow(
      "最低还款不能超过贷款余额",
    );
  });

  it("calculates deterministic daily interest with safe BigInt arithmetic", () => {
    const loans = [
      createLoan(request, []),
      createLoan({ ...request, id: "loan:bank:002", amountCents: 99_999, dailyInterestBps: 33 }, [
        createLoan(request, []),
      ]),
    ];

    expect(projectLoanSettlement(loans)).toEqual({
      interestCents: 579,
      loans,
    });
    expect(projectLoanSettlement(loans).loans).not.toBe(loans);
  });

  it("keeps original principal, clamps minimum payment, and removes a settled record", () => {
    const loan = createLoan(request, []);
    const partial = applyLoanRepayment([loan], loan.id, 40_000);

    expect(partial).toEqual([{
      ...loan,
      outstandingCents: 60_000,
    }]);
    const nearFull = applyLoanRepayment(partial, loan.id, 59_999);
    expect(nearFull).toEqual([{
      ...loan,
      outstandingCents: 1,
      minimumPaymentCents: 1,
    }]);
    expect(applyLoanRepayment(nearFull, loan.id, 1)).toEqual([]);
    expect(loan.principalCents).toBe(100_000);
  });

  it("allows a fully repaid voluntary loan ID to be reused", () => {
    const loan = createLoan(request, []);

    expect(createLoan(request, applyLoanRepayment([loan], loan.id, loan.outstandingCents))).toEqual(loan);
  });

  it.each([0, -1, 100_001, Number.NaN])("rejects invalid repayment %s", (amountCents) => {
    const loan = createLoan(request, []);

    expect(() => applyLoanRepayment([loan], loan.id, amountCents)).toThrow();
  });

  it("covers the exact casual shortfall and deterministically merges repeat safety financing", () => {
    const first = coverCasualShortfall(10_000, 25_000, [], DEPARTMENT_TRAINING_SAFETY_LOAN_ID);
    const second = coverCasualShortfall(0, 5_000, first.loans, DEPARTMENT_TRAINING_SAFETY_LOAN_ID);

    expect(first).toMatchObject({ borrowedCents: 15_000, endingCashCents: 0 });
    expect(second.loans).toEqual([{
      id: DEPARTMENT_TRAINING_SAFETY_LOAN_ID,
      principalCents: 20_000,
      outstandingCents: 20_000,
      dailyInterestBps: 10,
      minimumPaymentCents: 200,
    }]);
  });

  it("rejects unknown safety IDs and an existing reserved loan with altered terms", () => {
    expect(() => coverCasualShortfall(0, 1, [], "safety-loan:unknown")).toThrow(
      "安全贷款编号无效",
    );
    expect(() => coverCasualShortfall(0, 1, [{
      id: DAILY_SETTLEMENT_SAFETY_LOAN_ID,
      principalCents: 100,
      outstandingCents: 100,
      dailyInterestBps: 20,
      minimumPaymentCents: 1,
    }], DAILY_SETTLEMENT_SAFETY_LOAN_ID)).toThrow("安全贷款合同无效");
  });

  it("projects one authoritative interest charge and casual shortfall financing", () => {
    const loan = createLoan(request, []);
    const result = projectOperationsFinance({
      difficulty: "casual",
      cashCents: 10_000,
      revenueCents: 1_000,
      operatingCostCents: 30_000,
      loans: [loan],
    });

    expect(result).toMatchObject({
      interestCents: 250,
      totalCostCents: 30_250,
      netIncomeCents: -29_250,
      cashShortfallCents: 19_250,
      endingCashCents: 0,
    });
    expect(result.loans).toHaveLength(2);
  });

  it("rejects an unaffordable management settlement", () => {
    expect(() => projectOperationsFinance({
      difficulty: "management",
      cashCents: 10_000,
      revenueCents: 0,
      operatingCostCents: 10_001,
      loans: [],
    })).toThrow("现金不足以完成经营结算");
  });

  it.each([
    ["cashCents", -1],
    ["revenueCents", Number.MAX_SAFE_INTEGER + 1],
    ["operatingCostCents", Number.NaN],
  ] as const)("rejects unsafe finance input %s=%s", (field, value) => {
    expect(() => projectOperationsFinance({
      difficulty: "casual",
      cashCents: 0,
      revenueCents: 0,
      operatingCostCents: 0,
      loans: [],
      [field]: value,
    })).toThrow("安全整数");
  });
});
