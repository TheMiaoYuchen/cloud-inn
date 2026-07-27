import type { Difficulty, LoanState } from "./operationsTypes";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export interface LoanRequest {
  id: string;
  amountCents: number;
  dailyInterestBps: number;
  termDays: number;
}

function assertInteger(value: number, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 的安全整数`);
  }
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE) throw new Error(`${label}超出安全整数范围`);
  return Number(value);
}

function compareIds(left: Readonly<LoanState>, right: Readonly<LoanState>): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateId(id: string): void {
  if (id.length === 0 || id.trim() !== id) throw new Error("贷款编号不能为空且不能包含首尾空格");
}

export function validateLoan(loan: Readonly<LoanState>): void {
  validateId(loan.id);
  assertInteger(loan.principalCents, "贷款本金", 1);
  assertInteger(loan.outstandingCents, "贷款余额", 0);
  if (loan.outstandingCents > loan.principalCents) throw new Error("贷款余额不能超过本金");
  assertInteger(loan.dailyInterestBps, "贷款日利率", 0, 10_000);
  assertInteger(loan.minimumPaymentCents, "贷款最低还款", 1);
}

export function validateLoans(loans: ReadonlyArray<Readonly<LoanState>>): void {
  const ids = new Set<string>();
  for (const loan of loans) {
    validateLoan(loan);
    if (ids.has(loan.id)) throw new Error("贷款编号必须唯一");
    ids.add(loan.id);
  }
}

export function validateLoanRequest(request: Readonly<LoanRequest>, existing: ReadonlyArray<Readonly<LoanState>>): void {
  validateLoans(existing);
  validateId(request.id);
  assertInteger(request.amountCents, "贷款金额", 1);
  assertInteger(request.dailyInterestBps, "贷款日利率", 0, 10_000);
  assertInteger(request.termDays, "贷款期限", 1);
  if (existing.some(({ id }) => id === request.id)) throw new Error("贷款编号必须唯一");
}

export function createLoan(request: Readonly<LoanRequest>, existing: ReadonlyArray<Readonly<LoanState>>): LoanState {
  validateLoanRequest(request, existing);
  const minimumPaymentCents = safeNumber(
    (BigInt(request.amountCents) + BigInt(request.termDays) - 1n) / BigInt(request.termDays),
    "贷款最低还款",
  );
  return {
    id: request.id,
    principalCents: request.amountCents,
    outstandingCents: request.amountCents,
    dailyInterestBps: request.dailyInterestBps,
    minimumPaymentCents,
  };
}

export function projectLoanSettlement(loans: ReadonlyArray<Readonly<LoanState>>): {
  interestCents: number;
  loans: LoanState[];
} {
  validateLoans(loans);
  const projected = loans.map((loan) => ({ ...loan })).sort(compareIds);
  const interestCents = safeNumber(
    projected.reduce(
      (sum, loan) => sum + (BigInt(loan.outstandingCents) * BigInt(loan.dailyInterestBps)) / 10_000n,
      0n,
    ),
    "贷款利息",
  );
  return { interestCents, loans: projected };
}

export function applyLoanRepayment(
  loans: ReadonlyArray<Readonly<LoanState>>,
  loanId: string,
  amountCents: number,
): LoanState[] {
  validateLoans(loans);
  validateId(loanId);
  assertInteger(amountCents, "还款金额", 1);
  const loan = loans.find(({ id }) => id === loanId);
  if (!loan) throw new Error("贷款不存在");
  if (amountCents > loan.outstandingCents) throw new Error("还款金额不能超过贷款余额");
  return loans.flatMap((item): LoanState[] => {
    if (item.id !== loanId) return [{ ...item }];
    const outstandingCents = item.outstandingCents - amountCents;
    if (outstandingCents === 0) return [];
    return [{
      ...item,
      principalCents: item.principalCents - amountCents,
      outstandingCents,
    }];
  }).sort(compareIds);
}

export function coverCasualShortfall(
  cashCents: number,
  costCents: number,
  loans: ReadonlyArray<Readonly<LoanState>>,
  safetyLoanId: string,
): { borrowedCents: number; endingCashCents: number; loans: LoanState[] } {
  assertInteger(cashCents, "现金", 0);
  assertInteger(costCents, "成本", 0);
  validateLoans(loans);
  validateId(safetyLoanId);
  const borrowedCents = Math.max(0, costCents - cashCents);
  const endingCashCents = Math.max(0, cashCents - costCents);
  const existingIndex = loans.findIndex(({ id }) => id === safetyLoanId);
  if (borrowedCents === 0) {
    return { borrowedCents, endingCashCents, loans: loans.map((loan) => ({ ...loan })).sort(compareIds) };
  }
  const existing = existingIndex < 0 ? undefined : loans[existingIndex];
  const principalCents = safeNumber(BigInt(existing?.principalCents ?? 0) + BigInt(borrowedCents), "安全贷款本金");
  const outstandingCents = safeNumber(BigInt(existing?.outstandingCents ?? 0) + BigInt(borrowedCents), "安全贷款余额");
  const safetyLoan: LoanState = {
    id: safetyLoanId,
    principalCents,
    outstandingCents,
    dailyInterestBps: 10,
    minimumPaymentCents: Math.max(1, Math.trunc(outstandingCents / 100)),
  };
  const next = existingIndex < 0
    ? [...loans.map((loan) => ({ ...loan })), safetyLoan]
    : loans.map((loan, index) => index === existingIndex ? safetyLoan : { ...loan });
  return { borrowedCents, endingCashCents, loans: next.sort(compareIds) };
}

export interface OperationsFinanceInput {
  difficulty: Difficulty;
  cashCents: number;
  revenueCents: number;
  operatingCostCents: number;
  loans: ReadonlyArray<Readonly<LoanState>>;
  safetyLoanId?: string;
}

export interface OperationsFinanceProjection {
  interestCents: number;
  totalCostCents: number;
  netIncomeCents: number;
  cashShortfallCents: number;
  endingCashCents: number;
  loans: LoanState[];
}

export function projectOperationsFinance(input: Readonly<OperationsFinanceInput>): OperationsFinanceProjection {
  if (input.difficulty !== "casual" && input.difficulty !== "management") throw new Error("经营难度无效");
  assertInteger(input.cashCents, "现金", 0);
  assertInteger(input.revenueCents, "营业收入", 0);
  assertInteger(input.operatingCostCents, "经营成本", 0);
  const settlement = projectLoanSettlement(input.loans);
  const totalCostCents = safeNumber(BigInt(input.operatingCostCents) + BigInt(settlement.interestCents), "经营总成本");
  const netIncome = BigInt(input.revenueCents) - BigInt(totalCostCents);
  if (netIncome < -MAX_SAFE || netIncome > MAX_SAFE) throw new Error("净收益超出安全整数范围");
  const availableCash = safeNumber(BigInt(input.cashCents) + BigInt(input.revenueCents), "可用现金");
  const cashShortfallCents = Math.max(0, totalCostCents - availableCash);
  if (input.difficulty === "management" && cashShortfallCents > 0) {
    throw new Error("现金不足以完成经营结算");
  }
  const covered = input.difficulty === "casual"
    ? coverCasualShortfall(availableCash, totalCostCents, settlement.loans, input.safetyLoanId ?? "safety-loan:daily-settlement")
    : { borrowedCents: 0, endingCashCents: availableCash - totalCostCents, loans: settlement.loans };
  return {
    interestCents: settlement.interestCents,
    totalCostCents,
    netIncomeCents: Number(netIncome),
    cashShortfallCents,
    endingCashCents: covered.endingCashCents,
    loans: covered.loans,
  };
}
