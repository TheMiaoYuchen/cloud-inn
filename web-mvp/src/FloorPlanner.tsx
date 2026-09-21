import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { bedTypes, roomTypes, zoneChoices } from "./catalog";
import { loadFloorPlan, saveFloorPlan } from "./storage";
import type { Blueprint, FloorPlacement, FloorPlan, FloorPoint } from "./types";

const FLOOR_AREA = 1200;
const GRID_COLUMNS = 30;
const GRID_ROWS = 20;
const CELL_AREA = FLOOR_AREA / (GRID_COLUMNS * GRID_ROWS);
const roleLabels = { arrival: "抵达", stay: "停留", restore: "恢复", gather: "聚集" } as const;
type DrawingTool = "rectangle" | "freehand";
type LegacyPlacement = Partial<FloorPlacement> & { shape?: FloorPoint[]; x?: number; y?: number; width?: number; height?: number };

function nameFor(blueprint: Blueprint) {
  if (blueprint.designKind === "zone") return blueprint.name || zoneChoices.find((item) => item.id === blueprint.zoneTypeId)?.name || "功能区域";
  return blueprint.name || roomTypes.find((item) => item.id === blueprint.roomTypeId)?.name || "客房";
}

function clampPoint(point: FloorPoint): FloorPoint { return { x: Math.max(0, Math.min(GRID_COLUMNS, point.x)), y: Math.max(0, Math.min(GRID_ROWS, point.y)) }; }
function polygonArea(points: FloorPoint[]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}
function pointInPolygon(point: FloorPoint, polygon: FloorPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]; const before = polygon[previous];
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
function areaForShapes(shapes: FloorPoint[][]) {
  const cells = new Set<string>();
  shapes.forEach((shape) => coveredCells(shape).forEach((cell) => cells.add(cell)));
  return cells.size * CELL_AREA;
}
function overlaps(shape: FloorPoint[], placements: FloorPlacement[]) {
  const cells = coveredCells(shape);
  return placements.some((placement) => placement.shapes.some((placedShape) => [...coveredCells(placedShape)].some((cell) => cells.has(cell))));
}
function simplify(points: FloorPoint[]) { return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y); }
function rectangleFrom(start: FloorPoint, end: FloorPoint): FloorPoint[] {
  const left = Math.min(start.x, end.x); const right = Math.max(start.x, end.x); const top = Math.min(start.y, end.y); const bottom = Math.max(start.y, end.y);
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}
function pointsAttribute(points: FloorPoint[]) { return points.map((point) => `${point.x},${point.y}`).join(" "); }
function labelPoint(shapes: FloorPoint[][]) {
  const points = shapes.flat();
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}
function normaliseFloorPlan(plan: FloorPlan): FloorPlan {
  return {
    ...plan,
    placements: (plan.placements as LegacyPlacement[]).flatMap((placement) => {
      const shapes = Array.isArray(placement.shapes) && placement.shapes.length
        ? placement.shapes.filter((shape) => Array.isArray(shape) && shape.length >= 3).map((shape) => shape.map(clampPoint))
        : Array.isArray(placement.shape) && placement.shape.length >= 3
          ? [placement.shape.map(clampPoint)]
          : (() => { const x = placement.x ?? 0; const y = placement.y ?? 0; const width = placement.width ?? 1; const height = placement.height ?? 1; return [rectangleFrom({ x, y }, { x: x + width, y: y + height }).map(clampPoint)]; })();
      if (!placement.id || !placement.blueprintId || !shapes.some((shape) => polygonArea(shape) > 0)) return [];
      return [{ id: placement.id, blueprintId: placement.blueprintId, shapes, areaSqm: placement.areaSqm ?? areaForShapes(shapes), allocatedAreaSqm: placement.allocatedAreaSqm ?? areaForShapes(shapes), journeyRole: placement.journeyRole ?? "stay" }];
    }),
  };
}
function pointFromEvent(event: PointerEvent<HTMLDivElement>, board: HTMLDivElement) {
  const bounds = board.getBoundingClientRect();
  return clampPoint({ x: Math.round(((event.clientX - bounds.left) / bounds.width) * GRID_COLUMNS), y: Math.round(((event.clientY - bounds.top) / bounds.height) * GRID_ROWS) });
}

type FloorPlannerProps = { blueprints: Blueprint[]; onOpenBlueprint: (blueprint: Blueprint) => void };

export function FloorPlanner({ blueprints, onOpenBlueprint }: FloorPlannerProps) {
  const [floorPlan, setFloorPlan] = useState<FloorPlan>({ id: "floor-01", placements: [], updatedAt: new Date().toISOString() });
  const [ready, setReady] = useState(false);
  const [armedBlueprintId, setArmedBlueprintId] = useState<string>();
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("rectangle");
  const [draftShapes, setDraftShapes] = useState<FloorPoint[][]>([]);
  const [drawing, setDrawing] = useState<FloorPoint[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState("先在左侧选择一个蓝图，再用矩形或自由绘制工具圈地。每格约 2㎡。");
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadFloorPlan().then((stored) => { if (stored) setFloorPlan(normaliseFloorPlan(stored)); setReady(true); }).catch(() => { setNotice("楼层平面暂时无法保存。"); setReady(true); }); }, []);
  useEffect(() => { if (!ready) return; const timer = window.setTimeout(() => { void saveFloorPlan(floorPlan).catch(() => setNotice("保存楼层平面失败。")); }, 350); return () => window.clearTimeout(timer); }, [floorPlan, ready]);

  const usedArea = useMemo(() => floorPlan.placements.reduce((sum, placement) => sum + placement.allocatedAreaSqm, 0), [floorPlan.placements]);
  const armedBlueprint = blueprints.find((blueprint) => blueprint.id === armedBlueprintId);
  const selected = floorPlan.placements.find((placement) => placement.id === selectedId);
  const selectedBlueprint = blueprints.find((blueprint) => blueprint.id === selected?.blueprintId);
  const activeShape = drawing && (drawingTool === "rectangle" ? rectangleFrom(drawing[0], drawing[drawing.length - 1]) : simplify(drawing));
  const draftArea = areaForShapes(draftShapes);
  const previewArea = activeShape && activeShape.length >= 3 ? areaForShapes([...draftShapes, activeShape]) : draftArea;
  const previewOverlap = Boolean(activeShape && activeShape.length >= 3 && overlaps(activeShape, floorPlan.placements));
  const canDeploy = Boolean(armedBlueprint && draftShapes.length && draftArea >= armedBlueprint.areaSqm && usedArea + draftArea <= FLOOR_AREA && !draftShapes.some((shape) => overlaps(shape, floorPlan.placements)));

  function updatePlacements(update: (placements: FloorPlacement[]) => FloorPlacement[]) { setFloorPlan((current) => ({ ...current, placements: update(current.placements), updatedAt: new Date().toISOString() })); }
  function armBlueprint(blueprint: Blueprint) {
    setArmedBlueprintId(blueprint.id); setSelectedId(undefined); setDraftShapes([]); setDrawing(undefined);
    setNotice(`已选择「${nameFor(blueprint)}」：需要至少 ${blueprint.areaSqm}㎡。先画第一个区域，不足时可继续叠加。`);
  }
  function cancelDraft() { setArmedBlueprintId(undefined); setDraftShapes([]); setDrawing(undefined); setNotice("已取消本次圈地。"); }
  function undoDraftShape() {
    setDraftShapes((current) => current.slice(0, -1));
    setNotice("已撤回最后一块区域，可重新绘制。 ");
  }
  function startDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!armedBlueprint || !boardRef.current || event.button !== 0 || (event.target as Element).closest(".floor-shape")) return;
    event.currentTarget.setPointerCapture(event.pointerId); setDrawing([pointFromEvent(event, boardRef.current)]);
  }
  function continueDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || !boardRef.current) return;
    const point = pointFromEvent(event, boardRef.current);
    setDrawing((current) => current ? drawingTool === "rectangle" ? [current[0], point] : simplify([...current, point]) : current);
  }
  function finishDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || !armedBlueprint || !boardRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const raw = drawingTool === "rectangle" ? rectangleFrom(drawing[0], pointFromEvent(event, boardRef.current)) : simplify([...drawing, pointFromEvent(event, boardRef.current)]);
    if (raw.length < 3 || polygonArea(raw) === 0 || areaForShapes([raw]) === 0) { setNotice("请画出至少覆盖一个网格的区域。"); setDrawing(undefined); return; }
    if (overlaps(raw, floorPlan.placements)) { setNotice("这块区域与已部署空间重叠，请换一块空白区域。"); setDrawing(undefined); return; }
    const nextShapes = [...draftShapes, raw]; const nextArea = areaForShapes(nextShapes);
    if (usedArea + nextArea > FLOOR_AREA) { setNotice("加入这块区域会超过 1200㎡ 楼层上限。"); setDrawing(undefined); return; }
    setDraftShapes(nextShapes); setDrawing(undefined);
    setNotice(nextArea >= armedBlueprint.areaSqm ? `已圈定 ${nextArea}㎡，已满足「${nameFor(armedBlueprint)}」的面积要求；可继续叠加，或确认部署。` : `已圈定 ${nextArea}㎡，距离 ${armedBlueprint.areaSqm}㎡ 还差 ${armedBlueprint.areaSqm - nextArea}㎡。继续画一个区域叠加即可。`);
  }
  function deployDraft() {
    if (!armedBlueprint || !canDeploy) return;
    const placement: FloorPlacement = { id: crypto.randomUUID(), blueprintId: armedBlueprint.id, shapes: draftShapes, areaSqm: armedBlueprint.areaSqm, allocatedAreaSqm: draftArea, journeyRole: armedBlueprint.designKind === "zone" ? "gather" : "stay" };
    updatePlacements((items) => [...items, placement]); setSelectedId(placement.id); setArmedBlueprintId(undefined); setDraftShapes([]); setNotice(`已部署「${nameFor(armedBlueprint)}」，占用 ${draftArea}㎡。`);
  }

  return <section className="floor-workspace" aria-label="楼层平面图">
    <div className="floor-heading"><div><p className="eyebrow">1200㎡ 酒店楼层</p><h2>楼层平面图</h2><p>选择一个已设计空间，用直边矩形或自由轮廓在空白地图上圈地。可叠加多个区域，组合成不规则的空间边界。</p></div><div className="floor-meter"><strong>{usedArea}</strong><span>/ {FLOOR_AREA} m² 已规划</span><i><b style={{ width: `${Math.min(100, usedArea / FLOOR_AREA * 100)}%` }} /></i></div></div>
    <div className="floor-layout">
      <aside className="floor-library"><div className="floor-library-heading"><strong>待部署空间</strong><span>{blueprints.length} 张蓝图</span></div>{blueprints.length ? blueprints.map((blueprint) => <button type="button" className={`floor-source ${armedBlueprintId === blueprint.id ? "armed" : ""}`} key={blueprint.id} onClick={() => armBlueprint(blueprint)} onDoubleClick={() => onOpenBlueprint(blueprint)}><img src={blueprint.imageDataUrl} alt="" /><div><strong>{nameFor(blueprint)}</strong><span>{blueprint.areaSqm} m² · {blueprint.designKind === "zone" ? "功能区域" : bedTypes.find((item) => item.id === blueprint.bedTypeId)?.name}</span></div><b>{armedBlueprintId === blueprint.id ? "圈地中" : "选择"}</b></button>) : <p className="floor-empty">蓝图库还没有可部署的空间。先完成一张客房或功能区域设计并保存。</p>}</aside>
      <div className="floor-board-wrap"><div className="floor-tools" aria-label="圈地工具"><span>圈地工具</span><button type="button" className={drawingTool === "rectangle" ? "selected" : ""} onClick={() => setDrawingTool("rectangle")}>矩形</button><button type="button" className={drawingTool === "freehand" ? "selected" : ""} onClick={() => setDrawingTool("freehand")}>自由轮廓</button>{armedBlueprint && <><em>{draftShapes.length ? `${draftShapes.length} 块 · ${draftArea}㎡` : "尚未圈地"}</em><button type="button" className="floor-cancel" disabled={!draftShapes.length} onClick={undoDraftShape}>撤回一块</button><button type="button" className="floor-cancel" onClick={cancelDraft}>取消</button><button type="button" className="floor-deploy" disabled={!canDeploy} onClick={deployDraft}>确认部署</button></>}</div><div ref={boardRef} className={`floor-board ${armedBlueprint ? "drawing-enabled" : ""}`} onPointerDown={startDrawing} onPointerMove={continueDrawing} onPointerUp={finishDrawing} onPointerCancel={() => setDrawing(undefined)} onClick={() => !drawing && setSelectedId(undefined)}><span className="floor-entrance">入口</span><svg className="floor-shapes" viewBox={`0 0 ${GRID_COLUMNS} ${GRID_ROWS}`} preserveAspectRatio="none" aria-label="已部署空间">{floorPlan.placements.map((placement) => { const blueprint = blueprints.find((item) => item.id === placement.blueprintId); if (!blueprint) return null; const label = labelPoint(placement.shapes); return <g key={placement.id} className={`floor-shape ${blueprint.designKind} ${selectedId === placement.id ? "selected" : ""}`} onPointerDown={(event) => { event.stopPropagation(); setSelectedId(placement.id); }} onClick={(event) => event.stopPropagation()}>{placement.shapes.map((shape, index) => <polygon key={index} points={pointsAttribute(shape)} />)}<text x={label.x} y={label.y - .35}>{nameFor(blueprint)}</text><text className="floor-shape-meta" x={label.x} y={label.y + .45}>{placement.allocatedAreaSqm}m² · {roleLabels[placement.journeyRole]}</text></g>; })}{draftShapes.map((shape, index) => <polygon className="floor-draft" key={`draft-${index}`} points={pointsAttribute(shape)} />)}{activeShape && activeShape.length >= 3 && <polygon className={`floor-drawing ${previewOverlap || previewArea > FLOOR_AREA - usedArea ? "invalid" : ""}`} points={pointsAttribute(activeShape)} />}</svg></div><p className="floor-notice" role="status">{drawing && armedBlueprint ? `正在圈地：组合后 ${previewArea}㎡ / 至少 ${armedBlueprint.areaSqm}㎡` : notice}</p></div>
      <aside className="floor-inspector">{selected && selectedBlueprint ? <><p className="eyebrow">空间设定</p><h3>{nameFor(selectedBlueprint)}</h3><span>蓝图需求 {selected.areaSqm} m² · 当前占地 {selected.allocatedAreaSqm} m²</span><label>在旅程中的角色<select value={selected.journeyRole} onChange={(event) => updatePlacements((items) => items.map((item) => item.id === selected.id ? { ...item, journeyRole: event.target.value as FloorPlacement["journeyRole"] } : item))}>{Object.entries(roleLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><p className="inspector-hint">这个标签将用于后续模拟客流、噪音和满意度。</p><div><button type="button" className="remove-space" onClick={() => { updatePlacements((items) => items.filter((item) => item.id !== selected.id)); setSelectedId(undefined); }}>移出楼层</button></div></> : <div className="inspector-empty"><span>◇</span><h3>{armedBlueprint ? "叠加圈地中" : "选择一个空间"}</h3><p>{armedBlueprint ? `为「${nameFor(armedBlueprint)}」圈出至少 ${armedBlueprint.areaSqm}㎡。不足时继续画矩形或自由轮廓，达到要求后点击“确认部署”。` : "点击左侧蓝图后，使用矩形或自由轮廓在地图上绘制空间。"}</p></div>}</aside>
    </div>
  </section>;
}
