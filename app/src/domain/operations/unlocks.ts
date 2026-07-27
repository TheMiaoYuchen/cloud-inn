import type { OperationsState } from "./operationsTypes";

export interface ReputationUnlock {
  key: string;
  reputationBps: number;
}

export const REPUTATION_UNLOCKS: ReadonlyArray<Readonly<ReputationUnlock>> = [
  { key: "operations:pricing-automation", reputationBps: 6_000 },
  { key: "operations:premium-segments", reputationBps: 7_500 },
  { key: "operations:signature-service", reputationBps: 9_000 },
];

function validateBps(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${label}必须是 0 到 10000 的安全整数`);
  }
}

export function validateReputationUnlockCatalog(
  catalog: ReadonlyArray<Readonly<ReputationUnlock>>,
): void {
  const keys = new Set<string>();
  let previousThreshold = -1;
  for (const unlock of catalog) {
    if (unlock.key.length === 0 || unlock.key.trim() !== unlock.key) throw new Error("解锁内容编号无效");
    if (keys.has(unlock.key)) throw new Error("解锁内容编号必须唯一");
    validateBps(unlock.reputationBps, "解锁声誉阈值");
    if (unlock.reputationBps < previousThreshold) throw new Error("解锁声誉阈值必须稳定递增");
    keys.add(unlock.key);
    previousThreshold = unlock.reputationBps;
  }
}

export function projectReputationUnlocks(
  operations: Readonly<OperationsState>,
  newReputationBps: number,
): Pick<OperationsState, "maximumReputationBps" | "unlockedContent"> {
  validateReputationUnlockCatalog(REPUTATION_UNLOCKS);
  validateBps(operations.reputationBps, "当前声誉");
  validateBps(operations.maximumReputationBps, "最高声誉");
  if (operations.maximumReputationBps < operations.reputationBps) throw new Error("最高声誉不能低于当前声誉");
  validateBps(newReputationBps, "新声誉");
  for (const key of operations.unlockedContent) {
    if (key.length === 0 || key.trim() !== key) throw new Error("解锁内容编号无效");
  }
  const maximumReputationBps = Math.max(
    operations.maximumReputationBps,
    operations.reputationBps,
    newReputationBps,
  );
  const unlockedContent = [...operations.unlockedContent];
  const known = new Set(unlockedContent);
  for (const unlock of REPUTATION_UNLOCKS) {
    if (unlock.reputationBps <= maximumReputationBps && !known.has(unlock.key)) {
      known.add(unlock.key);
      unlockedContent.push(unlock.key);
    }
  }
  return { maximumReputationBps, unlockedContent };
}
