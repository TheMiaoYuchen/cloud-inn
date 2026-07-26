import { describe, expect, it } from "vitest";

import { prototypeConfig } from "../config/prototypeConfig";
import type { RoomBlueprint, RoomInstance } from "../game/state";
import { placeRoom, removeRoom } from "./planFloor";

const blueprint: RoomBlueprint = {
  id: "room-type-1",
  name: "云岫商务房",
  columns: 8,
  rows: 12,
  cells: [],
  metrics: {
    areaSquareMeters: 24,
    buildCostCents: 11_600_000,
    suggestedRateCents: 80_000,
    businessFitBps: 8_500,
  },
  visual: { status: "idle" },
};

describe("placeRoom", () => {
  it("places one room in each fixed floor slot in deterministic order", () => {
    const result = prototypeConfig.floorSlots.reduce(
      ({ rooms }, slot) => placeRoom(rooms, blueprint, slot.id),
      { rooms: [] as RoomInstance[], costCents: 0 },
    );

    expect(result.rooms).toHaveLength(4);
    expect(result.rooms.map(({ slotId }) => slotId)).toEqual(
      prototypeConfig.floorSlots.map(({ id }) => id),
    );
    expect(result.rooms).toEqual(
      prototypeConfig.floorSlots.map(({ id: slotId }) => ({
        id: `room-${slotId}`,
        slotId,
        roomBlueprintId: blueprint.id,
        committedBuildCostCents: blueprint.metrics.buildCostCents,
      })),
    );
    expect(result.costCents).toBe(blueprint.metrics.buildCostCents);
  });

  it("rejects an occupied slot", () => {
    const slotId = prototypeConfig.floorSlots[0].id;
    const { rooms } = placeRoom([], blueprint, slotId);

    expect(() => placeRoom(rooms, blueprint, slotId)).toThrow(
      "这个位置已有客房",
    );
  });

  it("rejects a candidate room id already used by another slot", () => {
    const targetSlotId = prototypeConfig.floorSlots[1].id;
    const conflictingRoom: RoomInstance = {
      id: `room-${targetSlotId}`,
      slotId: prototypeConfig.floorSlots[0].id,
      roomBlueprintId: blueprint.id,
      committedBuildCostCents: blueprint.metrics.buildCostCents,
    };
    const rooms = [conflictingRoom];
    const snapshot = structuredClone(rooms);

    expect(() => placeRoom(rooms, blueprint, targetSlotId)).toThrow(
      "客房数据存在重复编号",
    );
    expect(rooms).toEqual(snapshot);
  });

  it("rejects a slot outside the fixed build area before checking occupancy", () => {
    const invalidSlotRoom: RoomInstance = {
      id: "room-not-a-slot",
      slotId: "not-a-slot",
      roomBlueprintId: blueprint.id,
      committedBuildCostCents: blueprint.metrics.buildCostCents,
    };

    expect(() => placeRoom([invalidSlotRoom], blueprint, "not-a-slot")).toThrow(
      "这个位置不在可建区域内",
    );
  });

  it("returns a new array without changing the inputs", () => {
    const rooms: RoomInstance[] = [];
    const roomsSnapshot = structuredClone(rooms);
    const blueprintSnapshot = structuredClone(blueprint);

    const result = placeRoom(rooms, blueprint, prototypeConfig.floorSlots[0].id);

    expect(rooms).toEqual(roomsSnapshot);
    expect(blueprint).toEqual(blueprintSnapshot);
    expect(result.rooms).not.toBe(rooms);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects an unsafe committed build cost (%s)",
    (buildCostCents) => {
      const invalidBlueprint: RoomBlueprint = {
        ...blueprint,
        metrics: { ...blueprint.metrics, buildCostCents },
      };

      expect(() =>
        placeRoom(
          [],
          invalidBlueprint,
          prototypeConfig.floorSlots[0].id,
        ),
      ).toThrow("金额必须是非负整数分");
    },
  );
});

describe("removeRoom", () => {
  it("removes an existing room and refunds its committed build cost", () => {
    const slotId = prototypeConfig.floorSlots[0].id;
    const placed = placeRoom([], blueprint, slotId);

    expect(removeRoom(placed.rooms, `room-${slotId}`)).toEqual({
      rooms: [],
      refundCents: 11_600_000,
    });
  });

  it("rejects a room id that does not exist", () => {
    expect(() => removeRoom([], "room-missing")).toThrow(
      "找不到要移除的客房",
    );
  });

  it("rejects duplicate room ids before deleting or refunding", () => {
    const roomId = "room-duplicate";
    const rooms: RoomInstance[] = [
      {
        id: roomId,
        slotId: prototypeConfig.floorSlots[0].id,
        roomBlueprintId: blueprint.id,
        committedBuildCostCents: 11_600_000,
      },
      {
        id: roomId,
        slotId: prototypeConfig.floorSlots[1].id,
        roomBlueprintId: blueprint.id,
        committedBuildCostCents: 5_000_000,
      },
    ];
    const snapshot = structuredClone(rooms);

    expect(() => removeRoom(rooms, roomId)).toThrow(
      "客房数据存在重复编号",
    );
    expect(rooms).toEqual(snapshot);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects an unsafe committed refund (%s)",
    (committedBuildCostCents) => {
      const room: RoomInstance = {
        id: "room-invalid-refund",
        slotId: prototypeConfig.floorSlots[0].id,
        roomBlueprintId: blueprint.id,
        committedBuildCostCents,
      };
      const rooms = [room];
      const snapshot = structuredClone(rooms);

      expect(() => removeRoom(rooms, room.id)).toThrow(
        "金额必须是非负整数分",
      );
      expect(rooms).toEqual(snapshot);
    },
  );

  it("returns a new array without changing the input", () => {
    const slotId = prototypeConfig.floorSlots[0].id;
    const rooms = placeRoom([], blueprint, slotId).rooms;
    const snapshot = structuredClone(rooms);

    const result = removeRoom(rooms, `room-${slotId}`);

    expect(rooms).toEqual(snapshot);
    expect(result.rooms).not.toBe(rooms);
  });
});
