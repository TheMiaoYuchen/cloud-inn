import { useEffect, useRef } from "react";

import type { OperationsState } from "../domain/operations/operationsTypes";

export const OPERATIONS_DAY_INTERVAL_MS = Object.freeze({
  1: 60_000,
  2: 30_000,
  4: 15_000,
} as const);

export interface OperationsClockOptions {
  speed: OperationsState["timeSpeed"];
  advance: (nowMs: number) => Promise<unknown>;
  nowMs?: () => number;
  onError?: (error: unknown) => void;
  millisecondsPerGameDay?: number;
}

export function useOperationsClock({
  speed,
  advance,
  nowMs = Date.now,
  onError,
  millisecondsPerGameDay,
}: OperationsClockOptions): void {
  const advanceRef = useRef(advance);
  const nowRef = useRef(nowMs);
  const errorRef = useRef(onError);
  const inFlightRef = useRef(false);
  advanceRef.current = advance;
  nowRef.current = nowMs;
  errorRef.current = onError;

  useEffect(() => {
    if (speed === 0) return;
    let alive = true;
    const timer = window.setInterval(() => {
      if (!alive || inFlightRef.current) return;
      inFlightRef.current = true;
      Promise.resolve()
        .then(() => advanceRef.current(nowRef.current()))
        .catch((error) => errorRef.current?.(error))
        .finally(() => { inFlightRef.current = false; });
    }, millisecondsPerGameDay ? millisecondsPerGameDay / speed : OPERATIONS_DAY_INTERVAL_MS[speed]);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [speed, millisecondsPerGameDay]);
}
