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

  const roomId = `room-${slotId}`;
  if (rooms.some((room) => room.id === roomId)) {
    throw new Error("客房数据存在重复编号");
  }

  const costCents = assertSafeMoney(blueprint.metrics.buildCostCents);
  const room: RoomInstance = {
    id: roomId,
    slotId,
    roomBlueprintId: blueprint.id,
    committedBuildCostCents: costCents,
  };

  return { rooms: [...rooms, room], costCents };
}

export function removeRoom(rooms: RoomInstance[], roomId: string) {
  const matchingRooms = rooms.filter(({ id }) => id === roomId);

  if (matchingRooms.length === 0) {
    throw new Error("找不到要移除的客房");
  }

  if (matchingRooms.length > 1) {
    throw new Error("客房数据存在重复编号");
  }

  const [room] = matchingRooms;
  const refundCents = assertSafeMoney(room.committedBuildCostCents);
  return {
    rooms: rooms.filter(({ id }) => id !== roomId),
    refundCents,
  };
}
