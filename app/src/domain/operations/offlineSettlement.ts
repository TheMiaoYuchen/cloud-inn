export const MAX_OFFLINE_DAYS = 7;

export function offlineDaysForElapsed(
  elapsedMs: number,
  millisecondsPerGameDay: number,
): number {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new Error("离线时长必须是非负安全整数");
  }
  if (!Number.isSafeInteger(millisecondsPerGameDay) || millisecondsPerGameDay <= 0) {
    throw new Error("每营业日毫秒数必须是正安全整数");
  }
  return Math.min(MAX_OFFLINE_DAYS, Math.floor(elapsedMs / millisecondsPerGameDay));
}
