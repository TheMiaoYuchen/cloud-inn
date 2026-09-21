import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { bedTypes, roomTypes, zoneChoices } from "./catalog";
import { loadFloorPlan, saveFloorPlan } from "./storage";
import type { Blueprint, FloorPlacement, FloorPlan, FloorPoint } from "./types";

const FLOOR_AREA = 1200;
const GRID_COLUMNS = 30;
const GRID_ROWS = 20;
const CELL_AREA = FLOOR_AREA / (GRID_COLUMNS * GRID_ROWS);
const roleLabels = { arrival: "抵达", stay: "停留", restore: "恢复", gather: "聚集" } as const;

type LegacyPlacement = Partial<FloorPlacement> & { x?: number; y?: number; width?: number; height?: number };

function nameFor(blueprint: Blueprint) {
  if (blueprint.designKind === "zone") return blueprint.name || zoneChoices.find((item) => item.id === blueprint.zoneTypeId)?.name || "功能区域";
  return blueprint.name || roomTypes.find((item) => item.id === blueprint.roomTypeId)?.name || "客房";
}

function clampPoint(point: FloorPoint): FloorPoint {
  return { x: Math.max(0, Math.min(GRID_COLUMNS, point.x)), y: Math.max(0, Math.min(GRID_ROWS, point.y)) };
}

function polygonArea(points: FloorPoint[]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

function allocatedArea(points: FloorPoint[]) {
  return Math.round(polygonArea(points) * CELL_AREA);
}

function pointInPolygon(point: FloorPoint, polygon: FloorPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index];
    const before = polygon[previous];
    const crosses = (current.y > point.y) !== (before.y > point.y) && point.x < (before.x - current.x) * (point.y - current.y) / (before.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function coveredCells(polygon: FloorPoint[]) {
  const cells = new Set<string>();
  for (let x = 0; x < GRID_COLUMNS; x += 1) for (let y = 0; y < GRID_ROWS; y += 1) if (pointInPolygon({ x: x + .5, y: y + .5 }, polygon)) cells.add(`${x}:${y}`);
  return cells;
}

function overlaps(polygon: FloorPoint[], placements: FloorPlacement[]) {
  const cells = coveredCells(polygon);
  return placements.some((placement) => [...coveredCells(placement.shape)].some((cell) => cells.has(cell)));
}

function simplify(points: FloorPoint[]) {
  return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

function normaliseFloorPlan(plan: FloorPlan): FloorPlan {
  return {
    ...plan,
    placements: (plan.placements as LegacyPlacement[]).flatMap((placement) => {
      const shape = Array.isArray(placement.shape) && placement.shape.length >= 3
        ? placement.shape.map(clampPoint)
        : (() => {
          const x = placement.x ?? 0; const y = placement.y ?? 0; const width = placement.width ?? 1; const height = placement.height ?? 1;
          return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }].map(clampPoint);
        })();
      if (!placement.id || !placement.blueprintId || polygonArea(shape) === 0) return [];
      return [{ id: placement.id, blueprintId: placement.blueprintId, shape, areaSqm: placement.areaSqm ?? allocatedArea(shape), allocatedAreaSqm: placement.allocatedAreaSqm ?? allocatedArea(shape), journeyRole: placement.journeyRole ?? "stay" }];
    }),
  };
}

function pointsAttribute(points: FloorPoint[]) { return points.map((point) => `${point.x},${point.y}`).join(" "); }
function pointFromEvent(event: PointerEvent<HTMLDivElement>, board: HTMLDivElement) {
  const bounds = board.getBoundingClientRect();
  return clampPoint({ x: Math.round(((event.clientX - bounds.left) / bounds.width) * GRID_COLUMNS), y: Math.round(((event.clientY - bounds.top) / bounds.height) * GRID_ROWS) });
}

type FloorPlannerProps = { blueprints: Blueprint[]; onOpenBlueprint: (blueprint: Blueprint) => void };

export function FloorPlanner({ blueprints, onOpenBlueprint }: FloorPlannerProps) {
  const [floorPlan, setFloorPlan] = useState<FloorPlan>({ id: "floor-01", placements: [], updatedAt: new Date().toISOString() });
  const [ready, setReady] = useState(false);
  const [armedBlueprintId, setArmedBlueprintId] = useState<string>();
  const [drawing, setDrawing] = useState<FloorPoint[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState("先在左侧选择一个蓝图，再在地图空白处按住并圈出它的形状。每格约 2㎡。");
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadFloorPlan().then((stored) => { if (stored) setFloorPlan(normaliseFloorPlan(stored)); setReady(true); }).catch(() => { setNotice("楼层平面暂时无法保存。 "); setReady(true); });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => { void saveFloorPlan(floorPlan).catch(() => setNotice("保存楼层平面失败。")); }, 350);
    return () => window.clearTimeout(timer);
  }, [floorPlan, ready]);

  const usedArea = useMemo(() => floorPlan.placements.reduce((sum, placement) => sum + placement.allocatedAreaSqm, 0), [floorPlan.placements]);
  const armedBlueprint = blueprints.find((blueprint) => blueprint.id === armedBlueprintId);
  const selected = floorPlan.placements.find((placement) => placement.id === selectedId);
  const selectedBlueprint = blueprints.find((blueprint) => blueprint.id === selected?.blueprintId);
  const previewArea = drawing && drawing.length >= 3 ? allocatedArea(drawing) : 0;
  const previewOverlap = Boolean(drawing && drawing.length >= 3 && overlaps(drawing, floorPlan.placements));

  function updatePlacements(update: (placements: FloorPlacement[]) => FloorPlacement[]) {
    setFloorPlan((current) => ({ ...current, placements: update(current.placements), updatedAt: new Date().toISOString() }));
  }

  function armBlueprint(blueprint: Blueprint) {
    setArmedBlueprintId(blueprint.id);
    setSelectedId(undefined);
    setNotice(`已选择「${nameFor(blueprint)}」：需要至少 ${blueprint.areaSqm}㎡。请在地图上圈地。`);
  }

  function startDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!armedBlueprint || !boardRef.current || event.button !== 0) return;
    if ((event.target as Element).closest(".floor-shape")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const first = pointFromEvent(event, boardRef.current);
    setDrawing([first]);
  }

  function continueDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || !boardRef.current) return;
    const point = pointFromEvent(event, boardRef.current);
    setDrawing((current) => current ? simplify([...current, point]) : current);
  }

  function finishDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || !armedBlueprint || !boardRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const shape = simplify([...drawing, pointFromEvent(event, boardRef.current)]);
    const areaSqm = allocatedArea(shape);
    if (shape.length < 3 || polygonArea(shape) < 1) { setNotice("请圈出一个有面积的区域。 "); setDrawing(undefined); return; }
    if (areaSqm < armedBlueprint.areaSqm) { setNotice(`区域为 ${areaSqm}㎡，小于「${nameFor(armedBlueprint)}」所需的 ${armedBlueprint.areaSqm}㎡。`); setDrawing(undefined); return; }
    if (usedArea + areaSqm > FLOOR_AREA) { setNotice(`区域为 ${areaSqm}㎡，楼层剩余面积不足。`); setDrawing(undefined); return; }
    if (overlaps(shape, floorPlan.placements)) { setNotice("区域与已部署空间重叠，请换一块空白区域。 "); setDrawing(undefined); return; }
    const placement: FloorPlacement = { id: crypto.randomUUID(), blueprintId: armedBlueprint.id, shape, areaSqm: armedBlueprint.areaSqm, allocatedAreaSqm: areaSqm, journeyRole: armedBlueprint.designKind === "zone" ? "gather" : "stay" };
    updatePlacements((items) => [...items, placement]);
    setSelectedId(placement.id);
    setArmedBlueprintId(undefined);
    setDrawing(undefined);
    setNotice(`已部署「${nameFor(armedBlueprint)}」，占用 ${areaSqm}㎡。`);
  }

  return <section className="floor-workspace" aria-label="楼层平面图">
    <div className="floor-heading"><div><p className="eyebrow">1200㎡ 酒店楼层</p><h2>楼层平面图</h2><p>选择一个已设计空间，在空白地图上徒手圈出它的形状。圈定面积达到蓝图所需面积后，即可完成部署。</p></div><div className="floor-meter"><strong>{usedArea}</strong><span>/ {FLOOR_AREA} m² 已规划</span><i><b style={{ width: `${Math.min(100, usedArea / FLOOR_AREA * 100)}%` }} /></i></div></div>
    <div className="floor-layout">
      <aside className="floor-library"><div className="floor-library-heading"><strong>待部署空间</strong><span>{blueprints.length} 张蓝图</span></div>{blueprints.length ? blueprints.map((blueprint) => <button type="button" className={`floor-source ${armedBlueprintId === blueprint.id ? "armed" : ""}`} key={blueprint.id} onClick={() => armBlueprint(blueprint)} onDoubleClick={() => onOpenBlueprint(blueprint)}><img src={blueprint.imageDataUrl} alt="" /><div><strong>{nameFor(blueprint)}</strong><span>{blueprint.areaSqm} m² · {blueprint.designKind === "zone" ? "功能区域" : bedTypes.find((item) => item.id === blueprint.bedTypeId)?.name}</span></div><b>{armedBlueprintId === blueprint.id ? "圈地中" : "选择"}</b></button>) : <p className="floor-empty">蓝图库还没有可部署的空间。先完成一张客房或功能区域设计并保存。</p>}</aside>
      <div className="floor-board-wrap"><div ref={boardRef} className={`floor-board ${armedBlueprint ? "drawing-enabled" : ""}`} onPointerDown={startDrawing} onPointerMove={continueDrawing} onPointerUp={finishDrawing} onPointerCancel={() => setDrawing(undefined)} onClick={() => !drawing && setSelectedId(undefined)}><span className="floor-entrance">入口</span><svg className="floor-shapes" viewBox={`0 0 ${GRID_COLUMNS} ${GRID_ROWS}`} preserveAspectRatio="none" aria-label="已部署空间">{floorPlan.placements.map((placement) => { const blueprint = blueprints.find((item) => item.id === placement.blueprintId); if (!blueprint) return null; return <g key={placement.id} className={`floor-shape ${blueprint.designKind} ${selectedId === placement.id ? "selected" : ""}`} onPointerDown={(event) => { event.stopPropagation(); setSelectedId(placement.id); }} onClick={(event) => event.stopPropagation()}><polygon points={pointsAttribute(placement.shape)} /><text x={placement.shape.reduce((sum, point) => sum + point.x, 0) / placement.shape.length} y={placement.shape.reduce((sum, point) => sum + point.y, 0) / placement.shape.length - .35}>{nameFor(blueprint)}</text><text className="floor-shape-meta" x={placement.shape.reduce((sum, point) => sum + point.x, 0) / placement.shape.length} y={placement.shape.reduce((sum, point) => sum + point.y, 0) / placement.shape.length + .45}>{placement.allocatedAreaSqm}m² · {roleLabels[placement.journeyRole]}</text></g>; })}{drawing && drawing.length >= 2 && <polygon className={`floor-drawing ${previewOverlap || previewArea > FLOOR_AREA - usedArea || previewArea < (armedBlueprint?.areaSqm ?? 0) ? "invalid" : ""}`} points={pointsAttribute(drawing)} />}</svg></div><p className="floor-notice" role="status">{drawing && armedBlueprint ? `正在圈地：${previewArea}㎡ / 至少 ${armedBlueprint.areaSqm}㎡` : notice}</p></div>
      <aside className="floor-inspector">{selected && selectedBlueprint ? <><p className="eyebrow">空间设定</p><h3>{nameFor(selectedBlueprint)}</h3><span>蓝图需求 {selected.areaSqm} m² · 当前占地 {selected.allocatedAreaSqm} m²</span><label>在旅程中的角色<select value={selected.journeyRole} onChange={(event) => updatePlacements((items) => items.map((item) => item.id === selected.id ? { ...item, journeyRole: event.target.value as FloorPlacement["journeyRole"] } : item))}>{Object.entries(roleLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><p className="inspector-hint">这个标签将用于后续模拟客流、噪音和满意度。</p><div><button type="button" className="remove-space" onClick={() => { updatePlacements((items) => items.filter((item) => item.id !== selected.id)); setSelectedId(undefined); }}>移出楼层</button></div></> : <div className="inspector-empty"><span>◇</span><h3>{armedBlueprint ? "在地图上圈地" : "选择一个空间"}</h3><p>{armedBlueprint ? `为「${nameFor(armedBlueprint)}」圈出至少 ${armedBlueprint.areaSqm}㎡ 的区域。` : "点击左侧蓝图后，在空白地图中自由画出空间轮廓。"}</p></div>}</aside>
    </div>
  </section>;
}
