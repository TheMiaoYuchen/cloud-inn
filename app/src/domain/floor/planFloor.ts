import { prototypeConfig } from "../config/prototypeConfig";
import type { RoomBlueprint, RoomInstance } from "../game/state";
import { assertSafeMoney } from "../primitives";

export function placeRoom(
  rooms: RoomInstance[],
  blueprint: RoomBlueprint,
  slotId: string,
) {
  if (!prototypeConfig.floorSlots.some((slot) => slot.id === slotId)) {
    throw new Error("这个位置不在可建区域内");
  }

  if (rooms.some((room) => room.slotId === slotId)) {
    throw new Error("这个位置已有客房");
  }

  const costCents = assertSafeMoney(blueprint.metrics.buildCostCents);
  const room: RoomInstance = {
    id: `room-${slotId}`,
    slotId,
    roomBlueprintId: blueprint.id,
    committedBuildCostCents: costCents,
  };

  return { rooms: [...rooms, room], costCents };
}

export function removeRoom(rooms: RoomInstance[], roomId: string) {
  const room = rooms.find(({ id }) => id === roomId);

  if (!room) {
    throw new Error("找不到要移除的客房");
  }

  return {
    rooms: rooms.filter(({ id }) => id !== roomId),
    refundCents: room.committedBuildCostCents,
  };
}
