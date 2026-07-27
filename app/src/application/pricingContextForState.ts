import type { GameState } from "../domain/game/state";
import {
  seasonForGameDay,
  type PricingContext,
} from "../domain/operations/pricing";

const clampBps = (value: number): number =>
  Math.max(0, Math.min(10_000, Math.trunc(value)));

export function pricingContextForState(
  state: Readonly<GameState>,
): PricingContext {
  const recent = state.operations?.dailyReports.slice(-7) ?? [];
  const availableRooms = recent.reduce(
    (total, report) => total + (report.availableRooms ?? 0),
    0,
  );
  const soldRooms = recent.reduce(
    (total, report) => total + (report.soldRooms ?? 0),
    0,
  );
  const totalDemand = recent.reduce(
    (total, report) =>
      total + report.segments.reduce((dayTotal, segment) => dayTotal + segment.demand, 0),
    0,
  );
  const latest = recent[recent.length - 1];
  const latestAvailableRooms = latest?.availableRooms ?? 0;
  const demandCapacity = state.floor.rooms.length * recent.length;

  return {
    season: seasonForGameDay(state.currentDay),
    trailingSevenDayOccupancyBps: availableRooms === 0
      ? 5_000
      : clampBps((soldRooms * 10_000) / availableRooms),
    segmentDemandBps: demandCapacity === 0
      ? 5_000
      : clampBps((totalDemand * 10_000) / demandCapacity),
    reputationBps: clampBps(state.operations?.reputationBps ?? 5_000),
    remainingInventoryBps: latestAvailableRooms === 0
      ? 5_000
      : clampBps(
          ((latestAvailableRooms - (latest?.soldRooms ?? 0)) * 10_000)
            / latestAvailableRooms,
        ),
  };
}
