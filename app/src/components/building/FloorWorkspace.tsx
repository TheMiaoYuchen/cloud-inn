import { useMemo, useState } from "react";
import type { PublicSpaceBlueprint } from "../../domain/facilities/facilityTypes";
import type { FloorProjection } from "../../state/GameProvider";
import type { StableId } from "../../domain/building/buildingTypes";
import { projectFlowSnapshot } from "../../domain/flows/flowProjection";
import { HotelFlowCanvas } from "../../canvas/HotelFlowCanvas";
import { useGame } from "../../state/GameProvider";
import { floorUseLabel } from "./TowerOverview";

const FACILITY_LABELS: Record<string, string> = {
  "sky-lobby": "空中大堂",
  "all-day-dining": "全日餐厅",
  "chinese-restaurant": "中餐厅",
  bar: "酒吧",
  "executive-lounge": "行政酒廊",
  spa: "水疗中心",
  pool: "泳池",
  gym: "健身房",
  ballroom: "宴会厅",
  "meeting-room": "会议室",
  "garden-terrace": "花园露台",
  boutique: "精品店",
};

const ROOM_STATUS_LABELS = {
  available: "可售",
  occupied: "入住",
  renovating: "停业改造",
} as const;

function percentage(value: number, total: number): string {
  return `${(value / Math.max(1, total)) * 100}%`;
}

function centeredSquare(columns: number, rows: number, scale: number) {
  const side = Math.max(1, Math.floor(Math.min(columns, rows) * scale));
  return {
    left: percentage((columns - side) / 2, columns),
    top: percentage((rows - side) / 2, rows),
    width: percentage(side, columns),
    height: percentage(side, rows),
  };
}

export function FloorWorkspace({
  projection,
  publicSpaceBlueprints,
}: {
  projection: FloorProjection;
  publicSpaceBlueprints: ReadonlyMap<string, {
    blueprint: PublicSpaceBlueprint;
    localPlacementId: StableId;
  }>;
}) {
  const { state } = useGame();
  const { floor, template, rooms, facilities, roomStatusByOfferId, roomStatusTotals } = projection;
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const roomByPlacement = useMemo(
    () => new Map(rooms.map((room) => [room.localPlacementId, room])),
    [rooms],
  );
  const roomById = useMemo(
    () => new Map(rooms.map((room) => [room.id, room])),
    [rooms],
  );
  const selectedRoom = selectedRoomId
    ? roomById.get(selectedRoomId) ?? null
    : null;
  const facilityBlueprints = useMemo(
    () => facilities.flatMap((facility) => {
      const projection = publicSpaceBlueprints.get(facility.publicSpaceInstanceId);
      return projection ? [{ facility, ...projection }] : [];
    }),
    [facilities, publicSpaceBlueprints],
  );
  const publicSpaceSlotById = useMemo(
    () => new Map((template?.publicSpaceSlots ?? []).map((slot) => [slot.id, slot])),
    [template],
  );
  const totalRoomArea = rooms.reduce((sum, room) => sum + room.areaSquareMeters, 0);
  const coreStyle = template
    ? centeredSquare(template.columns, template.rows, 0.25)
    : undefined;
  const ringStyle = template
    ? centeredSquare(template.columns, template.rows, 0.5)
    : undefined;
  const flowSnapshot = useMemo(
    () => state ? projectFlowSnapshot(state, floor.id) : {
      day: 0,
      floorId: floor.id,
      width: 1,
      height: 1,
      events: [],
    },
    [floor.id, state],
  );

  return (
    <section
      className="floor-workspace"
      aria-label={`${floor.floorNumber}层平面工作区`}
      data-testid="floor-scene"
    >
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">{floor.floorNumber}F · {floorUseLabel(floor.use)}</p>
          <h2>{floor.floorNumber}层平面工作区</h2>
        </div>
        <p role="status"><span>本层 {rooms.length} 间客房</span> · {facilities.length} 项设施</p>
      </header>

      <div className="floor-workspace-layout">
        <div className="floor-plan-stage">
          <div
            className="true-scale-floor"
            aria-label={`${floor.floorNumber}层真实比例平面`}
            style={template ? {
              aspectRatio: `${template.columns} / ${template.rows}`,
              width: `min(100%, ${(760 * template.columns) / template.rows}px)`,
            } : undefined}
          >
            <HotelFlowCanvas snapshot={flowSnapshot} />
            <div className="ring-corridor-visual" style={ringStyle}><span>环形走廊</span></div>
            <div className="central-core" style={coreStyle}><span>中央核心筒</span><small>电梯 · 楼梯 · 后勤</small></div>
            {template?.roomPlacements.map((placement) => {
              const room = roomByPlacement.get(placement.id);
              if (!room) return null;
              const roomStatus = roomStatusByOfferId.get(room.id) ?? "available";
              const roomStatusLabel = ROOM_STATUS_LABELS[roomStatus];
              return (
                <button
                  key={room.id}
                  type="button"
                  data-testid="room-footprint"
                  className={`room-footprint is-${roomStatus}`}
                  aria-label={`客房 ${room.localPlacementId}，${room.areaSquareMeters}平方米，${roomStatusLabel}`}
                  title={roomStatusLabel}
                  aria-pressed={selectedRoomId === room.id}
                  onClick={() => setSelectedRoomId(room.id)}
                  style={{
                    left: percentage(placement.anchorX, template.columns),
                    top: percentage(placement.anchorY, template.rows),
                    width: percentage(placement.width, template.columns),
                    height: percentage(placement.height, template.rows),
                  }}
                >
                  <span>{room.areaSquareMeters}㎡</span>
                  <small>{roomStatusLabel}</small>
                </button>
              );
            })}
            {facilityBlueprints.map(({ facility, localPlacementId }) => {
              const slot = publicSpaceSlotById.get(localPlacementId);
              if (!template || slot?.anchorX === undefined || slot.anchorY === undefined ||
                  slot.width === undefined || slot.height === undefined) return null;
              return (
                <div
                  key={facility.id}
                  data-testid="space-footprint"
                  className="facility-footprint"
                  style={{
                    left: percentage(slot.anchorX, template.columns),
                    top: percentage(slot.anchorY, template.rows),
                    width: percentage(slot.width, template.columns),
                    height: percentage(slot.height, template.rows),
                  }}
                >
                  <span>{FACILITY_LABELS[facility.type] ?? facility.type}</span>
                  <small>{facility.status === "operating" ? "营业中" : facility.status === "closed" ? "已关闭" : "筹备中"}</small>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="floor-inspector" aria-label="楼层检查器">
          <h3>楼层数据</h3>
          <dl>
            <div><dt>用途</dt><dd>{floorUseLabel(floor.use)}</dd></div>
            <div><dt>客房</dt><dd>{rooms.length} 间</dd></div>
            <div><dt>客房面积</dt><dd>{totalRoomArea}㎡</dd></div>
            <div><dt>入住</dt><dd>入住 {roomStatusTotals.occupied} 间</dd></div>
            <div><dt>停业</dt><dd>停业改造 {roomStatusTotals.renovating} 间</dd></div>
            <div><dt>可售</dt><dd>可售 {roomStatusTotals.available} 间</dd></div>
            <div><dt>设施</dt><dd>{facilities.length} 项</dd></div>
            <div><dt>状态</dt><dd>{floor.purchased ? "已纳入酒店" : "尚未购买"}</dd></div>
          </dl>
          {selectedRoom ? (
            <div className="selected-room-card">
              <h3>已选客房</h3>
              <p>{selectedRoom.localPlacementId}</p>
              <strong>{selectedRoom.areaSquareMeters}㎡ · {ROOM_STATUS_LABELS[roomStatusByOfferId.get(selectedRoom.id) ?? "available"]}</strong>
            </div>
          ) : <p className="muted">选择平面中的客房查看详情。</p>}
        </aside>
      </div>
    </section>
  );
}
