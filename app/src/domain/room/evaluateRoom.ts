import { prototypeConfig } from "../config/prototypeConfig";
import { assertSafeMoney } from "../primitives";
import type { Cell, RoomMetrics } from "../game/state";
import { validateRoomCells } from "./grid";

export function evaluateRoom(
  cells: Cell[],
  columns: number,
  rows: number,
): RoomMetrics {
  const validation = validateRoomCells(cells, columns, rows);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  const areaSquareMeters = validation.areaSquareMeters;
  const buildCostCents = assertSafeMoney(
    prototypeConfig.buildBaseCents +
      prototypeConfig.buildPerSquareMeterCents * areaSquareMeters,
  );
  const suggestedRateCents = assertSafeMoney(
    prototypeConfig.suggestedRateBaseCents +
      prototypeConfig.suggestedRatePerSquareMeterCents * areaSquareMeters,
  );
  const businessFitBps = Math.max(
    0,
    Math.min(
      10_000,
      prototypeConfig.businessFitBaseBps -
        Math.abs(
          prototypeConfig.businessFitIdealAreaSquareMeters - areaSquareMeters,
        ) * prototypeConfig.businessFitPenaltyPerSquareMeterBps,
    ),
  );

  return {
    areaSquareMeters,
    buildCostCents,
    suggestedRateCents,
    businessFitBps,
  };
}
