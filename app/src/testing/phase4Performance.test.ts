import { describe, expect, it } from "vitest";
import { projectHotelInventory } from "../domain/building/hotelInventory";
import { projectFlowSnapshot } from "../domain/flows/flowProjection";
import { createApprovedOperations } from "../domain/operations/operationsFixtures";
import { settleHotelDay } from "../domain/operations/settleHotelDay";
import { LocalStorageSavePort } from "../infrastructure/browser/LocalStorageSavePort";
import { createPhase4AcceptanceState } from "./phase4Fixtures";

function performanceState() {
  const state = createPhase4AcceptanceState("phase4-performance");
  state.revision = 1;
  state.phase = "open";
  state.operations = createApprovedOperations();
  return state;
}

function projectedPerformanceState() {
  const state = performanceState();
  const settled = settleHotelDay({
    day: 1,
    seed: state.saveId,
    cashCents: state.cashCents,
    operations: state.operations!,
    offers: projectHotelInventory(state).rooms,
    phase4: state.phase4!,
  });
  return {
    ...state,
    currentDay: 1 as typeof state.currentDay,
    cashCents: settled.cashCents,
    operations: settled.operations,
    phase4: settled.phase4,
  };
}

export interface Phase4PerformanceMeasurements {
  warmOneDayMs: number;
  thirtyDaysMs: number;
  projectionMs: number;
  spriteCount: number;
  saveMs: number;
  loadMs: number;
}

export function measureWarmPhase4Replay(days: number): number {
  let state = performanceState();
  const offers = projectHotelInventory(state).rooms;
  const started = performance.now();
  for (let day = 1; day <= days; day += 1) {
    const settled = settleHotelDay({
      day, seed: state.saveId, cashCents: state.cashCents,
      operations: state.operations!, offers, phase4: state.phase4!,
    });
    state = {
      ...state, currentDay: day, cashCents: settled.cashCents,
      operations: settled.operations, phase4: settled.phase4,
    };
  }
  return performance.now() - started;
}

export async function measurePhase4Performance(): Promise<Phase4PerformanceMeasurements> {
  measureWarmPhase4Replay(1);
  const warmOneDayMs = measureWarmPhase4Replay(1);
  const thirtyDaysMs = measureWarmPhase4Replay(30);
  const state = projectedPerformanceState();
  const floorId = state.phase4!.floors.find(({ rooms }) => rooms.length > 0)!.id;
  const projectionStarted = performance.now();
  const snapshot = projectFlowSnapshot(state, floorId);
  const projectionMs = performance.now() - projectionStarted;
  window.localStorage.clear();
  const locks = { request: async (_name: string, work: LockGrantedCallback) =>
    work({ name: _name, mode: "exclusive" }) } as LockManager;
  const port = new LocalStorageSavePort(locks);
  const saveStarted = performance.now();
  await port.commit(0, state);
  const saveMs = performance.now() - saveStarted;
  const loadStarted = performance.now();
  await port.load(state.saveId);
  const loadMs = performance.now() - loadStarted;
  return { warmOneDayMs, thirtyDaysMs, projectionMs, spriteCount: snapshot.events.length, saveMs, loadMs };
}

describe("Phase 4 performance gates", () => {
  const reportRequested = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.PHASE4_PERF_REPORT === "1";
  if (reportRequested) {
    it("reports Phase 4 performance measurements", async () => {
      console.log(`PHASE4_PERF ${JSON.stringify(await measurePhase4Performance())}`);
    });
  }

  it("settles one warm day under 100ms and thirty days under two seconds", () => {
    measureWarmPhase4Replay(1);
    expect(measureWarmPhase4Replay(1)).toBeLessThan(100);
    expect(measureWarmPhase4Replay(30)).toBeLessThan(2_000);
  });

  it("projects the selected maximum floor under 100ms with at most 150 sprites", () => {
    const state = projectedPerformanceState();
    const floorId = state.phase4!.floors.find(({ rooms }) => rooms.length > 0)!.id;
    const started = performance.now();
    const snapshot = projectFlowSnapshot(state, floorId);

    expect(performance.now() - started).toBeLessThan(100);
    expect(snapshot.events.length).toBeGreaterThan(0);
    expect(snapshot.events.length).toBeLessThanOrEqual(150);
  });

  it("saves and loads the maximum browser fixture under one second each", async () => {
    window.localStorage.clear();
    const locks = { request: async (_name: string, work: LockGrantedCallback) =>
      work({ name: _name, mode: "exclusive" }) } as LockManager;
    const port = new LocalStorageSavePort(locks);
    const state = performanceState();
    const saveStarted = performance.now();
    await port.commit(0, state);
    const saveMs = performance.now() - saveStarted;
    const loadStarted = performance.now();
    expect(await port.load(state.saveId)).toEqual(state);
    const loadMs = performance.now() - loadStarted;

    expect(saveMs).toBeLessThan(1_000);
    expect(loadMs).toBeLessThan(1_000);
  });
});
