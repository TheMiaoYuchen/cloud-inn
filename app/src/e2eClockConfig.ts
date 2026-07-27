export function e2eDayMilliseconds(enabled: boolean, stored: string | null): number | undefined {
  if (!enabled) return undefined;
  const value = Number(stored);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
