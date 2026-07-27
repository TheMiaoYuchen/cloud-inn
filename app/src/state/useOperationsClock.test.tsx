import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPERATIONS_DAY_INTERVAL_MS,
  useOperationsClock,
} from "./useOperationsClock";

describe("useOperationsClock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    [1, 60_000],
    [2, 30_000],
    [4, 15_000],
  ] as const)("advances speed %sx at its documented %sms real interval", async (speed, intervalMs) => {
    const advance = vi.fn(async () => undefined);
    const nowMs = vi.fn(() => 123_456);
    renderHook(() => useOperationsClock({ speed, advance, nowMs }));

    await act(async () => vi.advanceTimersByTimeAsync(intervalMs - 1));
    expect(advance).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(123_456);
    expect(nowMs).toHaveBeenCalledTimes(1);
  });

  it("documents the real-time speed mapping", () => {
    expect(OPERATIONS_DAY_INTERVAL_MS).toEqual({ 1: 60_000, 2: 30_000, 4: 15_000 });
  });

  it("does not schedule while paused", async () => {
    const advance = vi.fn(async () => undefined);
    renderHook(() => useOperationsClock({ speed: 0, advance, nowMs: () => 1 }));

    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));

    expect(advance).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the old interval on speed change and on unmount", async () => {
    const advance = vi.fn(async () => undefined);
    const { rerender, unmount } = renderHook(
      ({ speed }) => useOperationsClock({ speed, advance, nowMs: () => 1 }),
      { initialProps: { speed: 1 as 0 | 1 | 2 | 4 } },
    );

    rerender({ speed: 4 });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(advance).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(advance).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps or queues duplicate ticks while an advance is pending", async () => {
    let release!: () => void;
    const advance = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    renderHook(() => useOperationsClock({ speed: 4, advance, nowMs: () => 1 }));

    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(advance).toHaveBeenCalledTimes(1);

    await act(async () => release());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(advance).toHaveBeenCalledTimes(2);
  });
});
