import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from "react";
import { bedTypes, roomTypes, zoneChoices } from "./catalog";
import { loadFloorPlan, saveFloorPlan } from "./storage";
import type { Blueprint, FloorPlacement, FloorPlan } from "./types";

const FLOOR_AREA = 1200;
const GRID_COLUMNS = 30;
const GRID_ROWS = 20;
const CELL_AREA = FLOOR_AREA / (GRID_COLUMNS * GRID_ROWS);

const roleLabels = { arrival: "抵达", stay: "停留", restore: "恢复", gather: "聚集" } as const;

function footprint(areaSqm: number) {
  const cells = Math.max(1, Math.ceil(areaSqm / CELL_AREA));
  const width = Math.min(GRID_COLUMNS, Math.max(1, Math.ceil(Math.sqrt(cells * 1.35))));
  return { width, height: Math.min(GRID_ROWS, Math.max(1, Math.ceil(cells / width))) };
}

function overlaps(candidate: Pick<FloorPlacement, "x" | "y" | "width" | "height">, placement: FloorPlacement) {
  return candidate.x < placement.x + placement.width && candidate.x + candidate.width > placement.x && candidate.y < placement.y + placement.height && candidate.y + candidate.height > placement.y;
}

function clampPosition(x: number, y: number, width: number, height: number) {
  return { x: Math.max(0, Math.min(GRID_COLUMNS - width, x)), y: Math.max(0, Math.min(GRID_ROWS - height, y)) };
}

function isAvailable(candidate: Pick<FloorPlacement, "x" | "y" | "width" | "height">, placements: FloorPlacement[], ignoredId?: string) {
  return !placements.some((placement) => placement.id !== ignoredId && overlaps(candidate, placement));
}

function nameFor(blueprint: Blueprint) {
  if (blueprint.designKind === "zone") return blueprint.name || zoneChoices.find((item) => item.id === blueprint.zoneTypeId)?.name || "功能区域";
  return blueprint.name || roomTypes.find((item) => item.id === blueprint.roomTypeId)?.name || "客房";
}

type FloorPlannerProps = { blueprints: Blueprint[]; onOpenBlueprint: (blueprint: Blueprint) => void };

export function FloorPlanner({ blueprints, onOpenBlueprint }: FloorPlannerProps) {
  const [floorPlan, setFloorPlan] = useState<FloorPlan>({ id: "floor-01", placements: [], updatedAt: new Date().toISOString() });
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number; preview: { x: number; y: number } }>();
  const [notice, setNotice] = useState("从左侧蓝图库拖拽空间到楼层。每格约 2㎡。");
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadFloorPlan().then((stored) => { if (stored) setFloorPlan(stored); setReady(true); }).catch(() => { setNotice("楼层平面暂时无法保存。 "); setReady(true); });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => { void saveFloorPlan(floorPlan).catch(() => setNotice("保存楼层平面失败。")); }, 350);
    return () => window.clearTimeout(timer);
  }, [floorPlan, ready]);

  const usedArea = useMemo(() => floorPlan.placements.reduce((sum, placement) => sum + placement.areaSqm, 0), [floorPlan.placements]);
  const selected = floorPlan.placements.find((placement) => placement.id === selectedId);
  const selectedBlueprint = blueprints.find((blueprint) => blueprint.id === selected?.blueprintId);

  function updatePlacements(update: (placements: FloorPlacement[]) => FloorPlacement[]) {
    setFloorPlan((current) => ({ ...current, placements: update(current.placements), updatedAt: new Date().toISOString() }));
  }

  function dragBlueprint(event: DragEvent, blueprintId: string) {
    event.dataTransfer.setData("text/plain", `blueprint:${blueprintId}`);
    event.dataTransfer.effectAllowed = "copy";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const token = event.dataTransfer.getData("text/plain");
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(GRID_COLUMNS - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * GRID_COLUMNS)));
    const y = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(((event.clientY - bounds.top) / bounds.height) * GRID_ROWS)));
    if (token.startsWith("blueprint:")) {
      const blueprint = blueprints.find((item) => item.id === token.slice(10));
      if (!blueprint) return;
      if (usedArea + blueprint.areaSqm > FLOOR_AREA) { setNotice("剩余面积不足，无法加入这个空间。 "); return; }
      const dimensions = footprint(blueprint.areaSqm);
      const position = clampPosition(x - Math.floor(dimensions.width / 2), y - Math.floor(dimensions.height / 2), dimensions.width, dimensions.height);
      if (!isAvailable({ ...position, ...dimensions }, floorPlan.placements)) { setNotice("此处已被占用，请拖到空白网格。 "); return; }
      const placement: FloorPlacement = { id: crypto.randomUUID(), blueprintId: blueprint.id, ...position, ...dimensions, areaSqm: blueprint.areaSqm, journeyRole: blueprint.designKind === "zone" ? "gather" : "stay" };
      updatePlacements((items) => [...items, placement]);
      setSelectedId(placement.id);
      setNotice(`已放入「${nameFor(blueprint)}」。`);
      return;
    }
  }

  function startPlacementDrag(event: PointerEvent<HTMLButtonElement>, placement: FloorPlacement) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    const offsetX = ((event.clientX - target.left) / target.width) * placement.width;
    const offsetY = ((event.clientY - target.top) / target.height) * placement.height;
    setSelectedId(placement.id);
    setDragging({ id: placement.id, offsetX, offsetY, preview: { x: placement.x, y: placement.y } });
  }

  function updatePlacementDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragging || !boardRef.current) return;
    const moving = floorPlan.placements.find((item) => item.id === dragging.id);
    if (!moving) return;
    const board = boardRef.current.getBoundingClientRect();
    const rawX = Math.floor(((event.clientX - board.left) / board.width) * GRID_COLUMNS - dragging.offsetX);
    const rawY = Math.floor(((event.clientY - board.top) / board.height) * GRID_ROWS - dragging.offsetY);
    setDragging((current) => current ? { ...current, preview: clampPosition(rawX, rawY, moving.width, moving.height) } : current);
  }

  function finishPlacementDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragging) return;
    const moving = floorPlan.placements.find((item) => item.id === dragging.id);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (moving && isAvailable({ ...dragging.preview, width: moving.width, height: moving.height }, floorPlan.placements, moving.id)) {
      updatePlacements((items) => items.map((item) => item.id === moving.id ? { ...item, ...dragging.preview } : item));
      setNotice("空间位置已更新。 ");
    } else {
      setNotice("此处已被占用，空间保持在原位置。 ");
    }
    setDragging(undefined);
  }

  function rotateSelected() {
    if (!selected) return;
    const position = clampPosition(selected.x, selected.y, selected.height, selected.width);
    if (!isAvailable({ ...position, width: selected.height, height: selected.width }, floorPlan.placements, selected.id)) { setNotice("旋转后会与其他空间重叠。 "); return; }
    updatePlacements((items) => items.map((item) => item.id === selected.id ? { ...item, ...position, width: selected.height, height: selected.width } : item));
  }

  return <section className="floor-workspace" aria-label="楼层平面图">
    <div className="floor-heading"><div><p className="eyebrow">1200㎡ 酒店楼层</p><h2>楼层平面图</h2><p>把蓝图库中的空间拖拽到平面图；空间的面积来自设计阶段，可随时调整布局。</p></div><div className="floor-meter"><strong>{usedArea}</strong><span>/ {FLOOR_AREA} m² 已规划</span><i><b style={{ width: `${Math.min(100, usedArea / FLOOR_AREA * 100)}%` }} /></i></div></div>
    <div className="floor-layout">
      <aside className="floor-library"><div className="floor-library-heading"><strong>可放置空间</strong><span>{blueprints.length} 张蓝图</span></div>{blueprints.length ? blueprints.map((blueprint) => <article className="floor-source" draggable key={blueprint.id} onDragStart={(event) => dragBlueprint(event, blueprint.id)} onDoubleClick={() => onOpenBlueprint(blueprint)}><img src={blueprint.imageDataUrl} alt="" /><div><strong>{nameFor(blueprint)}</strong><span>{blueprint.areaSqm} m² · {blueprint.designKind === "zone" ? "功能区域" : bedTypes.find((item) => item.id === blueprint.bedTypeId)?.name}</span></div><b>拖入</b></article>) : <p className="floor-empty">蓝图库还没有可放置的空间。先完成一张客房或功能区域设计并保存。</p>}</aside>
      <div className="floor-board-wrap"><div ref={boardRef} className="floor-board" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onClick={() => setSelectedId(undefined)}><span className="floor-entrance">入口</span>{floorPlan.placements.map((placement) => { const blueprint = blueprints.find((item) => item.id === placement.blueprintId); if (!blueprint) return null; const preview = dragging?.id === placement.id ? dragging.preview : placement; const available = dragging?.id === placement.id && isAvailable({ ...preview, width: placement.width, height: placement.height }, floorPlan.placements, placement.id); return <button key={placement.id} type="button" className={`floor-space ${blueprint.designKind} ${selectedId === placement.id ? "selected" : ""} ${dragging?.id === placement.id ? "dragging" : ""} ${available === false ? "invalid" : ""}`} style={{ left: `${preview.x / GRID_COLUMNS * 100}%`, top: `${preview.y / GRID_ROWS * 100}%`, width: `${placement.width / GRID_COLUMNS * 100}%`, height: `${placement.height / GRID_ROWS * 100}%` }} onPointerDown={(event) => startPlacementDrag(event, placement)} onPointerMove={updatePlacementDrag} onPointerUp={finishPlacementDrag} onPointerCancel={() => setDragging(undefined)} onClick={(event) => { event.stopPropagation(); setSelectedId(placement.id); }}><strong>{nameFor(blueprint)}</strong><span>{placement.areaSqm}m² · {roleLabels[placement.journeyRole]}</span></button>; })}</div><p className="floor-notice" role="status">{notice}</p></div>
      <aside className="floor-inspector">{selected && selectedBlueprint ? <><p className="eyebrow">空间设定</p><h3>{nameFor(selectedBlueprint)}</h3><span>{selected.areaSqm} m² · {selectedBlueprint.designKind === "zone" ? "功能区域" : "客房"}</span><label>在旅程中的角色<select value={selected.journeyRole} onChange={(event) => updatePlacements((items) => items.map((item) => item.id === selected.id ? { ...item, journeyRole: event.target.value as FloorPlacement["journeyRole"] } : item))}>{Object.entries(roleLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><p className="inspector-hint">这个标签将用于后续模拟客流、噪音和满意度。</p><div><button type="button" className="secondary" onClick={rotateSelected}>旋转空间</button><button type="button" className="remove-space" onClick={() => { updatePlacements((items) => items.filter((item) => item.id !== selected.id)); setSelectedId(undefined); }}>移出楼层</button></div></> : <div className="inspector-empty"><span>◇</span><h3>选择一个空间</h3><p>点击平面图中的空间，设定它在住客旅程中的作用。</p></div>}</aside>
    </div>
  </section>;
}
