import type { FloorProjection } from "../../state/GameProvider";

const FLOOR_USE_LABELS = {
  entrance: "酒店入口",
  "sky-lobby": "空中大堂",
  guest: "客房",
  facility: "设施",
  service: "后勤服务",
} as const;

export function floorUseLabel(use: keyof typeof FLOOR_USE_LABELS): string {
  return FLOOR_USE_LABELS[use];
}

export function TowerOverview({
  floors,
  selectedFloorId,
  onSelectFloor,
  collapsed,
  onToggle,
}: {
  floors: readonly FloorProjection[];
  selectedFloorId?: string;
  onSelectFloor: (floorId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <aside className={`tower-rail${collapsed ? " is-collapsed" : ""}`}>
      <button
        className="tower-rail-toggle"
        type="button"
        aria-expanded={!collapsed}
        aria-controls="hotel-floor-list"
        onClick={onToggle}
      >
        {collapsed ? "展开楼层导航" : "收起楼层导航"}
      </button>
      <section aria-label="酒店垂直楼层" id="hotel-floor-list">
        {!collapsed && <h2>垂直酒店</h2>}
        <div className="tower-stack">
          {floors.map(({ floor, rooms, facilities, open }) => {
            const use = floorUseLabel(floor.use);
            const status = floor.purchased ? "已购" : "未购";
            const operation = open ? "开放" : "关闭";
            const ariaLabel = `选择${floor.floorNumber}层，${use}，${status}，${rooms.length}间客房，${facilities.length}项设施，${operation}`;
            return (
              <button
                key={floor.id}
                type="button"
                className="tower-floor"
                aria-label={ariaLabel}
                aria-pressed={floor.id === selectedFloorId}
                onClick={() => onSelectFloor(floor.id)}
              >
                <strong>{floor.floorNumber}F</strong>
                {!collapsed && (
                  <span>
                    <b>{use}</b>
                    <small>{rooms.length} 间客房 · {facilities.length} 项设施</small>
                    <small>{status} · {operation}</small>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
    </aside>
  );
}
