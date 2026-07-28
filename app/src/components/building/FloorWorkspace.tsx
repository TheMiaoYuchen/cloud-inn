import { useMemo, useState } from "react";
import type { PublicSpaceBlueprint } from "../../domain/facilities/facilityTypes";
import type { FloorProjection } from "../../state/GameProvider";
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

function percentage(value: number, total: number): string {
  return `${(value / Math.max(1, total)) * 100}%`;
}

export function FloorWorkspace({
  projection,
  publicSpaceBlueprints,
}: {
  projection: FloorProjection;
  publicSpaceBlueprints: ReadonlyMap<string, PublicSpaceBlueprint>;
}) {
  const { floor, template, rooms, facilities } = projection;
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
      const blueprint = publicSpaceBlueprints.get(facility.publicSpaceInstanceId);
      return blueprint ? [{ facility, blueprint }] : [];
    }),
    [facilities, publicSpaceBlueprints],
  );
  const totalRoomArea = rooms.reduce((sum, room) => sum + room.areaSquareMeters, 0);

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
          >
            <div className="ring-corridor-visual"><span>环形走廊</span></div>
            <div className="central-core"><span>中央核心筒</span><small>电梯 · 楼梯 · 后勤</small></div>
            {template?.roomPlacements.map((placement) => {
              const room = roomByPlacement.get(placement.id);
              if (!room) return null;
              return (
                <button
                  key={room.id}
                  type="button"
                  data-testid="room-footprint"
                  className="room-footprint"
                  aria-label={`客房 ${room.localPlacementId}，${room.areaSquareMeters}平方米，可售`}
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
                  <small>可售</small>
                </button>
              );
            })}
            {facilityBlueprints.map(({ facility, blueprint }, index) => (
              <div
                key={facility.id}
                data-testid="space-footprint"
                className="facility-footprint"
                style={{
                  left: `${4 + (index % 3) * 32}%`,
                  bottom: `${4 + Math.floor(index / 3) * 35}%`,
                  width: percentage(blueprint.columns, template?.columns ?? blueprint.columns),
                  height: percentage(blueprint.rows, template?.rows ?? blueprint.rows),
                }}
              >
                <span>{FACILITY_LABELS[facility.type] ?? facility.type}</span>
                <small>{facility.status === "operating" ? "营业中" : facility.status === "closed" ? "已关闭" : "筹备中"}</small>
              </div>
            ))}
          </div>
        </div>

        <aside className="floor-inspector" aria-label="楼层检查器">
          <h3>楼层数据</h3>
          <dl>
            <div><dt>用途</dt><dd>{floorUseLabel(floor.use)}</dd></div>
            <div><dt>客房</dt><dd>{rooms.length} 间</dd></div>
            <div><dt>客房面积</dt><dd>{totalRoomArea}㎡</dd></div>
            <div><dt>设施</dt><dd>{facilities.length} 项</dd></div>
            <div><dt>状态</dt><dd>{floor.purchased ? "已纳入酒店" : "尚未购买"}</dd></div>
          </dl>
          {selectedRoom ? (
            <div className="selected-room-card">
              <h3>已选客房</h3>
              <p>{selectedRoom.localPlacementId}</p>
              <strong>{selectedRoom.areaSquareMeters}㎡ · 可售</strong>
            </div>
          ) : <p className="muted">选择平面中的客房查看详情。</p>}
        </aside>
      </div>
    </section>
  );
}
